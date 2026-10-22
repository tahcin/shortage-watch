# Brief 03: the agent loop, end to end on the command line

Read AGENTS.md first. Depends on briefs 01, 01b and 02 (`src/zetaris/client.ts`, the `fda.*` views and the `hospital_pg` tables registered in Zetaris).

Judges reject "a fixed chain with no feedback, critique or validation", "one agent with several labels", "hardcoded outputs" and anything with "no evidence of how the agent reached its output". This brief is built around those rules.

## 1. Meterless provider (`src/llm/meterless.ts`), the primary AI provider

Implement this contract exactly (Meterless Runtime 1.4, provider contract v4, from meterless.ai/engines.html "POWER: Add Meterless as a provider"):

- Provider id `meterless`, name `Meterless Runtime`, default base URL `http://127.0.0.1:8088/v1`. Accept a pasted URL with or without a scheme, `/v1`, `/v1/chat/completions`, `/v1/models` or `/healthz`, and normalise it to `<host>/v1`. Never produce `/v1/v1`.
- Send `Authorization: Bearer <token>` on every call (`METERLESS_RUNTIME_TOKEN`; reject the placeholder `rt-local`). Send `meterless-app: shortage-watch` on every request and `meterless-scope: user` on chat.
- Model ids are routing modes: `meterless/<disposition>` (auto, fast, deep, cheap, local, fusion), `meterless/<class>`, `meterless/<class>.<disposition>`. Read them from `GET /v1/models`; keep unknown `meterless/*` ids.
- Status: `GET /v1/models` decides: 401/403 = `unauthorized`, 200 with meterless ids = `online`, anything else = `offline`. `/healthz` only proves the process is up.
- Auto-detect tries ports 8088, 8090, 8787, 11434 on 127.0.0.1, localhost and [::1]; first online or unauthorized hit wins.
- 180 s timeout. Plain text content stays a string.
- Connect links `http://<host>:<port>/connect#k=<key>`: base URL from origin + `/v1`, key from `k`; never log it.
- Every chat response from Meterless carries a `meterless` receipt object (`routed_model`, `winning_route`, `phases`, `receipt_id`, `cost`). Return it alongside the text so traces can record which model actually answered.
- Settings: `METERLESS_BASE_URL`, `METERLESS_RUNTIME_TOKEN`, `METERLESS_MODEL_FAST` (default `meterless/fast`), `METERLESS_MODEL_DEEP` (default `meterless/deep`). A second, optional provider `nvidia` (direct `https://integrate.api.nvidia.com/v1` with `NVIDIA_API_KEY`) exists only as an explicit fallback setting `LLM_PROVIDER=nvidia`; Meterless is the default and the one used in the demo.
- `npm run meterless:check`: prints status, the model list, and one test reply with its receipt. Done when a wrong token shows `unauthorized` (not `offline`), auto-detect finds the runtime, and a plain request on `meterless/auto` returns a string.
- Nemotron models answer with reasoning text before the final answer. For JSON outputs, ask for a single JSON object, then extract the last valid JSON object from the reply; on failure, retry once with a stricter instruction, then fail the step with a clear error (never invent a value).

## 2. Evidence model (`src/evidence.ts`)

Every row fetched from Zetaris becomes an `Evidence` record with a stable id and its source:
- `hospital:cover:<item_id>` (days of cover, on hand, average daily use)
- `fda-shortage:<package_ndc>:<update_date>` (availability, reason, company, link)
- `fda-recall:<recall_number>` (classification, reason, firm)
- `orange-book:<appl_no>-<product_no>` (ingredient, strength, form, TE code, applicant)
- `fda-ndc:<product_ndc>` (labeler, marketing status) when the scout fetches NDC listings
A `Claim` is `{ text, evidence_ids[] }`. Agents may only make claims through this type.

## 3. Deterministic tools (`src/tools/*.ts`), all through Zetaris SQL

