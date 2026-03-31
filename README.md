# BusinessLog AI

> Your Business AI. Self-Hosted. Private. Powerful.

Deploy your company brain in minutes. Docker or Cloudflare.

## Why BusinessLog AI?

Your team's knowledge lives in Slack threads, email chains, and meeting notes. BusinessLog AI gives you an agent that remembers everything, organizes it, and makes it instantly accessible to your whole team.

**What makes it different:**
- **Self-hosted** — Your data never leaves your infrastructure
- **Docker-first** — Sandboxed deployment, isolated from your host system
- **Multi-user** — Role-based access for teams
- **Multi-channel** — Web, Telegram, Discord, WhatsApp
- **Analytics** — See how your team uses the agent
- **A2A Protocol** — Connect to other business systems

## Quick Start (Docker)

```bash
# 1. Clone
git clone https://github.com/CedarBeach2019/businesslog-ai.git
cd businesslog-ai

# 2. Configure
cp docker/.env.example docker/.env
# Edit docker/.env — set DEEPSEEK_API_KEY, JWT_SECRET, ADMIN_EMAIL

# 3. Run
docker compose -f docker/docker-compose.yml up -d
```

Open `http://localhost:3000` — register your admin account and start chatting.

## Alternative: Cloudflare Workers

```bash
# 1. Clone and install
git clone https://github.com/CedarBeach2019/businesslog-ai.git
cd businesslog-ai && npm install

# 2. Configure
cp wrangler.toml wrangler.toml.local
# Edit wrangler.toml.local — set KV namespace IDs and D1 database ID

# 3. Set secrets
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_EMAIL

# 4. Deploy
npm run deploy
```

## Features

### Multi-User with Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Manage users, analytics, channels, exports |
| **Member** | Chat, upload files, view shared context |
| **Viewer** | Read summaries and reports only |

First user to register becomes admin automatically.

### Analytics Dashboard

- Messages per day / week / month
- Active user trends
- Top conversation topics
- Channel breakdown
- Export reports as CSV

### Multi-Channel

Connect the agent where your team works:

| Channel | Setup |
|---------|-------|
| **Web** | Built-in, always on |
| **Telegram** | Bot token from @BotFather |
| **Discord** | Bot from Developer Portal |
| **WhatsApp** | Business API account |

See [template/channels.md](template/channels.md) for setup guides.

### Agent-to-Agent (A2A)

Connect BusinessLog AI to your other business systems using the A2A protocol:

```json
{
  "from": "businesslog-ai",
  "to": "your-crm",
  "type": "query",
  "payload": { "question": "What were last quarter's deals?" }
}
```

## API Reference

### Authentication

```
POST /api/auth/register    { email, password, name }    → { token, user }
POST /api/auth/login       { email, password }          → { token, user }
```

### Chat

```
POST /api/chat             { message, conversationId? }  → SSE stream
```

### Files

```
POST /api/files            multipart/form-data           → { url, filename, size }
GET  /api/files/:id                                      → { metadata }
GET  /api/files/:id/content                              → file content
```

### Team Management (Admin)

```
GET    /api/users                                        → User[]
PUT    /api/users/:id/role   { role }                    → { success }
DELETE /api/users/:id                                     → { success }
```

### Analytics (Admin/Member)

```
GET /api/analytics/dashboard                             → DashboardData
GET /api/analytics/report?type=daily&format=csv          → Report
```

### Channels

```
POST /api/channels/telegram    → Telegram webhook handler
POST /api/channels/discord     → Discord webhook handler
POST /api/channels/whatsapp    → WhatsApp webhook handler
GET  /api/channels/whatsapp    → WhatsApp verification
```

## Security & Compliance

- **Docker sandboxing** — Agent, memory, and API keys isolated from host
- **Role-based access** — Users only see what their role permits
- **JWT authentication** — Secure token-based auth with 7-day expiry
- **No external data sharing** — Everything stays in your deployment
- **Audit trail** — All actions logged in analytics

## Architecture

```
BusinessLog AI
├── Cloudflare Worker (or Docker + Wrangler)
│   ├── REST API (Hono)
│   ├── Agent (DeepSeek-powered)
│   ├── Memory (KV / D1)
│   └── Channel connectors
├── Web App (static HTML/JS)
│   ├── Messenger interface
│   └── Admin dashboard
└── Docker (optional)
    ├── Multi-stage build
    └── Volume persistence
```

## Development

```bash
npm install
npm run dev          # Start local dev server
npm run build        # Type check
```

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT — see [LICENSE](LICENSE).
