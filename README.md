# BUSINESSLOG-AI

> AI Business Operations Dashboard — part of the [Cocapn](https://cocapn.ai) ecosystem

![Build](https://img.shields.io/badge/build-passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-33_files-blue) ![Lines](https://img.shields.io/badge/lines-6930-green)

## Description

AI Business Operations Dashboard. Part of the Cocapn ecosystem of AI-powered log and analysis tools.

## ✨ Features

- CRM system
-  meeting simulator
-  scheduler
-  invoice system
-  project manager
-  lead scorer
-  analytics engine
-  email manager
-  dashboard

## 🚀 Quick Start

```bash
git clone https://github.com/Lucineer/businesslog-ai.git
cd businesslog-ai
npm install
npx wrangler dev
```

## 🤖 Claude Code Integration

Optimized for Claude Code with full agent support:

- **CLAUDE.md** — Complete project context, conventions, and architecture
- **.claude/agents/** — Specialized sub-agents for exploration, architecture, and review
- **.claude/settings.json** — Permissions and plugin configuration

## 🏗️ Architecture

| Component | File | Description |
|-----------|------|-------------|
| Worker | `src/worker.ts` | Cloudflare Worker with inline HTML |
| BYOK | `src/lib/byok.ts` | 7 LLM providers, encrypted keys |
| Health | `/health` | Health check endpoint |
| Setup | `/setup` | BYOK configuration wizard |
| Chat | `/api/chat` | LLM chat endpoint |
| Assets | `/public/*` | KV-served images |

**Zero runtime dependencies.** Pure TypeScript on Cloudflare Workers.

## 🔑 BYOK (Bring Your Own Key)

Supports 7 LLM providers — no vendor lock-in:

- OpenAI (GPT-4, GPT-4o)
- Anthropic (Claude 3.5, Claude 4)
- Google (Gemini Pro, Gemini Flash)
- DeepSeek (Chat, Reasoner)
- Groq (Llama, Mixtral)
- Mistral (Large, Medium)
- OpenRouter (100+ models)

Configuration discovery: URL params → Auth header → Cookie → KV → fail.

## 📦 Deployment

```bash
npx wrangler deploy
```

Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment variables.

## 🔗 Links

- 🌐 **Live**: https://businesslog-ai.magnus-digennaro.workers.dev
- ❤️ **Health**: https://businesslog-ai.magnus-digennaro.workers.dev/health
- ⚙️ **Setup**: https://businesslog-ai.magnus-digennaro.workers.dev/setup
- 🧠 **Cocapn**: https://cocapn.ai

## License

MIT — Built with ❤️ by [Superinstance](https://github.com/superinstance) & [Lucineer](https://github.com/Lucineer) (DiGennaro et al.)
