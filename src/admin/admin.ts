/**
 * admin.ts — Admin panel: user management, data retention, audit log,
 * backup/restore, and API key management.
 *
 * KV key layout:
 *   admin:audit:{day}                — audit entries for a day (JSON array)
 *   admin:retention                  — retention policy settings (JSON)
 *   admin:backup:{id}                — backup snapshot (JSON)
 *   admin:apikeys:{keyId}            — API key record (JSON)
 *   admin:apikeys:index              — list of API key IDs (JSON array)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  action: string;
  actorId: string;
  actorEmail: string;
  target: string;
  detail: string;
  timestamp: string;
  ip?: string;
}

export interface RetentionPolicy {
  conversationDays: number;
  fileDays: number;
  auditDays: number;
  analyticsDays: number;
}

export interface BackupRecord {
  id: string;
  name: string;
  createdAt: string;
  size: number;
  type: 'full' | 'partial';
  data: Record<string, unknown>;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  permissions: string[];
  active: boolean;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function auditDayKey(day: string): string     { return `admin:audit:${day}`; }
function retentionKey(): string               { return `admin:retention`; }
function backupKey(id: string): string        { return `admin:backup:${id}`; }
function apiKeyRecordKey(id: string): string  { return `admin:apikeys:${id}`; }
function apiKeyIndexKey(): string             { return `admin:apikeys:index`; }

function todayStr(): string { return new Date().toISOString().split('T')[0]; }

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

export async function addAuditEntry(
  kv: KVNamespace,
  entry: Omit<AuditEntry, 'id' | 'timestamp'>,
): Promise<AuditEntry> {
  const day = todayStr();
  const full: AuditEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  const raw = await kv.get(auditDayKey(day), 'text');
  const entries: AuditEntry[] = raw ? JSON.parse(raw) : [];
  entries.push(full);
  // Keep last 500 per day
  const trimmed = entries.slice(-500);
  await kv.put(auditDayKey(day), JSON.stringify(trimmed));

  return full;
}

export async function getAuditLog(
  kv: KVNamespace,
  days: number = 30,
): Promise<AuditEntry[]> {
  const allEntries: AuditEntry[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = d.toISOString().split('T')[0];
    const raw = await kv.get(auditDayKey(day), 'text');
    if (raw) {
      allEntries.push(...(JSON.parse(raw) as AuditEntry[]));
    }
  }
  return allEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export async function getAuditLogForUser(
  kv: KVNamespace,
  userId: string,
  days: number = 30,
): Promise<AuditEntry[]> {
  const all = await getAuditLog(kv, days);
  return all.filter((e) => e.actorId === userId);
}

// ---------------------------------------------------------------------------
// User Management
// ---------------------------------------------------------------------------

export async function listUsers(db: D1Database): Promise<Array<{ id: string; email: string; name: string; role: string; created_at: string }>> {
  const { results } = await db
    .prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC')
    .all<{ id: string; email: string; name: string; role: string; created_at: string }>();
  return results;
}

export async function inviteUser(
  kv: KVNamespace,
  db: D1Database,
  email: string,
  role: string,
  invitedBy: string,
  invitedByEmail: string,
): Promise<void> {
  // Create invitation record
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare('INSERT OR IGNORE INTO invites (id, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, email, role, invitedBy, now, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString())
    .run();

  await addAuditEntry(kv, {
    action: 'user.invited',
    actorId: invitedBy,
    actorEmail: invitedByEmail,
    target: email,
    detail: `Invited ${email} as ${role}`,
  });
}

export async function removeUser(
  kv: KVNamespace,
  db: D1Database,
  targetId: string,
  adminId: string,
  adminEmail: string,
): Promise<void> {
  const target = await db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(targetId).first<{ id: string; email: string; name: string; role: string }>();
  if (!target) throw new Error('User not found');
  if (targetId === adminId) throw new Error('Cannot remove yourself');

  // Prevent removing last admin
  if (target.role === 'admin') {
    const { results } = await db.prepare("SELECT id FROM users WHERE role = 'admin'").all<{ id: string }>();
    if (results.length <= 1) throw new Error('Cannot remove the last admin');
  }

  await db.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();

  // Clean up KV data
  const prefixes = [`conversation:${targetId}:`, `file:${targetId}:`, `file-meta:${targetId}:`];
  for (const prefix of prefixes) {
    const list = await kv.list({ prefix });
    for (const key of list.keys) {
      await kv.delete(key.name);
    }
  }

  await addAuditEntry(kv, {
    action: 'user.removed',
    actorId: adminId,
    actorEmail: adminEmail,
    target: target.email,
    detail: `Removed user ${target.name} (${target.email})`,
  });
}

export async function changeUserRole(
  kv: KVNamespace,
  db: D1Database,
  targetId: string,
  newRole: string,
  adminId: string,
  adminEmail: string,
): Promise<void> {
  if (!['admin', 'member', 'viewer'].includes(newRole)) {
    throw new Error('Invalid role');
  }

  const target = await db.prepare('SELECT id, email, role FROM users WHERE id = ?').bind(targetId).first<{ id: string; email: string; role: string }>();
  if (!target) throw new Error('User not found');

  if (target.role === 'admin' && newRole !== 'admin') {
    const { results } = await db.prepare("SELECT id FROM users WHERE role = 'admin'").all<{ id: string }>();
    if (results.length <= 1) throw new Error('Cannot demote the last admin');
  }

  await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(newRole, targetId).run();

  await addAuditEntry(kv, {
    action: 'user.role_changed',
    actorId: adminId,
    actorEmail: adminEmail,
    target: target.email,
    detail: `Changed role from ${target.role} to ${newRole}`,
  });
}

// ---------------------------------------------------------------------------
// Data Retention Policies
// ---------------------------------------------------------------------------

export async function getRetentionPolicy(kv: KVNamespace): Promise<RetentionPolicy> {
  const raw = await kv.get(retentionKey(), 'text');
  if (!raw) {
    return { conversationDays: 90, fileDays: 365, auditDays: 365, analyticsDays: 365 };
  }
  return JSON.parse(raw) as RetentionPolicy;
}

export async function setRetentionPolicy(kv: KVNamespace, policy: Partial<RetentionPolicy>, adminId: string, adminEmail: string): Promise<RetentionPolicy> {
  const current = await getRetentionPolicy(kv);
  const updated = { ...current, ...policy };
  await kv.put(retentionKey(), JSON.stringify(updated));

  await addAuditEntry(kv, {
    action: 'retention.updated',
    actorId: adminId,
    actorEmail: adminEmail,
    target: 'retention-policy',
    detail: `Updated retention policy`,
  });

  return updated;
}

export async function enforceRetentionPolicy(kv: KVNamespace): Promise<{ deletedConversations: number; deletedFiles: number }> {
  const policy = await getRetentionPolicy(kv);
  const cutoffConv = new Date(Date.now() - policy.conversationDays * 24 * 60 * 60 * 1000);
  const cutoffFile = new Date(Date.now() - policy.fileDays * 24 * 60 * 60 * 1000);

  let deletedConversations = 0;
  let deletedFiles = 0;

  // Clean expired conversations
  const convList = await kv.list({ prefix: 'conversation:' });
  for (const key of convList.keys) {
    // KV metadata doesn't store timestamps directly, so we check the value
    const raw = await kv.get(key.name, 'text');
    if (raw) {
      try {
        const msgs = JSON.parse(raw) as Array<{ timestamp?: string }>;
        if (msgs.length === 0) continue;
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg.timestamp && new Date(lastMsg.timestamp) < cutoffConv) {
          await kv.delete(key.name);
          deletedConversations++;
        }
      } catch { /* skip malformed */ }
    }
  }

  // Clean expired file metadata
  const fileList = await kv.list({ prefix: 'file-meta:' });
  for (const key of fileList.keys) {
    const raw = await kv.get(key.name, 'text');
    if (raw) {
      try {
        const meta = JSON.parse(raw) as { uploadedAt?: string };
        if (meta.uploadedAt && new Date(meta.uploadedAt) < cutoffFile) {
          await kv.delete(key.name);
          // Also delete the file content
          const contentKey = key.name.replace('file-meta:', 'file:');
          await kv.delete(contentKey);
          deletedFiles++;
        }
      } catch { /* skip malformed */ }
    }
  }

  return { deletedConversations, deletedFiles };
}

