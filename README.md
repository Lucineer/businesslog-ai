# businesslog-ai 🛠️

**Live instance:** [businesslog-ai](https://businesslog-ai.casey-digennaro.workers.dev)

You have a raw business idea. You want structured analysis, not cheerleading. This agent applies Porter's Five Forces and unit economics to your idea. It runs on your infrastructure. You control the data.

---

## Why This Exists

Most AI analysis tools are either locked behind subscriptions or send your data to third parties. This agent runs standard business frameworks without requiring a login or sharing your notes. The analysis is yours.

---

## How It Works

1.  **Fork this repository.** You own the code.
2.  **Deploy it to your Cloudflare account.** It runs as a Cloudflare Worker.
3.  **Connect your own LLM API key.** The worker sends prompts directly to your chosen endpoint (e.g., OpenAI, Anthropic, or a local model via Cloudflare AI).
4.  **You get a structured report.** The agent formats the LLM's output into the requested business framework.

There is no intermediary server. Your API key is stored as a Cloudflare Secret. Conversation context is kept only in your browser session.

---

## Quick Start

1.  **Fork this repository** to your own GitHub account.
2.  Install and authenticate Wrangler, Cloudflare's CLI tool.
3.  Deploy the Worker:
    ```bash
    npx wrangler deploy
    ```
4.  In the Cloudflare dashboard, set your LLM API key as a secret named `AI_API_KEY`. The worker includes a simple adapter for common OpenAI-compatible endpoints.

---

## Features

*   **Applies Standard Frameworks:** Generates analysis using Porter's Five Forces and basic unit economics for a given idea.
*   **Self-Hosted:** The code runs on your Cloudflare Worker. Your prompts and API key never pass through our servers.
*   **LLM Agnostic:** Configure it to use any endpoint with an OpenAI-compatible API.
*   **Zero Dependencies:** The Worker script has no npm dependencies.
*   **Session-Based Context:** Maintains conversation history only within your current browser tab.
*   **Fleet-Compatible:** Can receive updates if you connect it to the Cocapn Fleet.

## Limitations

*   **Analysis Depth is LLM-Dependent.** The quality and accuracy of the generated report are bound by the capability of the language model you connect it to. It will not perform independent research or fact-checking.
*   **Response time is variable.** The ~3 second claim depends entirely on your configured LLM's speed. Network latency and model processing time will affect this.

---

## License

MIT License. You are free to use, modify, and distribute this software.

---

Built by Superinstance and Lucineer (DiGennaro et al.).

<div style="text-align:center;padding:16px;color:#64748b;font-size:.8rem"><a href="https://the-fleet.casey-digennaro.workers.dev" style="color:#64748b">The Fleet</a> &middot; <a href="https://cocapn.ai" style="color:#64748b">Cocapn</a></div>