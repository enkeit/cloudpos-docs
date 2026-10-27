# cloudpos-ai

AI business analyst + docs assistant for CloudPOS, on Cloudflare Workers AI.

- **Live demo:** https://cloudpos-ai.enkedevelopment-427.workers.dev (sample café & market data)
- **Account:** Enke dev (`Enkedevelopment@gmail.com`, `4275d9596d1fa5b1f150fdbbbc263d26`)

## What it does

A chat that answers questions about sales, products, stock, customers and busy hours, with charts and tables.
It can also answer how-to questions from the CloudPOS docs.

- **Demo mode** (default): a deterministic synthetic store (`src/sources/demo.ts`). The same date always produces the same orders.
- **Live mode**: the user signs in with company key, email and password, the same way the POS app logs in (`find-domain` → `user/signin`).
  The worker reads that tenant's data through the Laravel API using the user's own token (`src/sources/live.ts`), so it can only see what that user can see.
  It has read-only access.

The model never does arithmetic. Each tool (`src/tools.ts`) returns figures already computed in code, plus chart/table "visuals" that are streamed straight to the UI.
The model picks the tools and writes the narrative.

| Piece | Where |
| --- | --- |
| Router, SSE, rate limits | `src/index.ts` |
| Tool-calling loop (OpenAI-style output, fallback model) | `src/agent.ts` |
| Named periods (`last_week`, `this_month`…), Monday weeks | `src/period.ts` |
| Sealed sessions (AES-GCM, 12 h, no server state) | `src/session.ts` |
| Docs chunking + bge-m3 embeddings + Vectorize search | `src/docs.ts` |
| Web chat (no build step) | `public/` |

## Cloudflare resources

| Resource | Name |
| --- | --- |
| Worker | `cloudpos-ai` |
| Workers AI models | `@cf/deepseek-ai/deepseek-v4.1-flash-1017`, falling back to `@cf/openai/gpt-oss-120b` |
| Embedding model | `@cf/baai/bge-m3` |
| AI Gateway | `cloudpos-ai` (logs, 600 req/min, retries) |
| Vectorize | `cloudpos-docs-v1` (1024-d, cosine) |
| KV | `cloudpos_ai` (docs manifest, demo daily counter) |
| Rate limits | demo 8/min per IP · live 30/min per user · login 5/min per IP · demo daily cap 1500 |
| Secrets | `SESSION_SECRET`, `ADMIN_TOKEN` |

The models were chosen with `scripts/eval-models.mjs`.
DeepSeek V4.1 Flash answered in 4–6 s, used correct figures and wrote the richest answers.
Gemma 4 took 8–26 s per turn.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/info` | Store info and suggested questions (demo, or live with `Authorization: Bearer <session>`) |
| `POST /api/session/login` | Body `{tenantKey, email, password, storeId?}` → `{token, stores, info}` |
| `POST /api/session/store` | Body `{storeId}` with Bearer session → new token |
| `POST /api/chat` | Body `{message, history?}` → `text/event-stream` |
| `GET /api/docs/search?q=` | Docs hits with links |
| `POST /api/admin/reindex` | Bearer `ADMIN_TOKEN`; replaces the docs vectors |

`/api/chat` streams these event types:
- `status` — `{text}`
- `tool` — `{name, args}`
- `visual` — `{visual: chart|table}`
- `answer` — `{text}` (markdown)
- `error` — `{text}`
- `done`

Admins can send `X-Admin-Token` plus `model` in the body to try another model; those requests skip the rate limits.

## Commands

```bash
npm install
npm test                 # unit tests (node --test, no extra deps)
npm run typecheck
npx wrangler dev --remote --port 8799   # uses the real AI/Vectorize bindings; needs .dev.vars
npm run deploy
```

After the docs content changes, re-index the docs:

```bash
AI_URL=https://cloudpos-ai.enkedevelopment-427.workers.dev ADMIN_TOKEN=$(cat .prod-admin-token) npm run index-docs
```

`.prod-admin-token` is gitignored and holds the production admin token.
`.dev.vars` holds local values for `SESSION_SECRET` and `ADMIN_TOKEN`.

## Next steps

- POS app: add an "Ask AI" screen that streams `/api/chat`. It needs a token-exchange endpoint (app access token → session) so users don't have to sign in twice.
- Live mode: verify the response shapes against a real tenant. They are mapped from the Flutter parsers but have not been run against production data yet.
- Docs site: add an "Ask AI" entry that links here or embeds the chat (CORS already allows the docs origin).
- Re-index docs from CI when `content/**` changes.
