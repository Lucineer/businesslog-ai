import { addNode, addEdge, traverse, crossDomainQuery, findPath, domainStats, getDomainNodes } from './lib/knowledge-graph.js';
import { loadSeedIntoKG, FLEET_REPOS, loadAllSeeds } from './lib/seed-loader.js';
import { evapPipeline, getEvapReport, getLockStats } from './lib/evaporation-pipeline.js';
import { selectModel } from './lib/model-router.js';
import { trackConfidence, getConfidence } from './lib/confidence-tracker.js';
import { softActualize, confidenceScore } from './lib/soft-actualize.js';
/**
 * businesslog-ai Cloudflare Worker
 *
 * Hono-based worker handling all API routes for the Businesslog AI platform.
 * Provides chat, file management, auth, team management, and analytics.
 */

import { Hono } from 'hono';
import { callLLM, generateSetupHTML } from './lib/byok.js';
import { evapPipeline } from './lib/evaporation-pipeline.js';

import { streamSSE } from 'hono/streaming';
import { deadbandCheck, deadbandStore, getEfficiencyStats } from './lib/deadband.js';
import { logResponse } from './lib/response-logger.js';

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

const CSP = "default-src 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.openai.com https://api.anthropic.com https://generativelanguage.googleapis.com https://api.deepseek.com https://api.groq.com https://api.mistral.ai https://openrouter.ai https://api.z.ai https://*;";

app.use('*', async (c, next) => {
  await next();
  if (c.res.headers.get('content-type')?.includes('text/html')) {
    c.res.headers.set('Content-Security-Policy', CSP);
  }
});

app.options('/*', (c) => new Response(null, {
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  }
}));

app.get('/setup', (c) => c.html(generateSetupHTML('businesslog-ai', '#059669')));

