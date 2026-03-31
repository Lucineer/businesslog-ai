export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | 'viewer';
  createdAt: string;
}

export interface AuthToken {
  userId: string;
  email: string;
  role: string;
  exp: number;
  iat: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function generateId(): string {
  return crypto.randomUUID();
}

function base64url(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return base64url(hashArray);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password);
  return computed === hash;
}

async function signToken(
  payload: Omit<AuthToken, 'exp' | 'iat'>,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: AuthToken = {
    ...payload,
    iat: now,
    exp: now + Math.floor(SEVEN_DAYS_MS / 1000),
  };

  const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64url(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  const signatureB64 = base64url(new Uint8Array(signature));

  return `${signingInput}.${signatureB64}`;
}

async function verifyToken(token: string, secret: string): Promise<AuthToken | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const encoder = new TextEncoder();
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signature = base64urlDecode(signatureB64);
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput));
  if (!valid) return null;

  try {
    const payload: AuthToken = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

async function registerUser(
  db: D1Database,
  email: string,
  password: string,
  name: string,
  adminEmail: string
): Promise<{ user: User; token: string }> {
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    throw new Error('Email already registered');
  }

  const id = generateId();
  const hash = await hashPassword(password);
  const createdAt = new Date().toISOString();

  const countResult = await db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();
  const isFirst = !countResult || countResult.cnt === 0;
  const role: User['role'] = isFirst || email === adminEmail ? 'admin' : 'member';

  await db
    .prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, email, name, role, hash, createdAt)
    .run();

  const user: User = { id, email, name, role, createdAt };
  const secret = process.env.JWT_SECRET ?? 'default-secret';
  const token = await signToken({ userId: id, email, role }, secret);

  return { user, token };
}

async function loginUser(
  db: D1Database,
  email: string,
  password: string
): Promise<{ user: User; token: string } | null> {
  const row = await db
    .prepare('SELECT id, email, name, role, password_hash, created_at FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; email: string; name: string; role: string; password_hash: string; created_at: string }>();

  if (!row) return null;

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;

  const user: User = { id: row.id, email: row.email, name: row.name, role: row.role as User['role'], createdAt: row.created_at };
  const secret = process.env.JWT_SECRET ?? 'default-secret';
  const token = await signToken({ userId: user.id, email: user.email, role: user.role }, secret);

  return { user, token };
}

async function getUserFromRequest(request: Request, secret: string): Promise<User | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const payload = await verifyToken(token, secret);
  if (!payload) return null;

  // In a full implementation, fetch from DB to ensure user still exists
  return {
    id: payload.userId,
    email: payload.email,
    name: '',
    role: payload.role as User['role'],
    createdAt: new Date(payload.iat * 1000).toISOString(),
  };
}

export {
  generateId,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  registerUser,
  loginUser,
  getUserFromRequest,
};