- `coverTable()`: hospital items with on hand, average daily use (30 days), days of cover, critical flag, open or backordered purchase orders.
- `shortageFor(item)`: rows from `fda.shortages_current_v` matching the item's package NDC, product NDC, application number, or the same active ingredient and dosage form (mark each match with its match type: `same_package`, `same_product`, `same_application`, `same_ingredient`).
- `recallsFor(ndcs[])`: ongoing recalls touching those NDCs.
- `equivalentsFor(item)`: Orange Book rows with the same ingredient, strength and `df_route`, TE code starting with `A` (AP, AB, AA, AN, AO, AT...), excluding the item's own application. 
- `substituteStatus(candidate)`: is that application or its NDCs on the shortage list or under an ongoing recall.
- `registerNdcSource(ingredient)`: the **source scout** tool. If a needed NDC listing is not yet in Zetaris, it runs `CREATE LIGHTNING REST TABLE ndc_<slug> FROM OPENFDA_REST REQUEST(endpoint "https://api.fda.gov/drug/ndc.json?search=generic_name:%22<ingredient>%22&limit=100", method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()` and a flattening view, then queries it. Record the SQL it ran in the trace. Reuse the table if it already exists.
Each tool returns evidence records, never prose.

## 4. Agents (`src/agents/*.ts`), each a separate role with its own prompt and model

1. **Planner** (fast model): given the cover table, chooses which items to investigate this run and in what order, with a one-line reason each. Code enforces that every item under 14 days of cover is included and that critical items come first; the model may add items (for example, low-use items with a backordered purchase order) and must explain why.
2. **Investigator** (fast model): for one item, calls `shortageFor` and `recallsFor`; asks the model to classify the risk (`supply_risk`, `low_stock_only`, `recall`, `no_risk`) and write claims citing evidence ids. If coverage is missing (for example, no NDC data for an ingredient), it asks the **Scout** to register a source and retries.
3. **Scout** (code plus fast model for the slug and the query): runs `registerNdcSource`.
4. **Substitution agent** (deep model): calls `equivalentsFor` and `substituteStatus`, ranks safe substitutes (equivalent TE code, not short, not recalled, same strength and form), and writes claims with evidence ids. Never proposes a product that is not in the tool results.
5. **Evidence critic** (deep model plus code): code checks first (every claim cites at least one evidence id that exists in this run; every substitute has an `A*` TE code and is not short or recalled; days-of-cover numbers match the cover table). Then the model reviews the wording for claims the evidence does not support. Verdicts: `approve`, `revise` (send back to the named agent with the reason; max 2 retries per item), `block` (drop the claim and say why). This is the loop: the critic can send work back to the Investigator or the Substitution agent.
6. **Writer** (deep model): turns approved findings into the order list: drug, days left, risk and why, what to order instead (or "keep current supplier"), evidence links, confidence. Code renders evidence links (openFDA shortage link, recall number, Orange Book application number).

`src/orchestrator.ts` runs the loop with a concurrency limit of 2 items at a time (NVIDIA's free tier is about 40 requests a minute), a per-run budget, and a clean stop if Meterless is offline.

## 5. Traces (`src/trace.ts`)

Append one JSON line per step to `logs/run-<run_id>.jsonl`:
`{ timestamp, run_id, item_id, agent_name, action, input_summary, output_summary, target_agent, evidence_ids, verdict, confidence, retry_count, status, model_requested, model_routed, receipt_id, latency_ms, sql? }`.
Also write `logs/run-<run_id>.result.json` with the final order list.

## 6. Sample mode

`SAMPLE_MODE=true` replays recorded Zetaris results and model replies from `samples/<scenario>/` so a judge can run the whole loop with no credentials. Add `npm run record-sample` that runs live and saves those fixtures (no secrets, no tokens in them). The trace must say `"mode": "sample"` or `"live"` on every line, so nobody can mistake a replay for a live run.

## 7. CLI

`npm run agent -- --items 8` (live) and `SAMPLE_MODE=true npm run agent` print a readable summary as the run goes (which agent is doing what, critic verdicts, retries) and the final list.

## Done when

- Typecheck passes; unit tests (vitest) cover the evidence checks in the critic and the URL normalisation in the provider.
- Do not run live calls yourself (the operator runs them). Report the files created and how to run each command.