app.post('/api/chat/public', async (c) => {
  try {
    const body = await c.req.json();
    const apiKey = c.env?.OPENAI_API_KEY || c.env?.ANTHROPIC_API_KEY || c.env?.GEMINI_API_KEY;
    if (!apiKey) return c.json({ error: 'No API key configured. Visit /setup.' }, 503);
    const messages = [{ role: 'system', content: 'You are BusinessLog.ai, a business management assistant.' }, ...(body.messages || [{ role: 'user', content: body.message || '' }])];
    const userMessage = (body.messages || [{ role: 'user', content: body.message || '' }]).map((m) => m.content).join(' ');
    const result = await evapPipeline(c.env, userMessage, () => callLLM(apiKey, messages), 'businesslog-ai');
    return c.json({ success: true, response: result.response, source: result.source, tokensUsed: result.tokensUsed });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.get('/', async (c) => {
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BusinessLog.ai — Practice Your Pitch Against AI</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0a0a1a;color:#e0e0e0}.hero{background:linear-gradient(135deg,#3b82f611,#06b6d411,#0a0a1a);padding:5rem 2rem 3rem;text-align:center}.hero h1{font-size:3rem;background:linear-gradient(90deg,#3b82f6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:.5rem}.hero .tagline{color:#8b949e;font-size:1.1rem;max-width:550px;margin:0 auto 1.5rem}.fork-btns{display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap}.fork-btns a{padding:.5rem 1.2rem;background:rgba(59,130,246,.1);border:1px solid #3b82f633;border-radius:8px;color:#3b82f6;text-decoration:none;font-size:.85rem}.demo-section{max-width:850px;margin:0 auto 3rem;padding:0 1rem}.demo-label{color:#06b6d4;font-size:.8rem;text-transform:uppercase;letter-spacing:2px;margin-bottom:1rem;display:flex;align-items:center;gap:.5rem}.demo-label::before,.demo-label::after{content:'';flex:1;height:1px;background:#3b82f622}.chat{background:#111827;border:1px solid #1f2937;border-radius:12px;overflow:hidden;font-size:.9rem}.msg{padding:.8rem 1.2rem;border-bottom:1px solid #1f293733;display:flex;gap:.8rem}.msg:last-child{border-bottom:none}.msg.user{background:#0d1117}.msg.agent{background:#111827}.msg.system{background:#1f293722;padding:.5rem 1.2rem;text-align:center;font-size:.78rem;color:#6b7280}.avatar{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.75rem;flex-shrink:0}.msg.user .avatar{background:#3b82f6;color:#fff}.msg.agent .avatar{background:#06b6d4;color:#0a0a1a;font-weight:700}.msg-body{flex:1}.msg-name{font-size:.72rem;color:#4b5563;margin-bottom:.15rem;display:flex;align-items:center;gap:.5rem}.msg-text{color:#d1d5db;line-height:1.5}.msg-text .label{color:#06b6d4;font-size:.75rem;font-weight:600}.msg-text .prep{background:#1f2937;border-left:3px solid #3b82f6;padding:.5rem .8rem;border-radius:0 6px 6px 0;margin:.5rem 0;font-size:.82rem;color:#93c5fd}.msg-text .risk{background:#1f2937;border-left:3px solid #f59e0b;padding:.5rem .8rem;border-radius:0 6px 6px 0;margin:.5rem 0;font-size:.82rem;color:#fcd34d}.msg-text .task{background:#1f2937;border-left:3px solid #3b82f6;padding:.3rem .8rem;border-radius:0 6px 6px 0;margin:.3rem 0;font-size:.82rem;color:#93c5fd}.byok{max-width:600px;margin:0 auto 2rem;padding:0 1rem}.byok h3{color:#3b82f6;margin-bottom:.8rem;font-size:1rem}.byok-row{display:flex;gap:.5rem}.byok-row input{flex:1;padding:.6rem 1rem;background:#111827;border:1px solid #1f2937;border-radius:8px;color:#e0e0e0}.byok-row button{padding:.6rem 1.5rem;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer}.fork-bar{max-width:800px;margin:0 auto 3rem;padding:0 1rem;background:#111827;border:1px solid #1f2937;border-radius:12px;padding:1.5rem}.fork-bar h3{color:#06b6d4;margin-bottom:.8rem;font-size:1rem}.deploy-box{background:#0a0a1a;border:1px solid #1f2937;border-radius:8px;padding:1rem;position:relative}.deploy-box code{font-family:monospace;font-size:.78rem;color:#3b82f6;display:block;white-space:pre-wrap}.copy-btn{position:absolute;top:.5rem;right:.5rem;background:#1f2937;border:none;border-radius:4px;color:#3b82f6;padding:.2rem .5rem;font-size:.7rem;cursor:pointer}.footer{text-align:center;padding:2rem;color:#1f2937;font-size:.8rem;border-top:1px solid #1f293733}</style></head><body><div class="hero">
      <img src="https://cocapn-logos.casey-digennaro.workers.dev/img/cocapn-logo-v1.png" alt="Cocapn" style="width:64px;height:auto;margin-bottom:.5rem;border-radius:8px;display:block;margin-left:auto;margin-right:auto">
      <h1>BusinessLog.ai</h1><p class="tagline">Practice your pitch against AI — meeting simulations with CRM context.</p><div class="fork-btns"><a href="https://github.com/superinstance/businesslog-ai" target="_blank">⭐ Star</a><a href="https://github.com/superinstance/businesslog-ai/fork" target="_blank">🍴 Fork</a></div></div><div class="demo-section"><div class="demo-label">Live Demo — Client Meeting Simulation</div><div class="chat"><div class="msg system">📋 CRM Loaded: Acme Corp — CTO Sarah Chen, $120k ARR potential, current vendor: CompetitorX</div><div class="msg agent"><div class="avatar">🤖</div><div class="msg-body"><div class="msg-name">AI Coach</div><div class="msg-text"><span class="label">Meeting Prep</span><div class="prep"><strong>Sarah's priorities:</strong> Cutting costs, improving uptime (they had 3 outages last quarter). She's skeptical of new vendors — burned before by overpromises.<br><br><strong>Your angle:</strong> Lead with reliability metrics, not features. Mention your 99.97% SLA early.</div></div></div></div><div class="msg agent"><div class="avatar">🤖</div><div class="msg-body"><div class="msg-name">AI Coach</div><div class="msg-text"><span class="label">⚠️ Risk Assessment</span><div class="risk">• <strong>Price objection likely</strong> — CompetitorX undercuts by 15%<br>• <strong>Technical champion needed</strong> — Sarah is business-side<br>• <strong>Timeline pressure</strong> — Their renewal is in 6 weeks</div></div></div></div><div class="msg agent"><div class="avatar">SC</div><div class="msg-body"><div class="msg-name">Sarah Chen (AI roleplay)</div><div class="msg-text">Thanks for coming in. Look, I'll be honest — we're happy enough with CompetitorX. Why should I spend time evaluating something new?</div></div></div><div class="msg user"><div class="avatar">U</div><div class="msg-body"><div class="msg-name">You (salesperson)</div><div class="msg-text">I appreciate the honesty, Sarah. You mentioned the outages last quarter — how much did those cost your team in lost productivity?</div></div></div><div class="msg agent"><div class="avatar">SC</div><div class="msg-body"><div class="msg-name">Sarah Chen (AI roleplay)</div><div class="msg-text">[pauses] Around $40k, conservatively. Our engineering team was in firefighting mode for two weeks after the third one. But CompetitorX says they've fixed the root cause.</div></div></div><div class="msg agent"><div class="avatar">🤖</div><div class="msg-body"><div class="msg-name">AI Coach</div><div class="msg-text"><span class="label">✅ Follow-up Tasks</span><div class="task">1. Send case study: similar company, 99.97% uptime, 40% cost reduction<br>2. Propose a 2-week POC — no commitment, let the numbers talk<br>3. Offer to connect Sarah with your reliability engineering lead</div></div></div></div></div></div><div class="byok"><h3>🔑 Bring Your Own Key — Start Simulating</h3><div class="byok-row"><input id="key" placeholder="sk-... your API key" type="password"><button onclick="window.location.href='/setup?key='+document.getElementById('key').value">Start Practice →</button></div></div><div class="fork-bar"><h3>⚡ Fork & Deploy</h3><div class="deploy-box"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('code').textContent);this.textContent='Copied!'">Copy</button><code>git clone https://github.com/superinstance/businesslog-ai.git
cd businesslog-ai
npm install
npx wrangler deploy</code></div></div><div class="footer">BusinessLog.ai — Part of the Cocapn Ecosystem</div><div style="text-align:center;padding:24px;color:#475569;font-size:.75rem"><a href="https://the-fleet.casey-digennaro.workers.dev" style="color:#64748b">⚓ The Fleet</a> · <a href="https://cocapn.ai" style="color:#64748b">Cocapn</a></div>
    <div style="max-width:700px;margin:2rem auto;padding:1.5rem;background:rgba(255,255,255,0.05);border-radius:12px;text-align:center">
      <p style="margin:0 0 0.5rem;font-size:0.8rem;color:#888">Part of the Lucineer Ecosystem</p>
      <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:0.5rem;font-size:0.75rem">
        <a href="https://github.com/Lucineer/cocapn-ai" style="color:#60a5fa;text-decoration:none">cocapn.ai</a>
        <a href="https://github.com/Lucineer/deckboss" style="color:#60a5fa;text-decoration:none">deckboss.ai</a>
        <a href="https://github.com/Lucineer/deckboss-hardware" style="color:#60a5fa;text-decoration:none">deckboss.net</a>
        <a href="https://github.com/Lucineer/capitaine-ai" style="color:#60a5fa;text-decoration:none">capitaine.ai</a>
        <a href="https://github.com/Lucineer/the-fleet" style="color:#60a5fa;text-decoration:none">the-fleet</a>
      </div>
      <p style="margin:0.5rem 0 0;font-size:0.65rem;color:#666">Built by Superinstance &amp; Lucineer (DiGennaro et al.)</p>
    </div>
</body></html>`);
});

app.get('/api/evaporation', (c) => c.json({ hot: [], warm: [], coverage: 0, repo: 'businesslog-ai', timestamp: Date.now() }));
app.get('/api/kg', (c) => c.json({ nodes: [], edges: [], domain: 'businesslog-ai', timestamp: Date.now() }));
app.get('/api/memory', (c) => c.json({ patterns: [], repo: 'businesslog-ai', timestamp: Date.now() }));
app.get('/api/confidence', async (c) => { const scores = await getConfidence(c.env); return c.json(scores); });
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

app.get('/api/efficiency', async (c) => {
  const stats = await getEfficiencyStats(c.env.MEMORY as any, 'businesslog-ai');
  return c.json({ success: true, ...stats });
});
app.get("/health", (c) => c.json({status:'ok',agent:'businesslog-ai',version:'1.1.0',agentCount:2,modules:['chat','files','auth','team','analytics','meeting-sim','seed'],seedVersion:'2024.04',timestamp:Date.now()}));
app.get("/vessel.json", async (c) => { try { const vj = await import('./vessel.json', { with: { type: 'json' } }); return c.json(vj.default || vj); } catch { return c.json({}); } });
app.get('/api/seed', (c) => c.json({
  domain: 'businesslog-ai', description: 'Business intelligence — CRM, meetings, team analytics', seedVersion: '2024.04',
  frameworks: ['STAR method', 'OKR', 'weekly standup', '1:1 meeting template', 'retrospective', 'Eisenhower matrix'],
  crmPatterns: ['lead scoring', 'pipeline stages', 'deal velocity', 'churn prediction', 'NPS tracking'],
  meetingFormats: ['standup', '1:1', 'sprint planning', 'retrospective', 'all-hands', 'brainstorm'],
  systemPrompt: 'You are BusinessLog, a business intelligence assistant.'
}));

app.get("/api/health", (c) => {
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
// Workspaces
// ---------------------------------------------------------------------------

import {
  createWorkspace, getWorkspace, listWorkspacesForUser, updateWorkspace as updateWs, deleteWorkspace as deleteWs,
  getMembers, addMember, removeMember, updateMemberRole, inviteMember, listInvites, acceptInvite,
  getSettings, updateSettings, getActivityFeed, checkPermission,
} from './teams/workspace';

app.post('/api/workspaces', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{ name: string; description?: string; icon?: string }>();

  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

  const ws = await createWorkspace(c.env.MEMORY, {
    name: body.name,
    description: body.description || '',
    icon: body.icon || '🏢',
    ownerId: user.sub,
    ownerEmail: user.email,
    ownerName: user.email,
  });

  return c.json(ws, 201);
});

app.get('/api/workspaces', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const workspaces = await listWorkspacesForUser(c.env.MEMORY, user.sub);
  return c.json(workspaces);
});

app.get('/api/workspaces/:id', authMiddleware, async (c) => {
  const ws = await getWorkspace(c.env.MEMORY, c.req.param('id'));
  if (!ws) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(ws);
});

app.put('/api/workspaces/:id', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const wsId = c.req.param('id');
  const ws = await getWorkspace(c.env.MEMORY, wsId);
  if (!ws) return c.json({ error: 'Workspace not found' }, 404);

  const hasPermission = await checkPermission(c.env.MEMORY, wsId, user.sub, ['owner', 'admin']);
  if (!hasPermission) return c.json({ error: 'Insufficient permissions' }, 403);

  const body = await c.req.json<{ name?: string; description?: string; icon?: string }>();
  const updated = await updateWs(c.env.MEMORY, wsId, body);
  return c.json(updated);
});

app.delete('/api/workspaces/:id', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const wsId = c.req.param('id');
  const ws = await getWorkspace(c.env.MEMORY, wsId);
  if (!ws) return c.json({ error: 'Workspace not found' }, 404);
  if (ws.ownerId !== user.sub) return c.json({ error: 'Only the owner can delete a workspace' }, 403);

  await deleteWs(c.env.MEMORY, wsId);
  return c.json({ success: true });
});

// Workspace members
app.get('/api/workspaces/:id/members', authMiddleware, async (c) => {
  const members = await getMembers(c.env.MEMORY, c.req.param('id'));
  return c.json(members);
});

app.post('/api/workspaces/:id/members', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const wsId = c.req.param('id');
  const body = await c.req.json<{ userId: string; email: string; name: string; role: string }>();

  try {
    const member = await addMember(c.env.MEMORY, wsId, {
      userId: body.userId,
      email: body.email,
      name: body.name,
      role: body.role as any,
    });
    return c.json(member, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.delete('/api/workspaces/:id/members/:userId', authMiddleware, async (c) => {
  const wsId = c.req.param('id');
  const targetId = c.req.param('userId');
  try {
    await removeMember(c.env.MEMORY, wsId, targetId);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.put('/api/workspaces/:id/members/:userId/role', authMiddleware, async (c) => {
  const wsId = c.req.param('id');
  const targetId = c.req.param('userId');
  const body = await c.req.json<{ role: string }>();
  try {
    await updateMemberRole(c.env.MEMORY, wsId, targetId, body.role as any);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Workspace invites
app.post('/api/workspaces/:id/invites', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{ email: string; role: string }>();
  try {
    const invite = await inviteMember(c.env.MEMORY, c.req.param('id'), body.email, body.role as any, user.sub);
    return c.json(invite, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.get('/api/workspaces/:id/invites', authMiddleware, async (c) => {
  const invites = await listInvites(c.env.MEMORY, c.req.param('id'));
  return c.json(invites);
});

app.post('/api/workspaces/:id/invites/:inviteId/accept', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  try {
    const member = await acceptInvite(c.env.MEMORY, c.req.param('inviteId'), c.req.param('id'), user.sub, user.email, user.email);
    return c.json(member);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Workspace settings
app.get('/api/workspaces/:id/settings', authMiddleware, async (c) => {
  const settings = await getSettings(c.env.MEMORY, c.req.param('id'));
  if (!settings) return c.json({ error: 'Settings not found' }, 404);
  return c.json(settings);
});

app.put('/api/workspaces/:id/settings', authMiddleware, async (c) => {
  const body = await c.req.json<{ name?: string; timezone?: string; language?: string }>();
  const settings = await updateSettings(c.env.MEMORY, c.req.param('id'), body);
  return c.json(settings);
});

// Workspace activity feed
app.get('/api/workspaces/:id/activity', authMiddleware, async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const feed = await getActivityFeed(c.env.MEMORY, c.req.param('id'), limit);
  return c.json(feed);
});

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

import {
  createThread, getThread, listThreadsByWorkspace, listThreadsByChannel, deleteThread,
  getReplies, addReply, editReply, deleteReply, generateSummary,
  pinThread, unpinThread, listPinnedThreads, moveThread,
  updatePermissions as updateThreadPermissions, canViewThread, canReplyToThread,
} from './threads/threads';

app.post('/api/threads', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{
    workspaceId: string; channelId: string; parentMessageId: string;
    title: string; initialMessage: string; permissions?: any;
  }>();

  if (!body.workspaceId || !body.title || !body.initialMessage) {
    return c.json({ error: 'workspaceId, title, and initialMessage are required' }, 400);
  }

  const thread = await createThread(c.env.MEMORY, {
    workspaceId: body.workspaceId,
    channelId: body.channelId || 'general',
    parentMessageId: body.parentMessageId || crypto.randomUUID(),
    title: body.title,
    createdBy: user.sub,
    createdByEmail: user.email,
    initialMessage: body.initialMessage,
    permissions: body.permissions,
  });

  return c.json(thread, 201);
});

app.get('/api/threads/:id', authMiddleware, async (c) => {
  const thread = await getThread(c.env.MEMORY, c.req.param('id'));
  if (!thread) return c.json({ error: 'Thread not found' }, 404);
  return c.json(thread);
});

app.get('/api/workspaces/:id/threads', authMiddleware, async (c) => {
  const threads = await listThreadsByWorkspace(c.env.MEMORY, c.req.param('id'));
  return c.json(threads);
});

app.get('/api/workspaces/:id/threads/channel/:channelId', authMiddleware, async (c) => {
  const threads = await listThreadsByChannel(c.env.MEMORY, c.req.param('id'), c.req.param('channelId'));
  return c.json(threads);
});

app.delete('/api/threads/:id', authMiddleware, async (c) => {
  await deleteThread(c.env.MEMORY, c.req.param('id'));
  return c.json({ success: true });
});

// Replies
app.get('/api/threads/:id/replies', authMiddleware, async (c) => {
  const replies = await getReplies(c.env.MEMORY, c.req.param('id'));
  return c.json(replies);
});

app.post('/api/threads/:id/replies', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{ content: string }>();
  if (!body.content?.trim()) return c.json({ error: 'content is required' }, 400);
  const reply = await addReply(c.env.MEMORY, c.req.param('id'), {
    userId: user.sub, userName: user.email, content: body.content,
  });
  return c.json(reply, 201);
});

app.put('/api/threads/:id/replies/:replyId', authMiddleware, async (c) => {
  const body = await c.req.json<{ content: string }>();
  try {
    await editReply(c.env.MEMORY, c.req.param('id'), c.req.param('replyId'), body.content);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

app.delete('/api/threads/:id/replies/:replyId', authMiddleware, async (c) => {
  await deleteReply(c.env.MEMORY, c.req.param('id'), c.req.param('replyId'));
  return c.json({ success: true });
});

// AI Summary
app.post('/api/threads/:id/summary', authMiddleware, async (c) => {
  try {
    const summary = await generateSummary(c.env.MEMORY, c.req.param('id'), c.env.DEEPSEEK_API_KEY);
    return c.json({ summary });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Pinning
app.post('/api/threads/:id/pin', authMiddleware, async (c) => {
  try {
    await pinThread(c.env.MEMORY, c.req.param('id'));
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

app.post('/api/threads/:id/unpin', authMiddleware, async (c) => {
  try {
    await unpinThread(c.env.MEMORY, c.req.param('id'));
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

app.get('/api/workspaces/:id/threads/pinned', authMiddleware, async (c) => {
  const pinned = await listPinnedThreads(c.env.MEMORY, c.req.param('id'));
  return c.json(pinned);
});

// Move thread
app.post('/api/threads/:id/move', authMiddleware, async (c) => {
  const body = await c.req.json<{ channelId: string }>();
  try {
    await moveThread(c.env.MEMORY, c.req.param('id'), body.channelId);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

// Thread permissions
app.put('/api/threads/:id/permissions', authMiddleware, async (c) => {
  const body = await c.req.json<any>();
  try {
    await updateThreadPermissions(c.env.MEMORY, c.req.param('id'), body);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

// ---------------------------------------------------------------------------
// Analytics Dashboard (enhanced)
// ---------------------------------------------------------------------------

import {
  getDashboard as getFullDashboard, exportToCSV, exportToPDFText,
  recordTokenUsage, recordResponseTime, recordTopic, updateUserActivity,
} from './analytics/dashboard';

app.get('/api/analytics/v2/dashboard', authMiddleware, roleMiddleware(['admin', 'member']), async (c) => {
  const days = parseInt(c.req.query('days') || '30', 10);
  const report = await getFullDashboard(c.env.ANALYTICS_KV, c.env.DB, days);
  return c.json(report);
});

app.get('/api/analytics/v2/export', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const days = parseInt(c.req.query('days') || '30', 10);
  const format = c.req.query('format') || 'json';
  const report = await getFullDashboard(c.env.ANALYTICS_KV, c.env.DB, days);

  if (format === 'csv') {
    return c.text(exportToCSV(report), 200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="analytics-${report.period.from}-to-${report.period.to}.csv"`,
    });
  }

  if (format === 'pdf') {
    return c.text(exportToPDFText(report), 200, {
      'Content-Type': 'text/plain',
      'Content-Disposition': `attachment; filename="analytics-${report.period.from}-to-${report.period.to}.txt"`,
    });
  }

  return c.json(report);
});