// ---------------------------------------------------------------------------
// Backup / Restore
// ---------------------------------------------------------------------------

export async function createBackup(
  kv: KVNamespace,
  db: D1Database,
  name: string,
  type: 'full' | 'partial' = 'full',
): Promise<BackupRecord> {
  const id = crypto.randomUUID();
  const data: Record<string, unknown> = {};

  // Backup users
  const users = await listUsers(db);
  data.users = users;

  // Backup all KV data
  if (type === 'full') {
    const prefixes = ['workspace/', 'thread/', 'admin:', 'analytics:'];
    const kvData: Record<string, unknown> = {};

    for (const prefix of prefixes) {
      const list = await kv.list({ prefix });
      for (const key of list.keys) {
        const val = await kv.get(key.name, 'text');
        if (val) {
          try { kvData[key.name] = JSON.parse(val); } catch { kvData[key.name] = val; }
        }
      }
    }
    data.kvData = kvData;
  }

  const record: BackupRecord = {
    id,
    name,
    createdAt: new Date().toISOString(),
    size: JSON.stringify(data).length,
    type,
    data,
  };

  await kv.put(backupKey(id), JSON.stringify(record));

  await addAuditEntry(kv, {
    action: 'backup.created',
    actorId: 'system',
    actorEmail: 'system',
    target: id,
    detail: `Created ${type} backup: ${name}`,
  });

  return record;
}

