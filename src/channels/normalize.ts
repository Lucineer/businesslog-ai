export interface NormalizedMessage {
  userId: string;
  userName: string;
  text: string;
  channel: 'web' | 'telegram' | 'discord' | 'whatsapp';
  channelUserId: string;
  attachments: Array<{ id: string; name: string; type: string; url?: string }>;
  timestamp: string;
  raw: unknown;
}

import { parseTelegramMessage } from './telegram.js';
import { parseDiscordInteraction } from './discord.js';
import { parseWhatsAppMessage } from './whatsapp.js';

function normalizeMessage(channel: string, raw: unknown): NormalizedMessage | null {
  const timestamp = new Date().toISOString();

  switch (channel) {
    case 'telegram': {
      const parsed = parseTelegramMessage(raw);
      if (!parsed) return null;
      return {
        userId: parsed.userId,
        userName: '',
        text: parsed.text,
        channel: 'telegram',
        channelUserId: parsed.userId,
        attachments: (parsed.attachments ?? []).map((a) => ({
          id: a.fileId,
          name: a.fileName,
          type: 'file',
        })),
        timestamp,
        raw,
      };
    }

    case 'discord': {
      const parsed = parseDiscordInteraction(raw);
      if (!parsed) return null;
      return {
        userId: parsed.userId,
        userName: '',
        text: parsed.text,
        channel: 'discord',
        channelUserId: parsed.userId,
        attachments: [],
        timestamp,
        raw,
      };
    }

    case 'whatsapp': {
      const parsed = parseWhatsAppMessage(raw);
      if (!parsed) return null;
      return {
        userId: parsed.phone,
        userName: '',
        text: parsed.text,
        channel: 'whatsapp',
        channelUserId: parsed.phone,
        attachments: (parsed.attachments ?? []).map((a) => ({
          id: '',
          name: '',
          type: a.type,
          url: a.url,
        })),
        timestamp,
        raw,
      };
    }

    case 'web': {
      if (!raw || typeof raw !== 'object') return null;
      const body = raw as Record<string, unknown>;
      return {
        userId: String(body.userId ?? ''),
        userName: String(body.userName ?? ''),
        text: String(body.text ?? ''),
        channel: 'web',
        channelUserId: String(body.userId ?? ''),
        attachments: Array.isArray(body.attachments) ? (body.attachments as Array<{ id: string; name: string; type: string; url?: string }>) : [],
        timestamp,
        raw,
      };
    }

    default:
      return null;
  }
}

function normalizeResponse(text: string, channel: string): Record<string, unknown> {
  switch (channel) {
    case 'telegram':
      return { method: 'sendMessage', text, parse_mode: 'Markdown' };
    case 'discord':
      return { type: 4, data: { content: text } };
    case 'whatsapp':
      return { messaging_product: 'whatsapp', type: 'text', text: { body: text } };
    case 'web':
    default:
      return { text };
  }
}

function detectChannel(request: Request): string {
  const url = new URL(request.url);
  const path = url.pathname.toLowerCase();

  if (path.includes('telegram')) return 'telegram';
  if (path.includes('discord')) return 'discord';
  if (path.includes('whatsapp')) return 'whatsapp';

  // Fallback: check headers
  const userAgent = request.headers.get('User-Agent') ?? '';
  if (userAgent.includes('TelegramBot')) return 'telegram';
  if (userAgent.includes('Discord')) return 'discord';

  return 'web';
}

export { normalizeMessage, normalizeResponse, detectChannel };
