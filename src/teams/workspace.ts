/**
 * workspace.ts — Team workspaces with roles, invites, settings, and activity feed.
 *
 * KV key layout:
 *   workspace/{id}               — workspace metadata (JSON)
 *   workspace/{id}/members       — member list (JSON array)
 *   workspace/{id}/settings      — workspace settings (JSON)
 *   workspace/{id}/activity      — activity feed entries (JSON array)
 *   workspace/{id}/invites/{iid} — pending invites (JSON)
 *   user/{uid}/workspaces        — workspace IDs for a user (JSON array)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Workspace {
  id: string;
  name: string;
  description: string;
  icon: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceSettings {
  name: string;
  timezone: string;
  language: string;
}

export interface ActivityEntry {
  id: string;
  workspaceId: string;
  userId: string;
  action: string;
  detail: string;
  timestamp: string;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function wsKey(id: string): string                 { return `workspace/${id}`; }
function membersKey(id: string): string            { return `workspace/${id}/members`; }
function settingsKey(id: string): string           { return `workspace/${id}/settings`; }
function activityKey(id: string): string           { return `workspace/${id}/activity`; }
function inviteKey(wsId: string, iid: string): string { return `workspace/${wsId}/invites/${iid}`; }
function userWorkspacesKey(uid: string): string    { return `user/${uid}/workspaces`; }

// ---------------------------------------------------------------------------
// CRUD — Workspace
// ---------------------------------------------------------------------------

export async function createWorkspace(
  kv: KVNamespace,
  opts: { name: string; description: string; icon: string; ownerId: string; ownerEmail: string; ownerName: string },
): Promise<Workspace> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const ws: Workspace = {
    id,
    name: opts.name,
    description: opts.description,
    icon: opts.icon || '🏢',
    ownerId: opts.ownerId,
    createdAt: now,
    updatedAt: now,
  };
  await kv.put(wsKey(id), JSON.stringify(ws));

  // Owner becomes first member
  const member: WorkspaceMember = {
    userId: opts.ownerId,
    email: opts.ownerEmail,
    name: opts.ownerName,
    role: 'owner',
    joinedAt: now,
  };
  await kv.put(membersKey(id), JSON.stringify([member]));

  // Default settings
  const settings: WorkspaceSettings = {
    name: opts.name,
    timezone: 'UTC',
    language: 'en',
  };
  await kv.put(settingsKey(id), JSON.stringify(settings));

  // Empty activity feed
  await kv.put(activityKey(id), JSON.stringify([]));

  // Add to owner's workspace index
  await addUserWorkspace(kv, opts.ownerId, id);

  // Activity entry
  await addActivity(kv, id, opts.ownerId, 'workspace.created', `Created workspace "${opts.name}"`);

  return ws;
}

export async function getWorkspace(kv: KVNamespace, id: string): Promise<Workspace | null> {
  const raw = await kv.get(wsKey(id), 'text');
  if (!raw) return null;
  return JSON.parse(raw) as Workspace;
}

export async function listWorkspacesForUser(kv: KVNamespace, userId: string): Promise<Workspace[]> {
  const raw = await kv.get(userWorkspacesKey(userId), 'text');
  if (!raw) return [];
  const ids: string[] = JSON.parse(raw);
  const results = await Promise.all(ids.map((id) => kv.get(wsKey(id), 'text')));
  return results.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as Workspace);
}

export async function updateWorkspace(kv: KVNamespace, id: string, updates: Partial<Pick<Workspace, 'name' | 'description' | 'icon'>>): Promise<Workspace | null> {
  const ws = await getWorkspace(kv, id);
  if (!ws) return null;
  Object.assign(ws, updates, { updatedAt: new Date().toISOString() });
  await kv.put(wsKey(id), JSON.stringify(ws));
  return ws;
}

export async function deleteWorkspace(kv: KVNamespace, id: string): Promise<void> {
  // Remove from all members' workspace indexes
  const members = await getMembers(kv, id);
  for (const m of members) {
    await removeUserWorkspace(kv, m.userId, id);
  }
  // Delete all workspace keys
  const list = await kv.list({ prefix: `workspace/${id}` });
  for (const key of list.keys) {
    await kv.delete(key.name);
  }
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function getMembers(kv: KVNamespace, workspaceId: string): Promise<WorkspaceMember[]> {
  const raw = await kv.get(membersKey(workspaceId), 'text');
  if (!raw) return [];
  return JSON.parse(raw) as WorkspaceMember[];
}

export async function addMember(
  kv: KVNamespace,
  workspaceId: string,
  member: Omit<WorkspaceMember, 'joinedAt'>,
): Promise<WorkspaceMember> {
  const members = await getMembers(kv, workspaceId);
  if (members.find((m) => m.userId === member.userId)) {
    throw new Error('User is already a member of this workspace');
  }
  const entry: WorkspaceMember = { ...member, joinedAt: new Date().toISOString() };
  members.push(entry);
  await kv.put(membersKey(workspaceId), JSON.stringify(members));
  await addUserWorkspace(kv, member.userId, workspaceId);
  await addActivity(kv, workspaceId, member.userId, 'member.joined', `${member.name} joined the workspace`);
  return entry;
}

export async function removeMember(kv: KVNamespace, workspaceId: string, userId: string): Promise<void> {
  const members = await getMembers(kv, workspaceId);
  const target = members.find((m) => m.userId === userId);
  if (!target) throw new Error('User is not a member of this workspace');
  if (target.role === 'owner') throw new Error('Cannot remove the workspace owner');

  const filtered = members.filter((m) => m.userId !== userId);
  await kv.put(membersKey(workspaceId), JSON.stringify(filtered));
  await removeUserWorkspace(kv, userId, workspaceId);
  await addActivity(kv, workspaceId, userId, 'member.removed', `Member removed from workspace`);
}

export async function updateMemberRole(
  kv: KVNamespace,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  const members = await getMembers(kv, workspaceId);
  const target = members.find((m) => m.userId === userId);
  if (!target) throw new Error('User is not a member of this workspace');
  if (target.role === 'owner') throw new Error('Cannot change the owner role');
  target.role = role;
  await kv.put(membersKey(workspaceId), JSON.stringify(members));
  await addActivity(kv, workspaceId, userId, 'member.role_changed', `Role changed to ${role}`);
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export async function inviteMember(
  kv: KVNamespace,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
  invitedBy: string,
): Promise<WorkspaceInvite> {
  const id = crypto.randomUUID();
  const now = new Date();
  const invite: WorkspaceInvite = {
    id,
    workspaceId,
    email,
    role,
    invitedBy,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  await kv.put(inviteKey(workspaceId, id), JSON.stringify(invite));
  await addActivity(kv, workspaceId, invitedBy, 'member.invited', `Invited ${email} as ${role}`);
  return invite;
}

export async function listInvites(kv: KVNamespace, workspaceId: string): Promise<WorkspaceInvite[]> {
  const list = await kv.list({ prefix: `workspace/${workspaceId}/invites/` });
  const invites: WorkspaceInvite[] = [];
  for (const key of list.keys) {
    const raw = await kv.get(key.name, 'text');
    if (raw) invites.push(JSON.parse(raw) as WorkspaceInvite);
  }
  return invites;
}

export async function acceptInvite(
  kv: KVNamespace,
  inviteId: string,
  workspaceId: string,
  userId: string,
  email: string,
  name: string,
): Promise<WorkspaceMember> {
  const raw = await kv.get(inviteKey(workspaceId, inviteId), 'text');
  if (!raw) throw new Error('Invite not found');
  const invite = JSON.parse(raw) as WorkspaceInvite;
  if (new Date(invite.expiresAt).getTime() < Date.now()) throw new Error('Invite has expired');
  if (invite.email !== email) throw new Error('Invite email does not match');

  // Delete invite
  await kv.delete(inviteKey(workspaceId, inviteId));

  // Add as member
  return addMember(kv, workspaceId, { userId, email, name, role: invite.role });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(kv: KVNamespace, workspaceId: string): Promise<WorkspaceSettings | null> {
  const raw = await kv.get(settingsKey(workspaceId), 'text');
  if (!raw) return null;
  return JSON.parse(raw) as WorkspaceSettings;
}

export async function updateSettings(kv: KVNamespace, workspaceId: string, updates: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
  const current = (await getSettings(kv, workspaceId)) || { name: '', timezone: 'UTC', language: 'en' };
  Object.assign(current, updates);
  await kv.put(settingsKey(workspaceId), JSON.stringify(current));
  return current;
}

// ---------------------------------------------------------------------------
// Activity Feed
// ---------------------------------------------------------------------------

export async function getActivityFeed(kv: KVNamespace, workspaceId: string, limit: number = 50): Promise<ActivityEntry[]> {
  const raw = await kv.get(activityKey(workspaceId), 'text');
  if (!raw) return [];
  const entries: ActivityEntry[] = JSON.parse(raw);
  return entries.slice(-limit);
}

async function addActivity(
  kv: KVNamespace,
  workspaceId: string,
  userId: string,
  action: string,
  detail: string,
): Promise<void> {
  const raw = await kv.get(activityKey(workspaceId), 'text');
  const entries: ActivityEntry[] = raw ? JSON.parse(raw) : [];
  entries.push({
    id: crypto.randomUUID(),
    workspaceId,
    userId,
    action,
    detail,
    timestamp: new Date().toISOString(),
  });
  // Keep last 200 entries
  const trimmed = entries.slice(-200);
  await kv.put(activityKey(workspaceId), JSON.stringify(trimmed));
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

export async function checkPermission(
  kv: KVNamespace,
  workspaceId: string,
  userId: string,
  requiredRoles: WorkspaceRole[],
): Promise<boolean> {
  const members = await getMembers(kv, workspaceId);
  const member = members.find((m) => m.userId === userId);
  if (!member) return false;
  return requiredRoles.includes(member.role);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function addUserWorkspace(kv: KVNamespace, userId: string, workspaceId: string): Promise<void> {
  const raw = await kv.get(userWorkspacesKey(userId), 'text');
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(workspaceId)) {
    ids.push(workspaceId);
    await kv.put(userWorkspacesKey(userId), JSON.stringify(ids));
  }
}

async function removeUserWorkspace(kv: KVNamespace, userId: string, workspaceId: string): Promise<void> {
  const raw = await kv.get(userWorkspacesKey(userId), 'text');
  if (!raw) return;
  const ids: string[] = JSON.parse(raw);
  const filtered = ids.filter((id) => id !== workspaceId);
  await kv.put(userWorkspacesKey(userId), JSON.stringify(filtered));
}
