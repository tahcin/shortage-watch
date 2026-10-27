# Shortage Watch on Zetaris: the unified semantic layer

How Shortage Watch builds and uses a unified semantic layer (USL) in Zetaris, written against the "Build with Zetaris" evaluation criteria. Every statement below is in the repository: DDL in `zetaris/setup/`, the queries in `src/tools/`, and their recorded results in `samples/monday-morning/` and `runs/`.

## 1a. Use case and data sources

**Use case.** A hospital pharmacy buyer's weekly question: which of our drugs are about to run short, is it a real supply problem for *our exact package*, and what FDA-rated interchangeable product can we order instead. Answering it needs the hospital's own data and four FDA sources, joined at package level.

| # | Source | Kind | How Zetaris reaches it | DDL |
|---|---|---|---|---|
| 1 | Hospital stock: formulary, inventory, 90 days of usage, purchase orders, a days-of-cover view | Relational database (PostgreSQL) | `CREATE DATASOURCE hospital_pg` (JDBC) and `REGISTER DATASOURCE TABLE` for each table | `13`–`18-*.sql` |
| 2 | FDA drug shortages, status Current (1,142 package records) | REST API (openFDA) | `CREATE LIGHTNING REST TABLE` (two pages) and a schema-store view that flattens the JSON | `03`, `04`, `08` |
| 3 | FDA recalls (enforcement reports), status Ongoing (2,797) | REST API (openFDA) | Three paged REST tables and a flattening view | `05`–`07`, `09` |
| 4 | FDA Orange Book products (48,865 rows) | File (tilde-delimited CSV) | `CREATE LIGHTNING FILESTORE TABLE` and a view with clean column names | `10`–`12` |
| 5 | openFDA NDC directory, per ingredient | REST API, registered **by the agent at run time** | The source scout issues `CREATE LIGHTNING REST TABLE`, a view and a Parquet snapshot when a substitute is needed (`src/tools/scout.ts`) | generated, logged with its SQL in the trace |

## 1b. Onboarding, verification and exploratory queries

Every standing source is onboarded by `npm run zetaris:setup` (idempotent) and verified by `npm run zetaris:check`, which prints the row count of every source and runs a cross-source join. The agents' own queries are the exploratory set, and every one was recorded with its real result:

| Source | Queries (file) | What they ask |
|---|---|---|
| Hospital | `coverTable` (`src/tools/hospital.ts`): stock, usage and days of cover; open purchase orders | What we hold, how fast we use it, what is on order |
| Shortages | `shortageFor` (`src/tools/fda.ts`): our package, our product, our maker, the ingredient; snapshot row count | Is *our* package short, and how tight is the market |
| Recalls | `recallsFor`: by package and product NDC (array columns exploded); snapshot row count | Is our product, or a substitute, under an ongoing recall |
| Orange Book | `ownObRow`: our own application row; the equivalents inside the substitute board | Which products are rated interchangeable with ours |
| NDC directory | the substitute board's package expansion; snapshot row count | Which packages can actually be ordered, by whom, in what vial |

The recorded run issued 86 Zetaris requests across these sources (`samples/monday-morning/`, keys starting `zetaris:`).

## 1c. The USL, its DDL, and proof it is active

**The USL** is the `fda` schema-store container plus the `hospital_pg` datasource and the `fda_files` Parquet store: three FDA views (`shortages_current_v`, `recalls_ongoing_v`, `orange_book_v`) with consistent column names, the hospital tables, and the snapshots the agents query. Its DDL is the 18 files in `zetaris/setup/`, applied in order by `scripts/zetaris-setup.ts`.

**Queries showing it is active** (both federated across sources, both in the trace with their SQL and timing):

1. **Risk board**, once per run (`src/tools/board.ts`): one statement joins the hospital's formulary and days-of-cover view (JDBC) with the shortage snapshot and the exploded recall snapshot (REST, Parquet) and the Orange Book view (file). 45 items in about 1 second.
2. **Substitute board**, once per drug (`substituteBoardSql` in `src/tools/fda.ts`): one statement joins the Orange Book's A-rated equivalents (file), the NDC listing the scout registered minutes earlier (REST, Parquet, `posexplode` over the package list), the shortage snapshot and the recall snapshot. For midazolam: 131 rows in under a second.
3. **Snapshots**: each run materialises the live openFDA views into Parquet in Zetaris storage (`CREATE LIGHTNING FILESTORE TABLE ... sourceTable`) and reads them back (`src/tools/snapshot.ts`).

