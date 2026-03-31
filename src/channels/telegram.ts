export interface TelegramMessage {
  update_id: number;
  message: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    document?: { file_id: string; file_name: string };
  };
}

function validateTelegramRequest(body: string, botToken: string, hash: string): boolean {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(botToken);
  const key = crypto.subtle.importKeySync('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = crypto.subtle.signSync('HMAC', key, encoder.encode(body));
  const computed = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return computed === hash;
}

function parseTelegramMessage(
  update: unknown
): { userId: string; text: string; chatId: string; attachments?: Array<{ fileId: string; fileName: string }> } | null {
  if (!update || typeof update !== 'object') return null;
  const msg = update as TelegramMessage;

  if (!msg.message || !msg.message.from || !msg.message.chat) return null;

  const result: {
    userId: string;
    text: string;
    chatId: string;
    attachments?: Array<{ fileId: string; fileName: string }>;
  } = {
    userId: String(msg.message.from.id),
    text: msg.message.text ?? '',
    chatId: String(msg.message.chat.id),
  };

  if (msg.message.document) {
    result.attachments = [
      { fileId: msg.message.document.file_id, fileName: msg.message.document.file_name },
    ];
  }

  return result;
}

function formatTelegramResponse(
  text: string,
  chatId: string
): { method: string; chat_id: string; text: string; parse_mode: string } {
  return {
    method: 'sendMessage',
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  };
}

async function handleTelegramWebhook(update: unknown, botToken: string): Promise<Response> {
  const parsed = parseTelegramMessage(update);
  if (!parsed) {
    return new Response(JSON.stringify({ ok: false }), { status: 400 });
  }

  const response = formatTelegramResponse('Message received.', parsed.chatId);
  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export {
  validateTelegramRequest,
  parseTelegramMessage,
  formatTelegramResponse,
  handleTelegramWebhook,
};
