# Brief 01: scaffold and sample hospital database

Read AGENTS.md first. Build the following, then run what can run locally and report.

1. Project scaffold: `package.json` (name `shortage-watch`, type module, Node >= 22, scripts: `build-sample`, `typecheck`), `tsconfig.json` (strict), `.gitignore` (node_modules, .env, data/cache/, logs/, dist/), `.env.example` (ZETARIS_REST_URL, ZETARIS_ORG_ID, ZETARIS_API_KEY, METERLESS_BASE_URL, METERLESS_RUNTIME_TOKEN, METERLESS_MODEL, HOSPITAL_DB_PASSWORD, all placeholders), `LICENSE` (MIT, copyright 2026 Tahcin Sarwar).

2. `data/hospital/schema.sql` (PostgreSQL 16):
   - `formulary(item_id serial pk, generic_name text, strength text, dosage_form text, route text, package_ndc text unique, product_ndc text, labeler text, therapeutic_class text, is_critical boolean)`
   - `inventory(item_id int fk, location text, on_hand_units int, snapshot_at timestamptz)`
   - `usage_daily(item_id int fk, day date, units_used int)`, primary key (item_id, day)
   - `purchase_orders(po_id text pk, item_id int fk, wholesaler text, ordered_units int, ordered_on date, expected_on date, status text)` with status in ('open','backordered','received')
   - a view `days_of_cover` = on-hand units / average daily use over the last 30 days, per item.

3. `scripts/build-sample-hospital.ts`: builds `data/hospital/seed.sql` from REAL products.
   - Start from this fixed list of hospital staples (generic name, preferred form): midazolam injection, lidocaine injection, bupivacaine injection, cisplatin injection, carboplatin injection, methotrexate injection, fluorouracil injection, dexamethasone sodium phosphate injection, epinephrine injection, atropine sulfate injection, sodium bicarbonate injection, dextrose 50% injection, furosemide injection, ondansetron injection, morphine sulfate injection, hydromorphone injection, fentanyl citrate injection, ketamine injection, propofol injectable emulsion, vancomycin injection, cefazolin injection, ceftriaxone injection, amoxicillin oral suspension, albuterol inhalation solution, heparin sodium injection, enoxaparin injection, potassium chloride injection, magnesium sulfate injection, labetalol injection, metoprolol tartrate injection, amiodarone injection, norepinephrine injection, vasopressin injection, rocuronium injection, succinylcholine injection, neostigmine injection, glycopyrrolate injection, famotidine injection, pantoprazole injection, acetaminophen injection, ketorolac injection, diphenhydramine injection, lorazepam injection, phenylephrine injection, methylprednisolone sodium succinate injection.
   - For each, query the openFDA NDC API (`https://api.fda.gov/drug/ndc.json?search=generic_name:"<name>"+AND+dosage_form:"<form>"&limit=20`, adjust the search if nothing matches) and pick one finished, currently marketed product and one of its packages. Record package NDC, product NDC, labeler, strength, dosage form, route and pharmacologic class.
   - Cache every HTTP response under `data/cache/openfda/` and wait at least 300 ms between requests. Use a User-Agent naming the project.
   - Generate 90 days of daily usage and a current on-hand count per item with a seeded random generator (seed 20261022) so the output is reproducible: usage scales by item (high for saline-type staples, low for chemotherapy); on-hand gives days of cover spread between 2 and 60; mark about a third of items `is_critical`. Add a few purchase orders, some `backordered`.
   - Write `data/hospital/seed.sql` starting with the comment `-- SAMPLE DATA: synthetic stock, usage and orders on real FDA-listed products (openFDA NDC directory). Generated <ISO date>. Not real hospital data.` Also write `data/hospital/products.json` with the chosen real product details and the openFDA query used for each.

4. `infra/hospital-db/docker-compose.yml`: service `hospital-db`, image `postgres:16-alpine`, `POSTGRES_DB=hospital`, user `buyer`, password from `${HOSPITAL_DB_PASSWORD}`, port `127.0.0.1:5433:5432`, named volume, mounts `../../data/hospital/schema.sql` and `../../data/hospital/seed.sql` into `/docker-entrypoint-initdb.d/` (schema first), healthcheck, and joins the external Docker network `zetaris_default` so the Zetaris query engine can reach it at `hospital-db:5432`.

5. A short `README.md` stub: one-paragraph description, "Status: in development (Open Agent Hackathon 2026)", and how to build the sample data.

Run `npm install`, `npm run typecheck` and `npm run build-sample`, fix any errors, and report: how many products were found, any names that needed a changed search, and the first 15 lines of seed.sql.
