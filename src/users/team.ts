export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  lastActive?: string;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

const VALID_ROLES = ['admin', 'member', 'viewer'] as const;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function listTeamMembers(db: D1Database): Promise<TeamMember[]> {
  const { results } = await db
    .prepare('SELECT id, email, name, role, created_at, last_active FROM users ORDER BY created_at ASC')
    .all<{ id: string; email: string; name: string; role: string; created_at: string; last_active: string | null }>();

  return results.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    lastActive: row.last_active ?? undefined,
  }));
}

async function getMember(db: D1Database, id: string): Promise<TeamMember | null> {
  const row = await db
    .prepare('SELECT id, email, name, role, created_at, last_active FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; email: string; name: string; role: string; created_at: string; last_active: string | null }>();

  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    lastActive: row.last_active ?? undefined,
  };
}

async function updateMemberRole(db: D1Database, id: string, role: string): Promise<void> {
  if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
    throw new Error(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  const member = await db.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: string }>();
  if (!member) throw new Error('Member not found');

  if (member.role === 'admin' && role !== 'admin') {
    const { results } = await db
      .prepare('SELECT id FROM users WHERE role = ?')
      .bind('admin')
      .all<{ id: string }>();
    if (results.length <= 1) {
      throw new Error('Cannot remove the last admin');
    }
  }

  await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
}

async function removeMember(db: D1Database, id: string, kv?: KVNamespace): Promise<void> {
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();

  if (kv) {
    const list = await kv.list({ prefix: `memory:${id}:` });
    for (const key of list.keys) {
      await kv.delete(key.name);
    }
  }
}

async function createInvite(
  db: D1Database,
  email: string,
  role: string,
  invitedBy: string
): Promise<TeamInvite> {
  if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
    throw new Error(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  const id = crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SEVEN_DAYS_MS).toISOString();

  await db
    .prepare('INSERT INTO invites (id, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, email, role, invitedBy, createdAt, expiresAt)
    .run();

  return { id, email, role, invitedBy, createdAt, expiresAt };
}

async function validateInvite(db: D1Database, inviteId: string): Promise<TeamInvite | null> {
  const row = await db
    .prepare('SELECT id, email, role, invited_by, created_at, expires_at FROM invites WHERE id = ?')
    .bind(inviteId)
    .first<{ id: string; email: string; role: string; invited_by: string; created_at: string; expires_at: string }>();

  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

async function getTeamStats(db: D1Database): Promise<{
  totalMembers: number;
  admins: number;
  members: number;
  viewers: number;
}> {
  const { results } = await db
    .prepare('SELECT role, COUNT(*) as count FROM users GROUP BY role')
    .all<{ role: string; count: number }>();

  let admins = 0;
  let members = 0;
  let viewers = 0;

  for (const row of results) {
    switch (row.role) {
      case 'admin': admins = row.count; break;
      case 'member': members = row.count; break;
      case 'viewer': viewers = row.count; break;
    }
  }

  return { totalMembers: admins + members + viewers, admins, members, viewers };
}

async function initializeUsersTable(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_active TEXT
    );
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      invited_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
}

export {
  listTeamMembers,
  getMember,
  updateMemberRole,
  removeMember,
  createInvite,
  validateInvite,
  getTeamStats,
  initializeUsersTable,
};
