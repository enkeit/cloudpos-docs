# cloudpos-ai

Help & support chat plus a business analyst for CloudPOS, on Cloudflare Workers AI.

- **Live:** https://ai.cloudposai.com
- **Two Workers, two accounts:**
  - `cloudpos-ai-web` (frontend, `wrangler.web.jsonc`, `src/web.ts`) on **IT Consult** (`48073c198a3baff8cd9878190dc8101b`), where the `cloudposai.com` zone lives.
    It serves `public/` and forwards `/api/*` to the backend, adding the visitor IP plus the shared `PROXY_KEY` so per-visitor rate limits still work.
  - `cloudpos-ai` (backend, `wrangler.jsonc`) on **Enke dev** (`4275d9596d1fa5b1f150fdbbbc263d26`), which is on Workers Paid.
    DeepSeek V4.1 Flash needs Paid; IT Consult is on Free (10k neurons/day ≈ 35 chats).
- **Chat history:** D1 `cloudpos-ai-chat` (schema in `migrations/`). Chats are scoped per signed-in user (`live:<tenant>:<user id>`) or per guest browser (random `X-Visitor-Id`).
  A daily cron deletes guest chats after 30 days and signed-in chats after 180 days of inactivity.

## What it does

There is no sample or demo data anywhere. Every figure comes from a real, signed-in CloudPOS store.

- **Guest (default): help & support.** Anyone can ask how to use CloudPOS (POS app, admin panel, online store).
  The AI only has the docs search tool and answers from the CloudPOS documentation, with links.
  It has no data tools, and its prompt forbids stating or inventing any business figures.
  Asked about "my sales", it tells the user to sign in.
- **Signed in: store analysis.** The user signs in with company key, email and password, the same way the POS app logs in (`find-domain` → `user/signin`).
  The AI then also gets data tools for sales, products, stock, customers, busy hours and orders, with charts and tables.
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
| KV | `cloudpos_ai` (docs manifest, guest daily counter) |
| Rate limits | guest 8/min per IP · signed-in 30/min per user · login 5/min per IP · guest daily cap 1500 |
| Secrets | `SESSION_SECRET`, `ADMIN_TOKEN` |

The models were chosen with `scripts/eval-models.mjs`.
DeepSeek V4.1 Flash answered in 4–6 s, used correct figures and wrote the richest answers.
Gemma 4 took 8–26 s per turn.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/info` | Suggested questions; plus store info and stores with `Authorization: Bearer <session>` (`info` is null for guests) |
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
