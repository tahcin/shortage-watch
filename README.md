# Shortage Watch

**An agent that tells a hospital pharmacy buyer which drugs are about to run short, why, and what to order instead, with every claim linked to the FDA record behind it.**

Open Agent Hackathon 2026, **Track 02: The Agent That Can Explain Why**. Team Solus (solo).

Every Monday a hospital buyer checks the FDA shortage list by hand, compares it with what is on the shelf, and phones wholesalers to find a product that can safely replace one that is gone. Shortage Watch does that investigation and shows its work: what is running low, whether the FDA lists *our own package* as short or recalled, how long the gap is, and which interchangeable product (FDA-rated equivalent, same concentration, not short or recalled on its own packages) can be ordered, package by package, with the labeler named.

## What it found on real data

Sample hospital stock on real FDA-listed products; real FDA data captured 22 October 2026.

| Drug (our package) | Cover | What the FDA data says about our package | Shortage Watch's advice |
|---|---|---|---|
| Morphine sulfate 50 mg/mL, Hospira 20 mL vial (CII) | 5.2 days | Unavailable, next delivery January 2027 | **Escalate**: the Orange Book lists no interchangeable product at this strength; about 96 days without supply, about 1,018 units to bridge |
| Lidocaine 10 mg/mL, Hospira 30 mL vial (epidural) | 13.6 days | Ongoing Class II recall D-1815-2015 | **Check our lots and quarantine affected stock**; if needed, Eugia's preservative-free 30 mL vial |
| Sodium bicarbonate 8.4%, Hospira 50 mL vial | 16.8 days | Unavailable, next delivery January 2027 | **Order a substitute**: Adaptis, Omnivium or Steriscience 50 mL vials, not on the shortage list; about 1,546 vials bridge an 84-day gap |
| Midazolam 1 mg/mL, Hospira 5 mL vial (CIV) | 7.4 days | Limited availability, recovery December 2026 | **Add a second supplier**: OneSource 5 mL vials first (about 712 bridge a 56-day gap); preservative and vial-size notes for the pharmacist |
| Atropine 0.4 mg/mL, Accord 20 mL vial | 18 days | Unavailable | **Order a substitute**: Hikma or Somerset 20 mL vials, listed as Available |
| Lorazepam 2 mg/mL (CIV), ketorolac 30 mg/mL | 8.2 and 6.3 days | Not short themselves | **Reorder now**: 9 of 10 (lorazepam) and 13 of 22 (ketorolac) presentations from other makers are listed limited or unavailable |

Run 1 checked all 18 drugs with under 14 days of cover or a supply problem on FDA data; the source scout registered 6 Zetaris sources at run time; the critic sent work back 4 times and approved all 18; every written line passed the code check. After the buyer clicked "Never use Hikma", run 2 removed Hikma in code before ranking (atropine now offers Somerset only), named the rule on the cards, and flagged famotidine because Hikma is its current supplier. Full traces and results, and exactly how they were recorded: [`runs/`](runs/README.md).

Teach it a rule and the next run changes: "Never use Hikma" removes Hikma's products in code before the Substitution agent ranks anything, the critic re-checks it, and the card says which rule was applied.

## How it works

```mermaid
flowchart TD
    subgraph Z[Zetaris: one SQL layer]
      H[Hospital database<br/>Postgres via JDBC]
      F1[FDA shortages<br/>openFDA REST, snapshotted to Parquet]
      F2[FDA recalls<br/>openFDA REST, snapshotted to Parquet]
      OB[FDA Orange Book<br/>CSV file]
      N[openFDA NDC directory<br/>registered at run time]
    end
    Z -->|risk board: one federated query| RB[Risk board]
    M[(Meterless H-MEM<br/>buyer decisions)] --> P
    RB --> P[Planner]
    P --> I[Investigator]
    I --> SU[Substitution]
    SU -->|needs packages| SC[Source scout]
    SC -->|registers a new source| N
    Z -->|substitute board: one federated query per drug| SU
    SU --> C{Evidence critic}
    I --> C
    C -->|send back with reasons| I
    C -->|send back with reasons| SU
    C -->|approve, or drop what does not hold up| W[Writer]
    W --> G[Code check on the Writer]
    G --> O[Order list with evidence]
    O -->|buyer decisions| M
```