**Data quality rules that execute every run** (`fda_snapshot_status` and `register_zetaris_source` in the trace):

- *Snapshot must read back with rows*: after materialising, `SELECT count(*)` on the snapshot; an empty or unreadable snapshot is rebuilt, up to three times.
- *Paged sources must stay under their paging cap*: shortages (2 pages, 2,000 rows) and recalls (3 pages, 3,000 rows). A snapshot that reaches its cap is flagged in the trace as possibly incomplete.
- *Runtime NDC listings must stay under openFDA's 1,000-product limit.* This rule fired in the recorded run: the lidocaine listing returned exactly 1,000 products, so the scout's trace line is marked `needs_revision` ("may be incomplete").

## 2a. Time saved against a hand-coded approach

We have a direct comparison, because the substitute check was first written by hand. In commit `b55400d` it took four separate queries (own Orange Book row, equivalents, NDC packages, shortage status by package) plus two more for recalls, then joined them in TypeScript: `equivalentsFor`, `substituteStatuses` and `listingPackages`, about 84 lines of join and lookup code. In commit `f6ca9e5` the same check is **one federated statement of under 30 lines** (`substituteBoardSql`), and the TypeScript only filters by concentration and presentation.

Without Zetaris, the project would also have needed: an HTTP client with paging and retries for three openFDA endpoints, a parser for the Orange Book file, a Postgres client and connection handling, and a cache for snapshots. Our estimate is two to three days of that plumbing for one builder, against about half a day to write and verify the 18 setup files.

## 2b. Where a USL helps in real work, and where it does not

It helps wherever an answer needs an internal system and public reference data joined at a fine grain. In a hospital: pharmacy purchasing (this project), formulary review against FDA approvals, and recall response across stock in several systems. The buyer's question changes every week; with a USL, a new question is a new SQL statement, not a new pipeline.

It helps less when a source is a moving target per question. The NDC directory has to be registered per ingredient because a REST table is fixed to one URL, and when the hospital table gained a column, the registered table kept its old shape until it was dropped and registered again.

## 2c. How to make the USL stronger (a requirement, written as a PM)

**Problem.** Agents that investigate need sources they did not know about at design time, and sources whose shape changes. Today an agent must generate DDL text with run-specific names and timestamps, and a JDBC table that gains a column is silently stale.

**Requirements.**
1. **Parameterised REST tables**: one table whose query string takes parameters at query time, e.g. `SELECT * FROM openfda_rest.ndc WHERE search = 'generic_name:"midazolam"'`. One definition would replace one registered table per ingredient.
2. **Built-in paging**: a REST table option (`page_param "skip"`, `page_size 1000`, `max_rows`) instead of a hand-made table per page joined with `UNION ALL`, with a warning column when `max_rows` is reached.
3. **Snapshot lifecycle**: `REFRESH SNAPSHOT <table> IF OLDER THAN 6 HOURS`, so callers stop encoding capture times in file paths.
4. **Schema refresh for registered tables**: `REFRESH DATASOURCE TABLE formulary FROM hospital_pg` picks up new columns.
5. **Declarative quality rules**: `CREATE QUALITY RULE ... ON <table> CHECK (count(*) > 0 AND count(*) < 3000)`, evaluated on refresh and visible in query results.

**Example of the improved USL** (proposed syntax, not available today):

```sql
CREATE LIGHTNING REST TABLE ndc FROM OPENFDA_REST REQUEST(
  endpoint "https://api.fda.gov/drug/ndc.json?search={search}&limit=1000&skip={skip}",
  page_param "skip", page_size 1000, max_rows 5000
);
SELECT * FROM openfda_rest.ndc WHERE search = 'generic_name:"midazolam"';
```

## Note on the recorded run

The Zetaris instance ran on a separate Windows laptop (Docker, about 8 GB). Every Zetaris answer in `samples/` and `runs/` was returned by that live instance on 22 October 2026; sample mode replays them so judges can run the agent without it. See `runs/README.md`.