export async function listBackups(kv: KVNamespace): Promise<Array<Omit<BackupRecord, 'data'>>> {
  const list = await kv.list({ prefix: 'admin:backup:' });
  const backups: Array<Omit<BackupRecord, 'data'>> = [];
  for (const key of list.keys) {
    const raw = await kv.get(key.name, 'text');
    if (raw) {
      const record = JSON.parse(raw) as BackupRecord;
      backups.push({ id: record.id, name: record.name, createdAt: record.createdAt, size: record.size, type: record.type });
    }
  }
  return backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function restoreBackup(kv: KVNamespace, backupId: string): Promise<void> {
  const raw = await kv.get(backupKey(backupId), 'text');
  if (!raw) throw new Error('Backup not found');
  const record = JSON.parse(raw) as BackupRecord;

  const kvData = record.data.kvData as Record<string, unknown> | undefined;
  if (kvData) {
    for (const [key, value] of Object.entries(kvData)) {
      await kv.put(key, JSON.stringify(value));
    }
  }

  await addAuditEntry(kv, {
    action: 'backup.restored',
    actorId: 'system',
    actorEmail: 'system',
    target: backupId,
    detail: `Restored backup: ${record.name}`,
  });
}

export async function deleteBackup(kv: KVNamespace, backupId: string): Promise<void> {
  await kv.delete(backupKey(backupId));
}

// ---------------------------------------------------------------------------
// API Key Management
// ---------------------------------------------------------------------------

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createApiKey(
  kv: KVNamespace,
  opts: { name: string; permissions: string[]; createdBy: string; createdByEmail: string },
): Promise<{ record: ApiKeyRecord; plainKey: string }> {
  const id = crypto.randomUUID();
  const rawKey = `bla_${crypto.randomUUID().replace(/-/g, '')}`;
  const keyPrefix = rawKey.slice(0, 8);
  const keyHash = await hashKey(rawKey);

  const record: ApiKeyRecord = {
    id,
    name: opts.name,
    keyPrefix,
    keyHash,
    createdBy: opts.createdBy,
    createdAt: new Date().toISOString(),
    permissions: opts.permissions,
    active: true,
  };

  await kv.put(apiKeyRecordKey(id), JSON.stringify(record));

  // Update index
  const raw = await kv.get(apiKeyIndexKey(), 'text');
  const ids: string[] = raw ? JSON.parse(raw) : [];
  ids.push(id);
  await kv.put(apiKeyIndexKey(), JSON.stringify(ids));

  await addAuditEntry(kv, {
    action: 'apikey.created',
    actorId: opts.createdBy,
    actorEmail: opts.createdByEmail,
    target: id,
    detail: `Created API key "${opts.name}"`,
  });

  return { record, plainKey: rawKey };
}

export async function listApiKeys(kv: KVNamespace): Promise<Array<Omit<ApiKeyRecord, 'keyHash'>>> {
  const raw = await kv.get(apiKeyIndexKey(), 'text');
  if (!raw) return [];
  const ids: string[] = JSON.parse(raw);
  const results: Array<Omit<ApiKeyRecord, 'keyHash'>> = [];

  for (const id of ids) {
    const r = await kv.get(apiKeyRecordKey(id), 'text');
    if (r) {
      const record = JSON.parse(r) as ApiKeyRecord;
      results.push({
        id: record.id,
        name: record.name,
        keyPrefix: record.keyPrefix,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        permissions: record.permissions,
        active: record.active,
      });
    }
  }

  return results;
}

export async function validateApiKey(kv: KVNamespace, key: string): Promise<ApiKeyRecord | null> {
  const raw = await kv.get(apiKeyIndexKey(), 'text');
  if (!raw) return null;
  const ids: string[] = JSON.parse(raw);

  const keyHash = await hashKey(key);

  for (const id of ids) {
    const r = await kv.get(apiKeyRecordKey(id), 'text');
    if (r) {
      const record = JSON.parse(r) as ApiKeyRecord;
      if (record.keyHash === keyHash && record.active) {
        // Update last used
        record.lastUsedAt = new Date().toISOString();
        await kv.put(apiKeyRecordKey(id), JSON.stringify(record));
        return record;
      }
    }
  }

  return null;
}

export async function revokeApiKey(kv: KVNamespace, keyId: string, adminId: string, adminEmail: string): Promise<void> {
  const raw = await kv.get(apiKeyRecordKey(keyId), 'text');
  if (!raw) throw new Error('API key not found');
  const record = JSON.parse(raw) as ApiKeyRecord;
  record.active = false;
  await kv.put(apiKeyRecordKey(keyId), JSON.stringify(record));

  await addAuditEntry(kv, {
    action: 'apikey.revoked',
    actorId: adminId,
    actorEmail: adminEmail,
    target: keyId,
    detail: `Revoked API key "${record.name}"`,
  });
}
