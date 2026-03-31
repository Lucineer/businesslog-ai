# Channel Setup — BusinessLog AI

## Web (Built-in)

The web messenger is always available at `/app`. No configuration needed.

## Telegram

1. Create a bot via [@BotFather](https://t.me/botfather)
2. Get your bot token
3. Set environment variable: `TELEGRAM_BOT_TOKEN=your_token`
4. Set webhook: `POST https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://your-domain.com/api/channels/telegram`

**Environment variables:**
```
TELEGRAM_BOT_TOKEN=your_bot_token
```

## Discord

1. Create an application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a bot and get the public key
3. Set the interactions endpoint URL to `https://your-domain.com/api/channels/discord`
4. Install the bot to your server

**Environment variables:**
```
DISCORD_PUBLIC_KEY=your_public_key
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_APPLICATION_ID=your_app_id
```

## WhatsApp Business

1. Set up a [WhatsApp Business API](https://developers.facebook.com/docs/whatsapp/cloud-api) account
2. Configure your phone number and verify token
3. Set webhook to `https://your-domain.com/api/channels/whatsapp`

**Environment variables:**
```
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_ACCESS_TOKEN=your_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
```

## Adding Custom Channels

Channels follow a normalize pattern:

1. Create a parser for incoming messages
2. Create a formatter for outgoing responses
3. Register in `src/channels/normalize.ts`
4. Add webhook route in `src/worker.ts`

All channels produce `NormalizedMessage` objects that the agent processes identically.