1. **Risk board (one federated Zetaris query).** A single SQL statement joins the hospital's Postgres stock and days of cover with the FDA shortage and recall snapshots and the FDA Orange Book file (`src/tools/board.ts`, about 1 second for 45 items). It flags which of *our own packages* are short or recalled.
2. **Planner.** Code sets the floor: every item under 14 days of cover and every item whose own package is short or recalled is checked. The Nemotron planner orders that work by urgency and may add items; its additions are checked too.
3. **Investigator.** Reads the item's records through Zetaris. "Ours" means our exact package or product NDC; other presentations from our maker and other makers' shortages are reported as market context, never as our risk. Risk is set in code from those records; the model explains it with citations. The FDA's next-delivery and recovery dates for our package are parsed for the stockout gap.
4. **Source scout.** Snapshots the live openFDA views into Parquet inside Zetaris at the start of a run (fast, and kind to openFDA's rate limits). When a supply problem needs package-level data, it issues `CREATE LIGHTNING REST TABLE` over the openFDA NDC directory for that ingredient, a flattening view and a Parquet snapshot, and warns in the trace if openFDA's 1,000-product limit was reached.
5. **Substitution (the second federated query).** One Zetaris statement per drug joins the Orange Book's A-rated equivalents (file), the NDC listing the scout just registered (REST), and the FDA shortage and recall snapshots (`substituteBoardSql` in `src/tools/fda.ts`). Each equivalent is judged on *its own packages at our concentration and in a comparable presentation* (same kind of container, within four times our fill volume): on the shortage list, recalled, or clear. For epidural and intrathecal routes only products labelled preservative-free are offered. Suppliers the buyer ruled out are removed in code before the model ranks. The model picks and explains; code fills the package NDCs (closest presentation first, labeler named), how many packages bridge the gap, and notes for a preservative, dose-type or vial-size difference.
6. **Evidence critic.** Code checks first: every citation exists in this run; substitutes are A-rated, safe on their own packages, at our concentration, the NDCs belong to that application, and not ruled out by the buyer; days-of-cover figures match the database. Then a Nemotron model checks each claim against the records it cites. It sends work back with reasons (up to two retries), drops unsupported sentences (and any substitute whose justification fell), or blocks the item.
7. **Writer, then a code check on the Writer.** Actions, orders, gaps and numbers come from code: check recalled lots first, order a substitute, add a second supplier, escalate, reorder now when most other makers are short, or reorder. The stockout gap counts open orders due in time, plans each FDA month as its last day, and flags overdue or backordered orders. The model writes the headline and two sentences per drug (one Meterless call and receipt each); code checks every number, date and count in them against the line's records, and that the text does not contradict the action, and replaces the text with the approved claims if anything fails.

Every step is written to a JSONL trace (agent, action, input and output summaries, evidence ids, critic verdict, retry count, the model that answered and, through Meterless, its receipt). Example traces from judged runs are in `runs/`.

## Sponsor technology

| Sponsor | Role in Shortage Watch |
|---|---|
| **Zetaris** | The only data layer, built as a unified semantic layer: see [`docs/zetaris-usl.md`](docs/zetaris-usl.md) for the sources, DDL, queries, data-quality rules and our reflections against Zetaris's evaluation criteria. Sources registered by `zetaris/setup/*.sql`: openFDA shortages and recalls as paged REST tables with flattening views, the Orange Book as a CSV file table, the hospital Postgres database as a JDBC datasource. Each run materialises the live views to Parquet in Zetaris storage and runs **two federated queries**: the risk board (hospital x shortages x recalls x Orange Book) and, per drug, the substitute board (Orange Book x the NDC listing the scout registers at run time x shortages x recalls). Agents query nothing but Zetaris. |
| **Meterless** | **Nightshift** is implemented as the app's primary AI provider per provider contract v4 (`src/llm/meterless.ts`: bearer token, `meterless-app`, `meterless-scope`, model discovery, online/unauthorized/offline status, auto-detect, connect links, receipts). `npm run meterless:check` passes the contract checks against a running Nightshift. **H-MEM** (Meterless reference implementation, vendored unchanged under Apache-2.0) is the buyer memory: decisions stored with provenance in the long-term layer, re-injected every run, older run notes superseded, every change in the append-only trust ledger. `test/memory.test.ts` tests the user-facing feature end to end on a real H-MEM store; `npm run hmem:conformance` runs Meterless's own suite (13/13). In practice Nightshift runs Nemotron with reasoning always on and cuts any call off after about 90 seconds, so a call it cannot finish (or that comes back empty) is sent once to NVIDIA directly with the same prompt; the trace marks it (`provider: "nvidia"`, `fallback_from`). Across the two recorded runs, 95 of 118 model calls were answered through Nightshift with a Meterless receipt (Nemotron 3 Ultra 60, Nemotron 3.5 Lightning 35) and 23 went to NVIDIA directly. |
| **NVIDIA** | Nemotron does all the language work. Two lanes are seated in Nightshift: Nemotron 3.5 Lightning (30B) and Nemotron 3 Ultra (550B). The planner, investigator and substitution steps ask for `meterless/fast`; the critic and writer ask for `meterless/deep` with more reasoning. Nightshift picks the lane per call and its receipt names the model, which the trace records. With `LLM_PROVIDER=nvidia` the app calls NVIDIA's API directly (Lightning for fast steps, Ultra for deep ones). |
| **Cursor** | Optional under the updated rules (24 October); see "How it was built". |

## Quick start (sample mode, no credentials)

```bash
git clone https://github.com/tahcin/shortage-watch.git
cd shortage-watch
npm install
cp .env.example .env
SAMPLE_MODE=true npm start      # http://127.0.0.1:5180
```

Sample mode replays a recorded live run through the real agent code: every Zetaris result and every model reply is replayed from `samples/`, so the planner, critic loop, guards and memory all run, and every trace line says `"mode": "sample"`. Press "Check this week's orders" (the replay takes about two minutes), then "Never use Hikma" on the atropine card, then "Check again" to see the memory change the outcome. That is the path that was recorded; other buyer decisions need the live setup. How the recording was made: [`runs/README.md`](runs/README.md). Command line: `SAMPLE_MODE=true npm run agent`.

## Full live setup

Needs Docker with 8 GB for Zetaris, Node 22+, Meterless Nightshift and a free NVIDIA API key.

1. **Zetaris**: install locally (zetaris.github.io/getting-started); create an API key under Management > API Tokens.
2. **Orange Book**: download the "Orange Book Data Files" zip from fda.gov and copy `products.txt` to `/home/zetaris/customer-data/shared/orangebook/products.txt` in the Zetaris driver container.
3. **Hospital database**: `HOSPITAL_DB_PASSWORD=... docker compose -f infra/hospital-db/docker-compose.yml up -d` (joins the Zetaris Docker network). Rebuild the sample data with `npm run build-sample`.
4. **Nightshift**: install from meterless.ai, add your NVIDIA key under Setup > Providers, seat Nemotron lanes, copy the Runtime API key from Console.
5. Fill `.env` from `.env.example`, then:

```bash
npm run zetaris:setup     # registers every source (idempotent)
npm run zetaris:check     # row counts per source and a cross-source join
npm run meterless:check   # Meterless provider contract checks and a test reply with its receipt
npm start                 # http://127.0.0.1:5180
```

## Tests

`npm test` runs 27 tests: strength, concentration and presentation matching, supplier-name matching and ISMP-safe strength display, the critic's code checks (wrong-strength NDCs, NDCs from another application, unsafe substitutes, citations never fetched, days-of-cover figures, ruled-out suppliers), the Meterless provider contract, the substitution guards (application numbers read from the model's answer; verified substitutes kept if the model drops them all), and the H-MEM buyer-memory feature end to end.

