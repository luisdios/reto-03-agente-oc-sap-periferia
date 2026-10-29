# Agente de órdenes SAP

Prototipo conversacional en español para validar solicitudes de compra y crear órdenes en un SAP simulado.

## Run & Operate

- `pnpm dev` — start the web app and API server together locally.
- `pnpm run typecheck` — typecheck workspace libraries and artifacts.
- `pnpm run test:oc` — run deterministic tests against copied fixtures.
- `pnpm run demo` or `bun run demo.ts` — run the six-case demo without Gemini; explicitly simulates approval for sol-004 and refuses to overwrite an existing `out/`.
- Required secret: `GEMINI_API_KEY` — configure in Replit Secrets or export it locally.
- Optional env: `GEMINI_MODEL`, `AGENT_MAX_ITERATIONS`, `AGENT_MAX_SESSION_TOKENS`, `AGENT_MAX_PROCESS_TOKENS_PER_DAY`, `API_SERVER_PORT`, `WEB_PORT`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/sap-purchase-agent/` — React/Vite interface.
- `artifacts/api-server/src/` — Express routes, Gemini agent cycle, Zod tools, SAP adapter.
- `agent/prompt.md` — system prompt.
- `artifacts/api-server/src/knowledge/` — process rules.
- `fixtures/reto-03/` — read-only source documents and master data.
- `out/` — generated evidence, trace, simulated orders, control and usage logs.
- `lib/api-spec/openapi.yaml` — source of API contracts; regenerate with `pnpm --filter @workspace/api-spec run codegen`.

## Architecture decisions

- The LLM never supplies trusted order values: each tool reloads fixtures and the server rebuilds the canonical payload.
- A confirmation is held in server-side session state and checked again by `oc_crear`.
- No database or real SAP connection is used; writes are local files under `out/`.
- `out/` and local environment files are ignored and excluded from deployment.

## Product

- Review six purchase cases, inspect validation calls, resolve blocks, confirm exceptions and inspect saved simulated orders.

## User preferences

- Preserve every fixture amount and date; never infer or silently correct source data.
- Do not expose `GEMINI_API_KEY` in code, browser requests, logs or responses.

## Gotchas

- `demo.ts` refuses to overwrite an existing `out/`; move or archive it before rerunning the demo.
- The web dev server proxies `/api` to the local API port; the API listens on `API_SERVER_PORT` (default `8080`).
- Sessions are in memory and reset when the API server restarts.

## Pointers

- `README.md` — setup and commands.
- `SOLUCION.md` — design, cost estimate, coverage and production gaps.