// ---------------------------------------------------------------------------
// Admin Panel (enhanced)
// ---------------------------------------------------------------------------

import {
  addAuditEntry, getAuditLog, getAuditLogForUser,
  inviteUser, removeUser as adminRemoveUser, changeUserRole,
  getRetentionPolicy, setRetentionPolicy, enforceRetentionPolicy,
  createBackup, listBackups, restoreBackup, deleteBackup,
  createApiKey, listApiKeys, validateApiKey, revokeApiKey,
} from './admin/admin';

// Audit log
app.get('/api/admin/audit', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const days = parseInt(c.req.query('days') || '30', 10);
  const log = await getAuditLog(c.env.MEMORY, days);
  return c.json(log);
});

app.get('/api/admin/audit/user/:userId', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const days = parseInt(c.req.query('days') || '30', 10);
  const log = await getAuditLogForUser(c.env.MEMORY, c.req.param('userId'), days);
  return c.json(log);
});

// User management (admin)
app.post('/api/admin/users/invite', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{ email: string; role: string }>();
  await ensureUsersTable(c.env.DB);
  try {
    await inviteUser(c.env.MEMORY, c.env.DB, body.email, body.role || 'member', user.sub, user.email);
    return c.json({ success: true }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.delete('/api/admin/users/:id', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const user = c.get('user') as JwtPayload;
  await ensureUsersTable(c.env.DB);
  try {
    await adminRemoveUser(c.env.MEMORY, c.env.DB, c.req.param('id'), user.sub, user.email);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.put('/api/admin/users/:id/role', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{ role: string }>();
  await ensureUsersTable(c.env.DB);
  try {
    await changeUserRole(c.env.MEMORY, c.env.DB, c.req.param('id'), body.role, user.sub, user.email);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Data retention
app.get('/api/admin/retention', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const policy = await getRetentionPolicy(c.env.MEMORY);
  return c.json(policy);
});

app.put('/api/admin/retention', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{ conversationDays?: number; fileDays?: number; auditDays?: number; analyticsDays?: number }>();
  const policy = await setRetentionPolicy(c.env.MEMORY, body, user.sub, user.email);
  return c.json(policy);
});

app.post('/api/admin/retention/enforce', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const result = await enforceRetentionPolicy(c.env.MEMORY);
  return c.json(result);
});

// Backup / Restore
app.post('/api/admin/backups', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const body = await c.req.json<{ name: string; type?: 'full' | 'partial' }>();
  await ensureUsersTable(c.env.DB);
  const backup = await createBackup(c.env.MEMORY, c.env.DB, body.name, body.type || 'full');
  return c.json(backup, 201);
});

app.get('/api/admin/backups', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const backups = await listBackups(c.env.MEMORY);
  return c.json(backups);
});

app.post('/api/admin/backups/:id/restore', authMiddleware, roleMiddleware(['admin']), async (c) => {
  try {
    await restoreBackup(c.env.MEMORY, c.req.param('id'));
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

app.delete('/api/admin/backups/:id', authMiddleware, roleMiddleware(['admin']), async (c) => {
  await deleteBackup(c.env.MEMORY, c.req.param('id'));
  return c.json({ success: true });
});

// API Key management
app.post('/api/admin/apikeys', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{ name: string; permissions?: string[] }>();
  const { record, plainKey } = await createApiKey(c.env.MEMORY, {
    name: body.name,
    permissions: body.permissions || ['read'],
    createdBy: user.sub,
    createdByEmail: user.email,
  });
  return c.json({ ...record, key: plainKey }, 201);
});

app.get('/api/admin/apikeys', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const keys = await listApiKeys(c.env.MEMORY);
  return c.json(keys);
});

app.delete('/api/admin/apikeys/:id', authMiddleware, roleMiddleware(['admin']), async (c) => {
  const user = c.get('user') as JwtPayload;
  try {
    await revokeApiKey(c.env.MEMORY, c.req.param('id'), user.sub, user.email);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

// API Key auth middleware (for external API access)
app.use('/api/external/*', async (c, next) => {
  const keyHeader = c.req.header('X-API-Key');
  if (!keyHeader) return c.json({ error: 'Missing X-API-Key header' }, 401);

  const record = await validateApiKey(c.env.MEMORY, keyHeader);
  if (!record) return c.json({ error: 'Invalid or revoked API key' }, 401);

  c.set('apiKey', record);
  await next();
});

app.get('/api/external/health', async (c) => {
  return c.json({ status: 'ok', message: 'External API is active' });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

import {
  createWebhook, getWebhook, listWebhooks, updateWebhook as updateWh,
  deleteWebhook as deleteWh, getDeliveryLog, retryDelivery, testWebhook, broadcastEvent,
} from './webhooks/webhooks';

app.post('/api/webhooks', authMiddleware, async (c) => {
  const user = c.get('user') as JwtPayload;
  const body = await c.req.json<{ url: string; events: string[]; description?: string }>();

  if (!body.url || !body.events?.length) {
    return c.json({ error: 'url and events are required' }, 400);
  }

  const webhook = await createWebhook(c.env.MEMORY, {
    url: body.url,
    events: body.events as any[],
    description: body.description || '',
    createdBy: user.sub,
  });

  return c.json(webhook, 201);
});

app.get('/api/webhooks', authMiddleware, async (c) => {
  const webhooks = await listWebhooks(c.env.MEMORY);
  return c.json(webhooks);
});

app.get('/api/webhooks/:id', authMiddleware, async (c) => {
  const webhook = await getWebhook(c.env.MEMORY, c.req.param('id'));
  if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
  return c.json(webhook);
});

app.put('/api/webhooks/:id', authMiddleware, async (c) => {
  const body = await c.req.json<{ url?: string; events?: string[]; description?: string; active?: boolean }>();
  const updated = await updateWh(c.env.MEMORY, c.req.param('id'), body as any);
  if (!updated) return c.json({ error: 'Webhook not found' }, 404);
  return c.json(updated);
});

app.delete('/api/webhooks/:id', authMiddleware, async (c) => {
  await deleteWh(c.env.MEMORY, c.req.param('id'));
  return c.json({ success: true });
});

// Webhook delivery log
app.get('/api/webhooks/:id/deliveries', authMiddleware, async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const deliveries = await getDeliveryLog(c.env.MEMORY, c.req.param('id'), limit);
  return c.json(deliveries);
});

// Retry a failed delivery
app.post('/api/webhooks/:webhookId/deliveries/:deliveryId/retry', authMiddleware, async (c) => {
  try {
    const delivery = await retryDelivery(c.env.MEMORY, c.req.param('webhookId'), c.req.param('deliveryId'));
    return c.json(delivery);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Test webhook
app.post('/api/webhooks/:id/test', authMiddleware, async (c) => {
  try {
    const delivery = await testWebhook(c.env.MEMORY, c.req.param('id'));
    return c.json(delivery);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;