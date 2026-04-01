/**
 * businesslog-ai Cloudflare Worker
 *
 * Hono-based worker handling all API routes for the Businesslog AI platform.
 * Provides chat, file management, auth, team management, and analytics.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

// ---------------------------------------------------------------------------
// Type bindings
// ---------------------------------------------------------------------------

interface Env {
  MEMORY: KVNamespace;
  ANALYTICS_KV: KVNamespace;
  DB: D1Database;
  DEEPSEEK_API_KEY: string;
  JWT_SECRET: string;
  ADMIN_EMAIL: string;
}

interface JwtPayload {
  sub: string;   // user id
  email: string;
  role: string;
  iat: number;
  exp: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers — Crypto
// ---------------------------------------------------------------------------

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const candidate = await hashPassword(password);
  return candidate === hash;
}

// ---------------------------------------------------------------------------
// Helpers — JWT (HMAC-SHA256)
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function textToBase64(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { ...payload, iat: now, exp: now + 7 * 24 * 60 * 60 };

  const header = textToBase64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = textToBase64(JSON.stringify(fullPayload));
  const message = `${header}.${body}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));

  return `${message}.${arrayBufferToBase64(signature)}`;
}

async function verifyToken(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

  const sigBuffer = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBuffer, encoder.encode(`${header}.${body}`));
  if (!valid) return null;

  try {
    const payload: JwtPayload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers — Analytics
// ---------------------------------------------------------------------------

async function recordAnalytics(kv: KVNamespace, event: string, userId: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  // Increment daily event counter
  const dailyKey = `events:${today}:${event}`;
  const current = parseInt((await kv.get(dailyKey)) || '0', 10);
  await kv.put(dailyKey, String(current + 1));

  // Track active user
  const userKey = `active:${today}:${userId}`;
  await kv.put(userKey, '1', { expirationTtl: 7 * 24 * 60 * 60 });
}

// ---------------------------------------------------------------------------
// Helpers — D1 initialization
// ---------------------------------------------------------------------------

async function ensureUsersTable(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      name       TEXT NOT NULL,
      role       TEXT DEFAULT 'member',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ---------------------------------------------------------------------------
// Helpers — DeepSeek streaming
// ---------------------------------------------------------------------------

async function* streamDeepSeek(messages: ChatMessage[], apiKey: string): AsyncGenerator<string> {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    yield `[ERROR] DeepSeek API returned ${response.status}: ${errorText}`;
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const parsed = JSON.parse(trimmed.slice(6));
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Skip malformed SSE lines
      }
    }
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function getSystemPrompt(): string {
  return `You are the Businesslog AI assistant — a professional, knowledgeable business advisor. Your role:

1. **Business Intelligence** — Help users analyze data, generate reports, and identify trends.
2. **Decision Support** — Provide structured recommendations with pros/cons when facing business decisions.
3. **Financial Analysis** — Assist with budgeting, forecasting, and financial modeling concepts.
4. **Process Optimization** — Suggest workflow improvements and operational efficiencies.
5. **Communication** — Draft professional emails, proposals, and business documents.
6. **Strategy** — Discuss market positioning, growth strategies, and competitive analysis.

Guidelines:
- Be concise and actionable. Prefer structured responses with clear headings or bullet points.
- When uncertain, ask clarifying questions rather than guessing.
- Never fabricate financial data or legal advice. Recommend consulting professionals when appropriate.
- Maintain a professional but approachable tone.
- Support your suggestions with reasoning, not just conclusions.
- Respect confidentiality — do not store or repeat sensitive business information across conversations.`;
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Track worker start time for uptime calculation
const startTime = Date.now();

// ---------------------------------------------------------------------------
// Middleware — Error handling
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, err.stack);
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

// ---------------------------------------------------------------------------
// Middleware — Analytics
// ---------------------------------------------------------------------------

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  const event = `${c.req.method}:${path}`;
  const userId = 'anonymous';

  await next();

  // Record after response so we don't block the handler
  c.executionCtx.waitUntil(recordAnalytics(c.env.ANALYTICS_KV, event, userId));
});

// ---------------------------------------------------------------------------
// Middleware — Auth
// ---------------------------------------------------------------------------

const authMiddleware = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  c.set('user', payload);
  await next();
};

const roleMiddleware = (roles: string[]) => async (c: any, next: any) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  if (!roles.includes(user.role)) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }
  await next();
};

// ---------------------------------------------------------------------------
// Static file routes
// ---------------------------------------------------------------------------

app.get('/', async (c) => {
  return c.html(await c.env.MEMORY.get('public:index.html', 'text') || '<h1>Businesslog AI</h1>');
});

app.get('/app', async (c) => {
  return c.html(await c.env.MEMORY.get('public:app.html', 'text') || '<h1>App</h1>');
});

app.get('/css/style.css', async (c) => {
  const css = await c.env.MEMORY.get('public:css/style.css', 'text');
  if (!css) return c.text('', 404);
  return c.text(css, 200, { 'Content-Type': 'text/css' });
});

app.get('/js/app.js', async (c) => {
  const js = await c.env.MEMORY.get('public:js/app.js', 'text');
  if (!js) return c.text('', 404);
  return c.text(js, 200, { 'Content-Type': 'application/javascript' });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/api/health', (c) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  return c.json({ status: 'ok', version: '1.0.0', uptime });
});

// ---------------------------------------------------------------------------
// Auth — Register
// ---------------------------------------------------------------------------

app.post('/api/auth/register', async (c) => {
  await ensureUsersTable(c.env.DB);

  const body = await c.req.json<{ email: string; password: string; name: string }>();
  const { email, password, name } = body;

  if (!email || !password || !name) {
    return c.json({ error: 'email, password, and name are required' }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }

  // Check if email is taken
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    return c.json({ error: 'Email already registered' }, 409);
  }

  const id = crypto.randomUUID();
  const hashed = await hashPassword(password);

  // Determine role — first user or ADMIN_EMAIL match gets admin
  const userCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>();
  const isFirst = (userCount?.count ?? 0) === 0;
  const role = isFirst || email === c.env.ADMIN_EMAIL ? 'admin' : 'member';

  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password, name, role) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, email, hashed, name, role).run();

  const token = await signToken({ sub: id, email, role }, c.env.JWT_SECRET);

  return c.json({
    token,
    user: { id, email, name, role },
  }, 201);
});

// ---------------------------------------------------------------------------
// Auth — Login
// ---------------------------------------------------------------------------

app.post('/api/auth/login', async (c) => {
  await ensureUsersTable(c.env.DB);

  const body = await c.req.json<{ email: string; password: string }>();
  const { email, password } = body;

  if (!email || !password) {
    return c.json({ error: 'email and password are required' }, 400);
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, password, name, role FROM users WHERE email = ?'
  ).bind(email).first<{ id: string; email: string; password: string; name: string; role: string }>();

  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await verifyPassword(password, user.password);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = await signToken({ sub: user.id, email: user.email, role: user.role }, c.env.JWT_SECRET);

  return c.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// ---------------------------------------------------------------------------
// Auth — Get current user
// ---------------------------------------------------------------------------

app.get('/api/auth/me', authMiddleware, async (c) => {
  const payload = c.get('user') as JwtPayload;

  await ensureUsersTable(c.env.DB);
  const user = await c.env.DB.prepare(
    'SELECT id, email, name, role, created_at FROM users WHERE id = ?'
  ).bind(payload.sub).first<{ id: string; email: string; name: string; role: string; created_at: string }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.created_at,
  });
});

// ---------------------------------------------------------------------------
// Chat — Guest mode (no auth, rate-limited)
// ---------------------------------------------------------------------------

const GUEST_LIMIT = 3; // Free messages before requiring registration

app.post('/api/chat/guest', async (c) => {
  // Track guest usage via IP + KV
  const clientKey = `guest:${c.req.header('cf-connecting-ip') || 'unknown'}`;
  const usageRaw = await c.env.MEMORY.get(clientKey, 'text');
  const usage = usageRaw ? JSON.parse(usageRaw) : { count: 0 };

  if (usage.count >= GUEST_LIMIT) {
    return c.json({ error: 'Guest limit reached. Please register for unlimited access.', limit: GUEST_LIMIT, remaining: 0 }, 429);
  }

  const body = await c.req.json<{ message: string }>();
  const { message } = body;

  if (!message?.trim()) {
    return c.json({ error: 'message is required' }, 400);
  }

  // Increment usage
  usage.count++;
  await c.env.MEMORY.put(clientKey, JSON.stringify(usage), { expirationTtl: 24 * 60 * 60 });

  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt() },
    { role: 'user', content: message },
  ];

  c.executionCtx.waitUntil(recordAnalytics(c.env.ANALYTICS_KV, 'chat:guest', 'guest'));

  return streamSSE(c, async (stream) => {
    for await (const chunk of streamDeepSeek(messages, c.env.DEEPSEEK_API_KEY)) {
      await stream.writeSSE({ data: JSON.stringify({ text: chunk }) });
    }
    await stream.writeSSE({ event: 'done', data: JSON.stringify({ remaining: GUEST_LIMIT - usage.count }) });
  });
});

// ---------------------------------------------------------------------------
// Chat — Streaming SSE
// ---------------------------------------------------------------------------

app.post('/api/chat', authMiddleware, async (c) => {
  const body = await c.req.json<{ message: string; conversationId?: string; channel?: string }>();
  const { message, conversationId, channel } = body;

  if (!message?.trim()) {
    return c.json({ error: 'message is required' }, 400);
  }

  const user = c.get('user') as JwtPayload;
  const convId = conversationId || crypto.randomUUID();
  const memoryKey = `conversation:${user.sub}:${convId}`;

  // Load conversation history
  const historyRaw = await c.env.MEMORY.get(memoryKey, 'text');
  const history: ChatMessage[] = historyRaw ? JSON.parse(historyRaw) : [];

  // Build message list for the API
  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt() },
    ...history,
    { role: 'user', content: message },
  ];

  // Record analytics
  c.executionCtx.waitUntil(recordAnalytics(c.env.ANALYTICS_KV, 'chat:message', user.sub));

  // Stream the response
  return streamSSE(c, async (stream) => {
    let fullResponse = '';

    for await (const chunk of streamDeepSeek(messages, c.env.DEEPSEEK_API_KEY)) {
      fullResponse += chunk;
      await stream.writeSSE({ data: JSON.stringify({ text: chunk, conversationId: convId }) });
    }

    // Store updated history in KV
    const updatedHistory: ChatMessage[] = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: fullResponse },
    ];
    c.executionCtx.waitUntil(
      c.env.MEMORY.put(memoryKey, JSON.stringify(updatedHistory), { expirationTtl: 30 * 24 * 60 * 60 })
    );

    // Send done event
    await stream.writeSSE({ event: 'done', data: JSON.stringify({ conversationId: convId }) });
  });
});

// ---------------------------------------------------------------------------
// Files — Upload
// ---------------------------------------------------------------------------

app.post('/api/files', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const filename = file.name;
  const key = `file:${user.sub}:${filename}`;
  const arrayBuffer = await file.arrayBuffer();

  await c.env.MEMORY.put(key, arrayBuffer);

  // Store metadata separately
  const metaKey = `file-meta:${user.sub}:${filename}`;
  const metadata = {
    id: filename,
    filename,
    size: file.size,
    type: file.type,
    uploadedBy: user.sub,
    uploadedAt: new Date().toISOString(),
  };
  await c.env.MEMORY.put(metaKey, JSON.stringify(metadata));

  c.executionCtx.waitUntil(recordAnalytics(c.env.ANALYTICS_KV, 'file:upload', user.sub));

  return c.json({
    url: `/api/files/${encodeURIComponent(filename)}/content`,
    filename,
    size: file.size,
  }, 201);
});

// ---------------------------------------------------------------------------
// Files — Get metadata
// ---------------------------------------------------------------------------

app.get('/api/files/:id', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const fileId = c.req.param('id');
  const metaKey = `file-meta:${user.sub}:${fileId}`;

  const raw = await c.env.MEMORY.get(metaKey, 'text');
  if (!raw) {
    return c.json({ error: 'File not found' }, 404);
  }

  return c.json(JSON.parse(raw));
});

// ---------------------------------------------------------------------------
// Files — Download content
// ---------------------------------------------------------------------------

app.get('/api/files/:id/content', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const fileId = c.req.param('id');
  const key = `file:${user.sub}:${fileId}`;

  const value = await c.env.MEMORY.get(key, 'arrayBuffer');
  if (!value) {
    return c.json({ error: 'File not found' }, 404);
  }

  // Look up metadata for content-type
  const metaKey = `file-meta:${user.sub}:${fileId}`;
  const metaRaw = await c.env.MEMORY.get(metaKey, 'text');
  const meta = metaRaw ? JSON.parse(metaRaw) : null;

  return new Response(value, {
    headers: {
      'Content-Type': meta?.type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileId}"`,
    },
  });
});

// ---------------------------------------------------------------------------
// Users — List team members (admin only)
// ---------------------------------------------------------------------------

app.get('/api/users', authMiddleware, roleMiddleware(['admin']), async (c) => {
  await ensureUsersTable(c.env.DB);

  const results = await c.env.DB.prepare(
    'SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC'
  ).all();

  return c.json(results.results);
});

// ---------------------------------------------------------------------------
// Users — Change role (admin only)
// ---------------------------------------------------------------------------

app.put('/api/users/:id/role', authMiddleware, roleMiddleware(['admin']), async (c) => {
  await ensureUsersTable(c.env.DB);

  const targetId = c.req.param('id');
  const body = await c.req.json<{ role: 'admin' | 'member' | 'viewer' }>();
  const { role } = body;

  if (!['admin', 'member', 'viewer'].includes(role)) {
    return c.json({ error: 'Invalid role. Must be admin, member, or viewer.' }, 400);
  }

  // Check target user exists
  const target = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(targetId).first<{ id: string; role: string }>();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Prevent demoting the last admin
  if (target.role === 'admin' && role !== 'admin') {
    const adminCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM users WHERE role = 'admin'"
    ).first<{ count: number }>();

    if ((adminCount?.count ?? 0) <= 1) {
      return c.json({ error: 'Cannot remove the last admin' }, 400);
    }
  }

  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, targetId).run();

  return c.json({ id: targetId, role });
});

// ---------------------------------------------------------------------------
// Users — Remove user (admin only)
// ---------------------------------------------------------------------------

app.delete('/api/users/:id', authMiddleware, roleMiddleware(['admin']), async (c) => {
  await ensureUsersTable(c.env.DB);

  const targetId = c.req.param('id');
  const currentUser = c.get('user') as JwtPayload;

  if (targetId === currentUser.sub) {
    return c.json({ error: 'Cannot remove yourself' }, 400);
  }

  // Check target exists
  const target = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(targetId).first<{ id: string; role: string }>();
  if (!target) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Prevent removing an admin if they are the last one
  if (target.role === 'admin') {
    const adminCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM users WHERE role = 'admin'"
    ).first<{ count: number }>();

    if ((adminCount?.count ?? 0) <= 1) {
      return c.json({ error: 'Cannot remove the last admin' }, 400);
    }
  }

  // Delete user from DB
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();

  // Clean up user data in KV (best-effort, fire-and-forget)
  c.executionCtx.waitUntil(
    (async () => {
      const list = await c.env.MEMORY.list({ prefix: `conversation:${targetId}:` });
      for (const key of list.keys) {
        await c.env.MEMORY.delete(key.name);
      }
      const fileList = await c.env.MEMORY.list({ prefix: `file:${targetId}:` });
      for (const key of fileList.keys) {
        await c.env.MEMORY.delete(key.name);
      }
      const metaList = await c.env.MEMORY.list({ prefix: `file-meta:${targetId}:` });
      for (const key of metaList.keys) {
        await c.env.MEMORY.delete(key.name);
      }
    })()
  );

  return c.json({ success: true, id: targetId });
});

// ---------------------------------------------------------------------------
// Analytics — Dashboard
// ---------------------------------------------------------------------------

app.get('/api/analytics/dashboard', authMiddleware, roleMiddleware(['admin', 'member']), async (c) => {
  const kv = c.env.ANALYTICS_KV;
  const today = new Date();
  const days: string[] = [];

  // Collect last 30 days
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }

  // Gather messages per day
  const messagesPerDay: { date: string; count: number }[] = [];
  let totalMessages = 0;

  for (const day of days) {
    const key = `events:${day}:chat:message`;
    const val = parseInt((await kv.get(key)) || '0', 10);
    messagesPerDay.push({ date: day, count: val });
    totalMessages += val;
  }

  // Count active users today
  const todayStr = days[days.length - 1];
  const activeList = await kv.list({ prefix: `active:${todayStr}:` });
  const activeUsers = activeList.keys.length;

  // Count total users from D1
  await ensureUsersTable(c.env.DB);
  const userResult = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>();
  const totalUsers = userResult?.count ?? 0;

  // Top topics — placeholder derived from recent chat keys
  const topTopics = [
    { topic: 'Financial Analysis', count: 0 },
    { topic: 'Strategy', count: 0 },
    { topic: 'Process Optimization', count: 0 },
  ];

  // Estimate average response time (static placeholder, real impl would track timing)
  const avgResponseTime = 1.2;

  return c.json({
    messagesPerDay,
    activeUsers,
    topTopics,
    totalMessages,
    totalUsers,
    avgResponseTime,
  });
});

// ---------------------------------------------------------------------------
// Analytics — Report
// ---------------------------------------------------------------------------

app.get('/api/analytics/report', authMiddleware, roleMiddleware(['admin', 'member']), async (c) => {
  const type = c.req.query('type') || 'daily';
  const format = c.req.query('format') || 'json';
  const kv = c.env.ANALYTICS_KV;

  const validTypes = ['daily', 'weekly', 'monthly'];
  if (!validTypes.includes(type)) {
    return c.json({ error: 'Invalid type. Use daily, weekly, or monthly.' }, 400);
  }

  // Determine how many days to aggregate
  const dayCount = type === 'daily' ? 1 : type === 'weekly' ? 7 : 30;
  const today = new Date();
  const days: string[] = [];

  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }

  // Aggregate data
  const aggregated: { date: string; messages: number; uploads: number }[] = [];

  for (const day of days) {
    const msgKey = `events:${day}:chat:message`;
    const fileKey = `events:${day}:file:upload`;
    const messages = parseInt((await kv.get(msgKey)) || '0', 10);
    const uploads = parseInt((await kv.get(fileKey)) || '0', 10);
    aggregated.push({ date: day, messages, uploads });
  }

  const totalMessages = aggregated.reduce((sum, d) => sum + d.messages, 0);
  const totalUploads = aggregated.reduce((sum, d) => sum + d.uploads, 0);

  const reportData = {
    type,
    period: { from: days[0], to: days[days.length - 1] },
    summary: { totalMessages, totalUploads, daysCovered: days.length },
    dailyBreakdown: aggregated,
  };

  if (format === 'csv') {
    const header = 'date,messages,uploads';
    const rows = aggregated.map((r) => `${r.date},${r.messages},${r.uploads}`).join('\n');
    return c.text(`${header}\n${rows}`, 200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="report-${type}-${days[0]}.csv"`,
    });
  }

  return c.json(reportData);
});

// ---------------------------------------------------------------------------
// Export — Data export (JSON / CSV / Audit log)
// ---------------------------------------------------------------------------

app.get('/api/export', authMiddleware, roleMiddleware(['admin']), async (c) => {
  await ensureUsersTable(c.env.DB);

  const format = c.req.query('format') || 'json';

  // Gather all exportable data
  const users = await c.env.DB.prepare(
    'SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC'
  ).all();

  // Gather conversations from KV (admin sees all)
  const convList = await c.env.MEMORY.list({ prefix: 'conversation:' });
  const conversations: { id: string; userId: string; messages: number; lastActivity?: string }[] = [];
  for (const key of convList.keys) {
    const parts = key.name.split(':');
    const userId = parts[1] || 'unknown';
    const convId = parts[2] || 'unknown';
    const raw = await c.env.MEMORY.get(key.name, 'text');
    const msgs: ChatMessage[] = raw ? JSON.parse(raw) : [];
    conversations.push({
      id: convId,
      userId,
      messages: msgs.length,
      lastActivity: key.metadata as string | undefined,
    });
  }

  // Gather analytics summary
  const today = new Date();
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }

  const analyticsDaily: { date: string; messages: number; uploads: number }[] = [];
  let totalMessages = 0;
  let totalUploads = 0;
  for (const day of days) {
    const msgKey = `events:${day}:chat:message`;
    const fileKey = `events:${day}:file:upload`;
    const messages = parseInt((await c.env.ANALYTICS_KV.get(msgKey)) || '0', 10);
    const uploads = parseInt((await c.env.ANALYTICS_KV.get(fileKey)) || '0', 10);
    analyticsDaily.push({ date: day, messages, uploads });
    totalMessages += messages;
    totalUploads += uploads;
  }

  const settings = {
    dataRetentionPolicy: '30 days (configurable)',
    exportTimestamp: new Date().toISOString(),
    version: '1.0.0',
  };

  // Audit log entries
  const auditEntries: { type: string; text: string; time: string }[] = [];
  // Build audit log from analytics events
  for (const day of days.slice(-7)) {
    const activeList = await c.env.ANALYTICS_KV.list({ prefix: `active:${day}:` });
    for (const key of activeList.keys) {
      const userId = key.name.split(':').pop() || 'unknown';
      auditEntries.push({ type: 'info', text: `User <strong>${userId}</strong> was active`, time: day });
    }
  }

  if (format === 'csv') {
    // Export conversations as CSV
    const header = 'id,userId,messages,lastActivity';
    const rows = conversations.map(c => `"${c.id}","${c.userId}",${c.messages},"${c.lastActivity || ''}"`).join('\n');
    return c.text(header + '\n' + rows, 200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="businesslog-conversations.csv"',
    });
  }

  if (format === 'audit') {
    return c.json({ entries: auditEntries });
  }

  // Default: JSON export with everything
  return c.json({
    settings,
    users: users.results,
    conversations,
    analytics: {
      summary: { totalMessages, totalUploads, period: `${days[0]} to ${days[days.length - 1]}` },
      daily: analyticsDaily,
    },
    auditLog: auditEntries,
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
