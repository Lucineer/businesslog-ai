/**
 * webhooks.ts — Outbound webhooks with HMAC-SHA256 signing, delivery log,
 * retry logic, and test delivery.
 *
 * KV key layout:
 *   webhook/{id}                    — webhook config (JSON)
 *   webhook/index                   — list of webhook IDs (JSON array)
 *   webhook/{id}/deliveries/{did}   — delivery records (JSON)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebhookEvent =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'user.joined'
  | 'user.removed'
  | 'user.role_changed'
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.deleted'
  | 'member.invited'
  | 'member.joined'
  | 'member.removed';

export interface WebhookConfig {
  id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  description: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  statusCode: number;
  response: string;
  success: boolean;
  attempts: number;
  createdAt: string;
  deliveredAt?: string;
  nextRetryAt?: string;
}

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function webhookKey(id: string): string                  { return `webhook/${id}`; }
function webhookIndexKey(): string                       { return `webhook/index`; }
function deliveryKey(whId: string, dId: string): string  { return `webhook/${whId}/deliveries/${dId}`; }
function deliveriesPrefix(whId: string): string          { return `webhook/${whId}/deliveries/`; }

// ---------------------------------------------------------------------------
// CRUD — Webhook
// ---------------------------------------------------------------------------

export async function createWebhook(
  kv: KVNamespace,
  opts: {
    url: string;
    events: WebhookEvent[];
    description: string;
    createdBy: string;
  },
): Promise<WebhookConfig> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const secret = crypto.randomUUID().replace(/-/g, '');

  const config: WebhookConfig = {
    id,
    url: opts.url,
    secret,
    events: opts.events,
    description: opts.description,
    active: true,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  await kv.put(webhookKey(id), JSON.stringify(config));

  // Add to index
  const raw = await kv.get(webhookIndexKey(), 'text');
  const ids: string[] = raw ? JSON.parse(raw) : [];
  ids.push(id);
  await kv.put(webhookIndexKey(), JSON.stringify(ids));

  return config;
}

export async function getWebhook(kv: KVNamespace, id: string): Promise<WebhookConfig | null> {
  const raw = await kv.get(webhookKey(id), 'text');
  if (!raw) return null;
  return JSON.parse(raw) as WebhookConfig;
}

export async function listWebhooks(kv: KVNamespace): Promise<WebhookConfig[]> {
  const raw = await kv.get(webhookIndexKey(), 'text');
  if (!raw) return [];
  const ids: string[] = JSON.parse(raw);
  const results = await Promise.all(ids.map((id) => kv.get(webhookKey(id), 'text')));
  return results.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as WebhookConfig);
}

export async function updateWebhook(
  kv: KVNamespace,
  id: string,
  updates: Partial<Pick<WebhookConfig, 'url' | 'events' | 'description' | 'active'>>,
): Promise<WebhookConfig | null> {
  const config = await getWebhook(kv, id);
  if (!config) return null;
  Object.assign(config, updates, { updatedAt: new Date().toISOString() });
  await kv.put(webhookKey(id), JSON.stringify(config));
  return config;
}

export async function deleteWebhook(kv: KVNamespace, id: string): Promise<void> {
  // Remove from index
  const raw = await kv.get(webhookIndexKey(), 'text');
  if (raw) {
    const ids: string[] = JSON.parse(raw);
    const filtered = ids.filter((wid) => wid !== id);
    await kv.put(webhookIndexKey(), JSON.stringify(filtered));
  }

  // Delete webhook and deliveries
  const list = await kv.list({ prefix: `webhook/${id}` });
  for (const key of list.keys) {
    await kv.delete(key.name);
  }
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signing
// ---------------------------------------------------------------------------

export async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export async function deliverWebhook(
  kv: KVNamespace,
  webhookId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<WebhookDelivery> {
  const config = await getWebhook(kv, webhookId);
  if (!config) throw new Error('Webhook not found');
  if (!config.active) throw new Error('Webhook is inactive');
  if (!config.events.includes(event)) throw new Error(`Webhook does not subscribe to ${event}`);

  const deliveryId = crypto.randomUUID();
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  const payloadStr = JSON.stringify(payload);
  const signature = await signPayload(payloadStr, config.secret);

  let statusCode = 0;
  let responseBody = '';
  let success = false;

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': event,
        'X-Webhook-Delivery': deliveryId,
        'User-Agent': 'BusinessLog-Webhook/1.0',
      },
      body: payloadStr,
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    statusCode = response.status;
    responseBody = await response.text().catch(() => '');
    success = statusCode >= 200 && statusCode < 300;
  } catch (err) {
    statusCode = 0;
    responseBody = (err as Error).message;
    success = false;
  }

  const delivery: WebhookDelivery = {
    id: deliveryId,
    webhookId,
    event,
    payload: payload as unknown as Record<string, unknown>,
    statusCode,
    response: responseBody.slice(0, 1000),
    success,
    attempts: 1,
    createdAt: new Date().toISOString(),
    deliveredAt: success ? new Date().toISOString() : undefined,
    nextRetryAt: success ? undefined : new Date(Date.now() + 60 * 1000).toISOString(), // retry in 1 min
  };

  await kv.put(deliveryKey(webhookId, deliveryId), JSON.stringify(delivery));

  return delivery;
}

// ---------------------------------------------------------------------------
// Retry failed deliveries
// ---------------------------------------------------------------------------

export async function retryDelivery(kv: KVNamespace, webhookId: string, deliveryId: string): Promise<WebhookDelivery> {
  const raw = await kv.get(deliveryKey(webhookId, deliveryId), 'text');
  if (!raw) throw new Error('Delivery not found');

  const delivery = JSON.parse(raw) as WebhookDelivery;
  if (delivery.success) throw new Error('Delivery already succeeded');

  const config = await getWebhook(kv, webhookId);
  if (!config) throw new Error('Webhook not found');

  const payloadStr = JSON.stringify(delivery.payload);
  const signature = await signPayload(payloadStr, config.secret);

  let statusCode = 0;
  let responseBody = '';
  let success = false;

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': delivery.event,
        'X-Webhook-Delivery': deliveryId,
        'X-Webhook-Retry': String(delivery.attempts + 1),
        'User-Agent': 'BusinessLog-Webhook/1.0',
      },
      body: payloadStr,
      signal: AbortSignal.timeout(10000),
    });

    statusCode = response.status;
    responseBody = await response.text().catch(() => '');
    success = statusCode >= 200 && statusCode < 300;
  } catch (err) {
    statusCode = 0;
    responseBody = (err as Error).message;
    success = false;
  }

  delivery.statusCode = statusCode;
  delivery.response = responseBody.slice(0, 1000);
  delivery.success = success;
  delivery.attempts++;
  delivery.deliveredAt = success ? new Date().toISOString() : undefined;
  delivery.nextRetryAt = success ? undefined : new Date(Date.now() + Math.min(delivery.attempts * 60 * 1000, 15 * 60 * 1000)).toISOString();

  await kv.put(deliveryKey(webhookId, deliveryId), JSON.stringify(delivery));

  return delivery;
}

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

export async function getDeliveryLog(kv: KVNamespace, webhookId: string, limit: number = 50): Promise<WebhookDelivery[]> {
  const list = await kv.list({ prefix: deliveriesPrefix(webhookId) });
  const deliveries: WebhookDelivery[] = [];

  for (const key of list.keys) {
    const raw = await kv.get(key.name, 'text');
    if (raw) deliveries.push(JSON.parse(raw) as WebhookDelivery);
  }

  return deliveries
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Test delivery
// ---------------------------------------------------------------------------

export async function testWebhook(kv: KVNamespace, webhookId: string): Promise<WebhookDelivery> {
  return deliverWebhook(kv, webhookId, 'message.created', {
    test: true,
    message: 'This is a test webhook delivery from BusinessLog AI.',
  });
}

// ---------------------------------------------------------------------------
// Broadcast event to all matching webhooks
// ---------------------------------------------------------------------------

export async function broadcastEvent(
  kv: KVNamespace,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<WebhookDelivery[]> {
  const webhooks = await listWebhooks(kv);
  const matching = webhooks.filter((w) => w.active && w.events.includes(event));

  const deliveries = await Promise.allSettled(
    matching.map((w) => deliverWebhook(kv, w.id, event, data)),
  );

  return deliveries
    .filter((r): r is PromiseFulfilledResult<WebhookDelivery> => r.status === 'fulfilled')
    .map((r) => r.value);
}
