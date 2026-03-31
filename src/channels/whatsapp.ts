function validateWhatsAppRequest(
  body: string,
  verifyToken: string,
  signature: string
): boolean {
  const encoder = new TextEncoder();
  const key = crypto.subtle.importKeySync(
    'raw',
    encoder.encode(verifyToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const computed = crypto.subtle.signSync('HMAC', key, encoder.encode(body));
  const computedHex = Array.from(new Uint8Array(computed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${computedHex}` === signature;
}

function parseWhatsAppMessage(
  body: unknown
): { phone: string; text: string; messageId: string; attachments?: Array<{ url: string; type: string }> } | null {
  if (!body || typeof body !== 'object') return null;
  const wrapper = body as Record<string, unknown>;
  const entry = (wrapper.entry as Array<Record<string, unknown>>)?.[0];
  if (!entry) return null;

  const changes = (entry.changes as Array<Record<string, unknown>>)?.[0];
  if (!changes) return null;

  const value = changes.value as Record<string, unknown> | undefined;
  if (!value) return null;

  const messages = (value.messages as Array<Record<string, unknown>>)?.[0];
  if (!messages) return null;

  const phone = String(messages.from ?? '');
  const messageId = String(messages.id ?? '');
  const textObj = messages.text as Record<string, unknown> | undefined;
  const text = textObj ? String(textObj.body ?? '') : '';

  const result: {
    phone: string;
    text: string;
    messageId: string;
    attachments?: Array<{ url: string; type: string }>;
  } = { phone, text, messageId };

  const image = messages.image as Record<string, unknown> | undefined;
  const document = messages.document as Record<string, unknown> | undefined;

  if (image) {
    result.attachments = [{ url: String(image.id ?? ''), type: 'image' }];
  } else if (document) {
    result.attachments = [{ url: String(document.id ?? ''), type: 'document' }];
  }

  return result;
}

function formatWhatsAppResponse(
  text: string,
  to: string
): { messaging_product: string; to: string; type: string; text: { body: string } } {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };
}

function verifyWhatsAppWebhook(params: URLSearchParams, verifyToken: string): Response {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    return new Response(challenge, { status: 200 });
  }

  return new Response('Forbidden', { status: 403 });
}

async function handleWhatsAppWebhook(body: unknown, verifyToken: string): Promise<Response> {
  const parsed = parseWhatsAppMessage(body);
  if (!parsed) {
    return new Response(JSON.stringify({ error: 'Invalid message' }), { status: 400 });
  }

  const response = formatWhatsAppResponse('Message received.', parsed.phone);
  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export {
  validateWhatsAppRequest,
  parseWhatsAppMessage,
  formatWhatsAppResponse,
  verifyWhatsAppWebhook,
  handleWhatsAppWebhook,
};
