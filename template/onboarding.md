# Onboarding Guide — BusinessLog AI

Welcome to your company's AI brain. Here's how to get started.

## 1. First Steps

1. **Admin sets up** — The first user to register becomes the admin automatically.
2. **Invite your team** — Share the URL or send invites from the admin panel.
3. **Start chatting** — Ask anything. The agent learns your business context over time.

## 2. Roles

| Role | Can Do |
|------|--------|
| **Admin** | Manage users, view analytics, configure channels, export reports |
| **Member** | Chat with agent, upload files, view shared conversations |
| **Viewer** | Read-only access to summaries and reports |

## 3. Channels

Connect your agent to where your team already works:

- **Web** — Built-in messenger (default, always on)
- **Telegram** — Direct messages to your bot
- **Discord** — Slash commands in your server
- **WhatsApp** — Business API integration

## 4. Best Practices

- **Be specific** — "What did we decide about the Q3 pricing?" works better than "pricing?"
- **Tag decisions** — Start messages with "DECISION:" for easy retrieval
- **Upload key docs** — The agent remembers uploaded files as context
- **Review analytics weekly** — Check the dashboard for trends and insights

## 5. Security

- All data stays in your deployment (Docker container or Cloudflare Workers)
- API keys are never exposed to users
- Role-based access ensures sensitive data stays protected
- Docker deployment sandboxes everything from your host system