## How it was built

The scaffold, the hospital schema and the sample-data builder were written by Cursor's agent (`cursor-agent`) from the briefs in `docs/cursor-briefs/` (commits `a135ca1`, `148a973`). When the Cursor free plan's limit was reached on 22 October, the rest was written with Claude Code. The organisers then confirmed that Cursor would not provide credits, and the updated Submission Requirements (24 October) make Cursor optional.

## Data and limits

- Hospital stock, usage and purchase orders are **sample data** built on real FDA-listed products (`data/hospital/seed.sql` says so on line 1). The sample formulary deliberately includes products that are on the FDA shortage list today, so the demo has real shortages to find.
- All FDA data is real and public: openFDA drug shortages, enforcement reports and NDC directory, and the FDA Orange Book.
- Decision support only: a pharmacist reviews every order. "Interchangeable" means the FDA Orange Book TE code; "not on the FDA shortage list" is not the same as in stock at your wholesaler. Clinical alternatives (other strengths, other drugs) are left to the pharmacy team. US FDA data only.

## Pre-existing components

No application code existed before the build window (22 October 2026, 00:00 UTC). Third-party code: the Meterless H-MEM reference implementation (`vendor/meterless-hmem`, Apache-2.0, unchanged) and open-source npm packages.

## Licence

MIT (`LICENSE`). Vendored H-MEM: Apache-2.0 (`vendor/meterless-hmem/LICENSE`, `NOTICE.md`).
