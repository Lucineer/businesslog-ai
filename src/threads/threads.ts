/**
 * threads.ts — Conversation threads with replies, AI summaries, pinning, and permissions.
 *
 * KV key layout:
 *   thread/{id}                    — thread metadata + first message (JSON)
 *   thread/{id}/replies            — reply messages (JSON array)
 *   workspace/{wsId}/threads       — thread index for a workspace (JSON array)
 *   thread/{id}/pinned             — pinned flag (string "1" or absent)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadMessage {
  id: string;
  userId: string;
  userName: string;
  content: string;
  createdAt: string;
  editedAt?: string;
}

export interface Thread {
  id: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  aiSummary?: string;
  pinned: boolean;
  permissions: ThreadPermissions;
}

export interface ThreadPermissions {
  visibleTo: 'all' | 'roles' | 'users';
  roles?: string[];
  userIds?: string[];
  canReply: 'all' | 'roles' | 'users';
  replyRoles?: string[];
  replyUserIds?: string[];
}

export interface ThreadReply extends ThreadMessage {}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function threadKey(id: string): string               { return `thread/${id}`; }
function repliesKey(id: string): string              { return `thread/${id}/replies`; }
function pinnedKey(id: string): string               { return `thread/${id}/pinned`; }
function wsThreadsKey(wsId: string): string          { return `workspace/${wsId}/threads`; }

// ---------------------------------------------------------------------------
// CRUD — Thread
// ---------------------------------------------------------------------------

export async function createThread(
  kv: KVNamespace,
  opts: {
    workspaceId: string;
    channelId: string;
    parentMessageId: string;
    title: string;
    createdBy: string;
    createdByEmail: string;
    initialMessage: string;
    permissions?: Partial<ThreadPermissions>;
  },
): Promise<Thread> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const defaultPermissions: ThreadPermissions = {
    visibleTo: 'all',
    canReply: 'all',
  };

  const thread: Thread = {
    id,
    workspaceId: opts.workspaceId,
    channelId: opts.channelId,
    parentMessageId: opts.parentMessageId,
    title: opts.title,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    permissions: { ...defaultPermissions, ...opts.permissions },
  };

  await kv.put(threadKey(id), JSON.stringify(thread));

  // First message
  const firstMsg: ThreadMessage = {
    id: crypto.randomUUID(),
    userId: opts.createdBy,
    userName: opts.createdByEmail,
    content: opts.initialMessage,
    createdAt: now,
  };
  await kv.put(repliesKey(id), JSON.stringify([firstMsg]));

  // Add to workspace thread index
  await addThreadToWorkspace(kv, opts.workspaceId, id);

  return thread;
}

export async function getThread(kv: KVNamespace, id: string): Promise<Thread | null> {
  const raw = await kv.get(threadKey(id), 'text');
  if (!raw) return null;
  return JSON.parse(raw) as Thread;
}

export async function listThreadsByWorkspace(kv: KVNamespace, workspaceId: string): Promise<Thread[]> {
  const raw = await kv.get(wsThreadsKey(workspaceId), 'text');
  if (!raw) return [];
  const ids: string[] = JSON.parse(raw);
  const results = await Promise.all(ids.map((id) => kv.get(threadKey(id), 'text')));
  return results
    .filter((r): r is string => r !== null)
    .map((r) => JSON.parse(r) as Thread)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function listThreadsByChannel(kv: KVNamespace, workspaceId: string, channelId: string): Promise<Thread[]> {
  const all = await listThreadsByWorkspace(kv, workspaceId);
  return all.filter((t) => t.channelId === channelId);
}

export async function deleteThread(kv: KVNamespace, id: string): Promise<void> {
  const thread = await getThread(kv, id);
  if (!thread) return;

  // Remove from workspace index
  await removeThreadFromWorkspace(kv, thread.workspaceId, id);

  // Delete all thread keys
  const list = await kv.list({ prefix: `thread/${id}` });
  for (const key of list.keys) {
    await kv.delete(key.name);
  }
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

export async function getReplies(kv: KVNamespace, threadId: string): Promise<ThreadReply[]> {
  const raw = await kv.get(repliesKey(threadId), 'text');
  if (!raw) return [];
  return JSON.parse(raw) as ThreadReply[];
}

export async function addReply(
  kv: KVNamespace,
  threadId: string,
  opts: { userId: string; userName: string; content: string },
): Promise<ThreadReply> {
  const replies = await getReplies(kv, threadId);
  const reply: ThreadReply = {
    id: crypto.randomUUID(),
    userId: opts.userId,
    userName: opts.userName,
    content: opts.content,
    createdAt: new Date().toISOString(),
  };
  replies.push(reply);
  await kv.put(repliesKey(threadId), JSON.stringify(replies));

  // Update thread timestamp
  const thread = await getThread(kv, threadId);
  if (thread) {
    thread.updatedAt = new Date().toISOString();
    await kv.put(threadKey(threadId), JSON.stringify(thread));
  }

  return reply;
}

export async function editReply(
  kv: KVNamespace,
  threadId: string,
  replyId: string,
  newContent: string,
): Promise<void> {
  const replies = await getReplies(kv, threadId);
  const reply = replies.find((r) => r.id === replyId);
  if (!reply) throw new Error('Reply not found');
  reply.content = newContent;
  reply.editedAt = new Date().toISOString();
  await kv.put(repliesKey(threadId), JSON.stringify(replies));
}

export async function deleteReply(kv: KVNamespace, threadId: string, replyId: string): Promise<void> {
  const replies = await getReplies(kv, threadId);
  const filtered = replies.filter((r) => r.id !== replyId);
  await kv.put(repliesKey(threadId), JSON.stringify(filtered));
}

// ---------------------------------------------------------------------------
// AI Summary
// ---------------------------------------------------------------------------

export async function generateSummary(
  kv: KVNamespace,
  threadId: string,
  apiKey: string,
): Promise<string> {
  const replies = await getReplies(kv, threadId);
  const thread = await getThread(kv, threadId);
  if (!thread) throw new Error('Thread not found');

  const conversationText = replies
    .map((r) => `${r.userName}: ${r.content}`)
    .join('\n');

  const messages = [
    { role: 'system' as const, content: 'Summarize the following thread concisely in 2-3 sentences. Focus on key decisions and action items.' },
    { role: 'user' as const, content: `Thread: "${thread.title}"\n\n${conversationText}` },
  ];

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.3, max_tokens: 256 }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI summary failed: ${response.status} — ${errText}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const summary = data.choices?.[0]?.message?.content ?? 'Unable to generate summary.';

  // Persist summary on thread
  thread.aiSummary = summary;
  await kv.put(threadKey(threadId), JSON.stringify(thread));

  return summary;
}

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

export async function pinThread(kv: KVNamespace, threadId: string): Promise<void> {
  const thread = await getThread(kv, threadId);
  if (!thread) throw new Error('Thread not found');
  thread.pinned = true;
  await kv.put(threadKey(threadId), JSON.stringify(thread));
  await kv.put(pinnedKey(threadId), '1');
}

export async function unpinThread(kv: KVNamespace, threadId: string): Promise<void> {
  const thread = await getThread(kv, threadId);
  if (!thread) throw new Error('Thread not found');
  thread.pinned = false;
  await kv.put(threadKey(threadId), JSON.stringify(thread));
  await kv.delete(pinnedKey(threadId));
}

export async function listPinnedThreads(kv: KVNamespace, workspaceId: string): Promise<Thread[]> {
  const all = await listThreadsByWorkspace(kv, workspaceId);
  return all.filter((t) => t.pinned);
}

// ---------------------------------------------------------------------------
// Move thread to different channel
// ---------------------------------------------------------------------------

export async function moveThread(kv: KVNamespace, threadId: string, newChannelId: string): Promise<void> {
  const thread = await getThread(kv, threadId);
  if (!thread) throw new Error('Thread not found');
  thread.channelId = newChannelId;
  thread.updatedAt = new Date().toISOString();
  await kv.put(threadKey(threadId), JSON.stringify(thread));
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function updatePermissions(
  kv: KVNamespace,
  threadId: string,
  permissions: Partial<ThreadPermissions>,
): Promise<void> {
  const thread = await getThread(kv, threadId);
  if (!thread) throw new Error('Thread not found');
  thread.permissions = { ...thread.permissions, ...permissions };
  await kv.put(threadKey(threadId), JSON.stringify(thread));
}

export function canViewThread(thread: Thread, userId: string, userRole: string): boolean {
  const p = thread.permissions;
  if (p.visibleTo === 'all') return true;
  if (p.visibleTo === 'roles' && p.roles?.includes(userRole)) return true;
  if (p.visibleTo === 'users' && p.userIds?.includes(userId)) return true;
  return false;
}

export function canReplyToThread(thread: Thread, userId: string, userRole: string): boolean {
  const p = thread.permissions;
  if (p.canReply === 'all') return true;
  if (p.canReply === 'roles' && p.replyRoles?.includes(userRole)) return true;
  if (p.canReply === 'users' && p.replyUserIds?.includes(userId)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function addThreadToWorkspace(kv: KVNamespace, workspaceId: string, threadId: string): Promise<void> {
  const raw = await kv.get(wsThreadsKey(workspaceId), 'text');
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(threadId)) {
    ids.push(threadId);
    await kv.put(wsThreadsKey(workspaceId), JSON.stringify(ids));
  }
}

async function removeThreadFromWorkspace(kv: KVNamespace, workspaceId: string, threadId: string): Promise<void> {
  const raw = await kv.get(wsThreadsKey(workspaceId), 'text');
  if (!raw) return;
  const ids: string[] = JSON.parse(raw);
  const filtered = ids.filter((id) => id !== threadId);
  await kv.put(wsThreadsKey(workspaceId), JSON.stringify(filtered));
}
