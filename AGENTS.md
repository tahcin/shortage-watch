# AGENTS.md (rules for the coding agent in this repo)

Shortage Watch: an agent that tells a hospital pharmacy buyer which drugs are about to run short, why, and what to order instead, with every claim linked to the FDA record behind it. Built for the Open Agent Hackathon 2026, Track 02 "The Agent That Can Explain Why".

## Stack
- TypeScript, Node 22, ES modules, `tsx` for scripts. Server: Fastify. UI: React + Vite (later).
- Data access goes through Zetaris (REST `POST {ZETARIS_REST_URL}/sql-editor/sqls/run`, bearer `ZETARIS_API_KEY`, headers `X-Org-ID`, fresh UUID `X-Request-ID`, body `{queryId, sql, source:"SqlEditor", limit}`). One SQL statement per request.
- Model calls go through Meterless Nightshift (OpenAI-compatible, `METERLESS_BASE_URL`, `Authorization: Bearer METERLESS_RUNTIME_TOKEN`, headers `meterless-app: shortage-watch`, `meterless-scope: user`).

## Rules
- Never hardcode, print or commit secrets. Settings come from `.env` (gitignored); keep `.env.example` with placeholders only.
- Deterministic logic (days of cover, equivalence codes, recall and shortage matching) lives in code; the model plans, reads and explains.
- Every agent step appends a JSON line to the run's trace file.
- No fabricated data. Sample hospital data must be labelled as sample wherever it appears.
- Writing style for all docs, comments and UI text: plain language, never use em dashes.
