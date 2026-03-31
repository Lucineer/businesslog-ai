function validateDiscordRequest(
  body: string,
  publicKey: string,
  signature: string,
  timestamp: string
): boolean {
  const encoder = new TextEncoder();
  const message = encoder.encode(timestamp + body);
  const keyBytes = new Uint8Array(publicKey.match(/.{2}/g)?.map((hex) => parseInt(hex, 16)) ?? []);

  const key = crypto.subtle.importKeySync(
    'raw',
    keyBytes,
    { name: 'Ed25519' },
    false,
    ['verify']
  );

  const sigBytes = new Uint8Array(signature.match(/.{2}/g)?.map((hex) => parseInt(hex, 16)) ?? []);
  return crypto.subtle.verifySync('Ed25519', key, sigBytes, message);
}

function parseDiscordInteraction(
  body: unknown
): { userId: string; text: string; channelId: string; guildId: string } | null {
  if (!body || typeof body !== 'object') return null;
  const interaction = body as Record<string, unknown>;

  const data = interaction.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const user = interaction.member
    ? ((interaction.member as Record<string, unknown>).user as Record<string, unknown>)
    : (interaction.user as Record<string, unknown> | undefined);

  if (!user) return null;

  return {
    userId: String(user.id ?? ''),
    text: String(data.name ?? data.content ?? ''),
    channelId: String(interaction.channel_id ?? ''),
    guildId: String(interaction.guild_id ?? ''),
  };
}

function formatDiscordResponse(
  text: string,
  ephemeral: boolean = false
): { type: number; data: { content: string; flags?: number } } {
  return {
    type: 4,
    data: {
      content: text,
      ...(ephemeral ? { flags: 64 } : {}),
    },
  };
}

async function handleDiscordWebhook(body: unknown, publicKey: string): Promise<Response> {
  const bodyStr = JSON.stringify(body);

  // Ping handling
  const interaction = body as Record<string, unknown>;
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsed = parseDiscordInteraction(body);
  if (!parsed) {
    return new Response(JSON.stringify({ error: 'Invalid interaction' }), { status: 400 });
  }

  const response = formatDiscordResponse('Message received.');
  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export {
  validateDiscordRequest,
  parseDiscordInteraction,
  formatDiscordResponse,
  handleDiscordWebhook,
};
