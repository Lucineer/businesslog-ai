/**
 * dashboard.ts — Analytics dashboard with message metrics, topic extraction,
 * team activity, response times, token usage, and CSV/PDF export.
 *
 * KV key layout (extends existing analytics keys):
 *   analytics:tokens:{day}         — daily token usage (JSON)
 *   analytics:cost:{day}           — daily cost in USD cents (string)
 *   analytics:response:{day}       — response time samples (JSON array)
 *   analytics:topics:{topic}       — topic mention counter (string)
 *   analytics:team:activity:{uid}  — per-user activity summary (JSON)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DailyMetrics {
  date: string;
  messages: number;
  uploads: number;
  activeUsers: number;
  tokenUsage: TokenUsage;
  costCents: number;
  avgResponseMs: number;
}

export interface TopicEntry {
  topic: string;
  count: number;
}

export interface TeamActivityEntry {
  userId: string;
  userName: string;
  messagesCount: number;
  lastActive: string;
  status: 'active' | 'inactive';
}

export interface DashboardReport {
  period: { from: string; to: string };
  totalMessages: number;
  totalUploads: number;
  totalActiveUsers: number;
  totalTokens: number;
  totalCostCents: number;
  avgResponseMs: number;
  messagesPerDay: Array<{ date: string; count: number }>;
  topTopics: TopicEntry[];
  teamActivity: TeamActivityEntry[];
  dailyMetrics: DailyMetrics[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

// ---------------------------------------------------------------------------
// Token & cost tracking
// ---------------------------------------------------------------------------

export async function recordTokenUsage(
  kv: KVNamespace,
  day: string,
  prompt: number,
  completion: number,
  costCents: number,
): Promise<void> {
  const key = `analytics:tokens:${day}`;
  const raw = await kv.get(key, 'text');
  const current: TokenUsage = raw ? JSON.parse(raw) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  current.promptTokens += prompt;
  current.completionTokens += completion;
  current.totalTokens += prompt + completion;
  await kv.put(key, JSON.stringify(current));

  const costKey = `analytics:cost:${day}`;
  const currentCost = parseInt((await kv.get(costKey)) || '0', 10);
  await kv.put(costKey, String(currentCost + costCents));
}

export async function recordResponseTime(kv: KVNamespace, day: string, ms: number): Promise<void> {
  const key = `analytics:response:${day}`;
  const raw = await kv.get(key, 'text');
  const samples: number[] = raw ? JSON.parse(raw) : [];
  samples.push(ms);
  // Keep last 1000 samples per day
  const trimmed = samples.slice(-1000);
  await kv.put(key, JSON.stringify(trimmed));
}

// ---------------------------------------------------------------------------
// Message/day metrics
// ---------------------------------------------------------------------------

export async function getMessagesPerDay(kv: KVNamespace, days: number): Promise<Array<{ date: string; count: number }>> {
  const result: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = daysAgo(i);
    const key = `events:${day}:chat:message`;
    const count = parseInt((await kv.get(key)) || '0', 10);
    result.push({ date: day, count });
  }
  return result;
}

export async function getUploadsPerDay(kv: KVNamespace, days: number): Promise<Array<{ date: string; count: number }>> {
  const result: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = daysAgo(i);
    const key = `events:${day}:file:upload`;
    const count = parseInt((await kv.get(key)) || '0', 10);
    result.push({ date: day, count });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

export async function getTopTopics(kv: KVNamespace, limit: number = 10): Promise<TopicEntry[]> {
  const list = await kv.list({ prefix: 'analytics:topics:' });
  const topics: TopicEntry[] = [];
  for (const key of list.keys) {
    const topic = key.name.replace('analytics:topics:', '');
    const count = parseInt((await kv.get(key.name)) || '0', 10);
    topics.push({ topic, count });
  }
  return topics.sort((a, b) => b.count - a.count).slice(0, limit);
}

export async function recordTopic(kv: KVNamespace, topic: string): Promise<void> {
  const key = `analytics:topics:${topic.toLowerCase()}`;
  const current = parseInt((await kv.get(key)) || '0', 10);
  await kv.put(key, String(current + 1));
}

// ---------------------------------------------------------------------------
// Team activity
// ---------------------------------------------------------------------------

export async function getTeamActivity(
  kv: KVNamespace,
  db: D1Database,
  inactiveThresholdDays: number = 7,
): Promise<TeamActivityEntry[]> {
  const { results } = await db
    .prepare('SELECT id, email, name FROM users ORDER BY name ASC')
    .all<{ id: string; email: string; name: string }>();

  const entries: TeamActivityEntry[] = [];
  const cutoff = new Date(Date.now() - inactiveThresholdDays * 24 * 60 * 60 * 1000).toISOString();

  for (const user of results) {
    const activityKey = `analytics:team:activity:${user.id}`;
    const raw = await kv.get(activityKey, 'text');
    const activity: { messagesCount: number; lastActive: string } = raw
      ? JSON.parse(raw)
      : { messagesCount: 0, lastActive: '' };

    entries.push({
      userId: user.id,
      userName: user.name,
      messagesCount: activity.messagesCount,
      lastActive: activity.lastActive,
      status: activity.lastActive && activity.lastActive > cutoff ? 'active' : 'inactive',
    });
  }

  return entries;
}

export async function updateUserActivity(kv: KVNamespace, userId: string): Promise<void> {
  const key = `analytics:team:activity:${userId}`;
  const raw = await kv.get(key, 'text');
  const activity: { messagesCount: number; lastActive: string } = raw
    ? JSON.parse(raw)
    : { messagesCount: 0, lastActive: '' };
  activity.messagesCount++;
  activity.lastActive = new Date().toISOString();
  await kv.put(key, JSON.stringify(activity));
}

// ---------------------------------------------------------------------------
// Full dashboard report
// ---------------------------------------------------------------------------

export async function getDashboard(kv: KVNamespace, db: D1Database, days: number = 30): Promise<DashboardReport> {
  const from = daysAgo(days - 1);
  const to = dateStr(new Date());

  const [messagesPerDay, uploadsPerDay, topTopics, teamActivity] = await Promise.all([
    getMessagesPerDay(kv, days),
    getUploadsPerDay(kv, days),
    getTopTopics(kv, 20),
    getTeamActivity(kv, db),
  ]);

  let totalMessages = 0;
  let totalUploads = 0;
  let totalTokens = 0;
  let totalCostCents = 0;
  let totalResponseMs = 0;
  let responseSamples = 0;

  const dailyMetrics: DailyMetrics[] = [];

  for (let i = 0; i < days; i++) {
    const day = daysAgo(days - 1 - i);
    const messages = messagesPerDay[i]?.count ?? 0;
    const uploads = uploadsPerDay[i]?.count ?? 0;

    // Active users for this day
    const activeList = await kv.list({ prefix: `active:${day}:` });
    const activeUsers = activeList.keys.length;

    // Token usage
    const tokenRaw = await kv.get(`analytics:tokens:${day}`, 'text');
    const tokenUsage: TokenUsage = tokenRaw ? JSON.parse(tokenRaw) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // Cost
    const costCents = parseInt((await kv.get(`analytics:cost:${day}`)) || '0', 10);

    // Response time
    const responseRaw = await kv.get(`analytics:response:${day}`, 'text');
    const daySamples: number[] = responseRaw ? JSON.parse(responseRaw) : [];
    const avgResponseMs = daySamples.length > 0
      ? daySamples.reduce((a, b) => a + b, 0) / daySamples.length
      : 0;

    totalMessages += messages;
    totalUploads += uploads;
    totalTokens += tokenUsage.totalTokens;
    totalCostCents += costCents;
    if (avgResponseMs > 0) {
      totalResponseMs += avgResponseMs;
      responseSamples++;
    }

    dailyMetrics.push({ date: day, messages, uploads, activeUsers, tokenUsage, costCents, avgResponseMs: Math.round(avgResponseMs) });
  }

  return {
    period: { from, to },
    totalMessages,
    totalUploads,
    totalActiveUsers: teamActivity.filter((t) => t.status === 'active').length,
    totalTokens,
    totalCostCents,
    avgResponseMs: responseSamples > 0 ? Math.round(totalResponseMs / responseSamples) : 0,
    messagesPerDay,
    topTopics,
    teamActivity,
    dailyMetrics,
  };
}

// ---------------------------------------------------------------------------
// Export — CSV
// ---------------------------------------------------------------------------

export function exportToCSV(report: DashboardReport): string {
  const headers = ['date', 'messages', 'uploads', 'activeUsers', 'totalTokens', 'costCents', 'avgResponseMs'];
  const rows = report.dailyMetrics.map((d) =>
    [d.date, d.messages, d.uploads, d.activeUsers, d.tokenUsage.totalTokens, d.costCents, d.avgResponseMs].join(','),
  );
  return [headers.join(','), ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Export — PDF (text-based, suitable for generation client-side)
// ---------------------------------------------------------------------------

export function exportToPDFText(report: DashboardReport): string {
  const lines: string[] = [
    'BUSINESSLOG AI — ANALYTICS REPORT',
    '==================================',
    `Period: ${report.period.from} to ${report.period.to}`,
    '',
    'SUMMARY',
    '-------',
    `Total Messages:   ${report.totalMessages}`,
    `Total Uploads:    ${report.totalUploads}`,
    `Active Users:     ${report.totalActiveUsers}`,
    `Total Tokens:     ${report.totalTokens}`,
    `Estimated Cost:   $${(report.totalCostCents / 100).toFixed(2)}`,
    `Avg Response:     ${report.avgResponseMs}ms`,
    '',
    'TOP TOPICS',
    '----------',
    ...report.topTopics.map((t) => `  ${t.topic}: ${t.count}`),
    '',
    'TEAM ACTIVITY',
    '-------------',
    ...report.teamActivity.map((t) => `  ${t.userName} (${t.status}): ${t.messagesCount} messages, last active ${t.lastActive || 'never'}`),
    '',
    'DAILY BREAKDOWN',
    '---------------',
    ...report.dailyMetrics.map((d) =>
      `  ${d.date}: ${d.messages} msgs, ${d.uploads} uploads, ${d.activeUsers} users, ${d.tokenUsage.totalTokens} tokens, $${(d.costCents / 100).toFixed(2)}`,
    ),
  ];
  return lines.join('\n');
}
