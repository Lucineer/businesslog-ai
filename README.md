# BusinessLog AI

> Your business AI. Self-hosted. Private. Powerful.

Deploy your company brain in minutes. No vendor lock-in. No data leaks. No compromises.

---

## What Can It Do?

### Customer Support
Instantly answer customer questions using your own knowledge base. Your team trains the AI by chatting with it -- no setup wizards, no complex configs.

### Meeting Notes & Action Items
Drop your meeting transcripts into the chat. BusinessLog AI extracts action items, decisions, and follow-ups automatically.

### Team Onboarding
New hires ask questions, the AI answers from your team's accumulated knowledge. Everyone stays on the same page.

### Document Analysis
Upload reports, contracts, and spreadsheets. Get summaries, key findings, and data-driven recommendations.

---

## Quick Start (Docker)

The fastest way to get running:

```bash
# 1. Clone
git clone https://github.com/Lucineer/businesslog-ai.git
cd businesslog-ai

# 2. Configure
cp docker/.env.example docker/.env
# Edit docker/.env — set DEEPSEEK_API_KEY, JWT_SECRET, ADMIN_EMAIL

# 3. Launch
docker compose -f docker/docker-compose.yml up -d
```

Open `http://localhost:3000` -- register your admin account and start chatting.

That's it. Your AI is running inside a sandboxed Docker container. Your data never leaves your machine.

---

## Team Setup Guide

### Step 1: Register as Admin
The first person to create an account automatically becomes the team admin.

### Step 2: Invite Your Team
Click **Admin Panel** in the top bar, then **+ Invite**. Enter your colleague's email and assign a role:

| Role | What They Can Do |
|------|------------------|
| **Admin** | Manage users, view analytics, export data, configure channels |
| **Member** | Chat, upload files, view shared context |
| **Viewer** | Read summaries and reports only |

### Step 3: Connect Channels
Your team can access the AI from multiple platforms:

| Channel | Setup Time |
|---------|-----------|
| **Web** | Built-in, always on |
| **Telegram** | Bot token from @BotFather |
| **Discord** | Bot from Developer Portal |
| **WhatsApp** | Business API account |

See [template/channels.md](template/channels.md) for step-by-step guides.

### Step 4: Start Working
Ask questions, upload documents, and let the AI learn your business context over time.

---

## Analytics Features

Track how your team uses AI with built-in analytics:

- **Messages per day** -- See adoption trends across your team
- **Active users** -- Know who's getting value from the tool
- **Top topics** -- Understand what your team needs help with most
- **Response times** -- Monitor AI performance

Access analytics from the **Admin Panel** in the app, or export raw data via the API.

---

## Data Export

Export everything, anytime. Your data stays portable.

### From the App
Open **Admin Panel > Export** to download:
- Conversations (CSV)
- User list (CSV)
- Analytics reports (CSV)
- Full data export (JSON)

### Via API
```
GET /api/export?format=json     — All data (conversations, users, analytics, settings)
GET /api/export?format=csv      — Conversations as CSV
GET /api/export?format=audit    — Audit log entries
```

### Data Retention Policy
- **Conversation history**: Stored for 30 days (configurable)
- **Analytics data**: Aggregated daily, retained for 90 days
- **User accounts**: Retained until deleted by admin
- **Audit log**: All admin actions logged permanently
- **File uploads**: Stored until explicitly deleted

---

## Security & Compliance

Your business data deserves enterprise-grade protection:

- **Docker sandboxing** -- The AI runs in an isolated container. It cannot access your host filesystem, network, or other containers.
- **JWT authentication** -- Secure token-based auth with 7-day expiry. No passwords stored in plain text.
- **Role-based access** -- Users only see what their role permits. Admin controls all access.
- **No external data sharing** -- Everything stays in your deployment. Zero telemetry. Zero phone-home.
- **Audit trail** -- All admin actions (role changes, exports, user management) are logged.
- **Data portability** -- Export and delete all data at any time via the API.
- **SOC2-ready architecture** -- Built for compliance from day one.

---

## Pricing & Licensing

**Free. Open source. Self-hosted. Forever.**

BusinessLog AI is MIT licensed. No per-seat fees. No usage limits. No feature gates.

- **Core platform**: Free, open source (MIT)
- **Support**: Community via GitHub Issues
- **Enterprise**: Custom deployments and support available -- contact [Lucineer](https://github.com/Lucineer)

---

## Enterprise Features Roadmap

| Feature | Status |
|---------|--------|
| Multi-user with roles | Shipped |
| Analytics dashboard | Shipped |
| Data export (CSV/JSON) | Shipped |
| Multi-channel (Telegram, Discord, WhatsApp) | Shipped |
| Docker deployment | Shipped |
| SSO / SAML integration | Planned |
| PDF export | Planned |
| Custom model fine-tuning | Planned |
| On-premise air-gapped mode | Planned |
| Advanced RBAC with teams/groups | Planned |
| Compliance reporting (SOC2, GDPR) | Planned |
| API rate limiting per user | Planned |

---

## Alternative: Cloudflare Workers

If you prefer edge deployment over Docker:

```bash
git clone https://github.com/Lucineer/businesslog-ai.git
cd businesslog-ai && npm install

cp wrangler.toml wrangler.toml.local
# Edit wrangler.toml.local — set KV namespace IDs and D1 database ID

npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_EMAIL

npm run deploy
```

---

## Architecture

```
BusinessLog AI
├── Cloudflare Worker (or Docker)
│   ├── REST API (Hono framework)
│   ├── AI Agent (DeepSeek-powered)
│   ├── Memory (KV / D1)
│   └── Channel connectors
├── Web App (static HTML/JS/CSS)
│   ├── Messenger interface
│   ├── Admin dashboard
│   └── Analytics with CSS bar charts
└── Docker (recommended)
    ├── Multi-stage build
    └── Volume persistence
```

---

## API Reference

### Authentication
```
POST /api/auth/register    { email, password, name }    → { token, user }
POST /api/auth/login       { email, password }          → { token, user }
GET  /api/auth/me          (Bearer token)               → { id, email, name, role }
```

### Chat
```
POST /api/chat             { message, conversationId? }  → SSE stream
POST /api/chat/guest       { message }                   → SSE stream (3 free messages)
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

### Analytics
```
GET /api/analytics/dashboard                             → DashboardData
GET /api/analytics/report?type=daily&format=csv          → Report
```

### Data Export
```
GET /api/export?format=json     → All data
GET /api/export?format=csv      → Conversations CSV
GET /api/export?format=audit    → Audit log
```

---

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

MIT -- see [LICENSE](LICENSE).
