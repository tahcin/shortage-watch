# Brief 02: register every data source in Zetaris, repeatably

Read AGENTS.md first. The statements below were tested against our Zetaris instance on 2026-10-22 and work as written. Zetaris runs ONE statement per REST call.

## 1. `src/zetaris/client.ts`

A small typed client:
- `runSql(sql: string, opts?: { limit?: number; timeoutMs?: number }): Promise<{ headers: string[]; rows: unknown[][]; total: number; ms: number }>` posting to `${ZETARIS_REST_URL}/sql-editor/sqls/run` with body `{ queryId: uuid, sql, source: "SqlEditor", limit }` and headers `Authorization: Bearer ${ZETARIS_API_KEY}`, `X-Org-ID: ${ZETARIS_ORG_ID}`, `X-Request-ID: <fresh uuid>`, `Content-Type: application/json`.
- On HTTP 400 the body is `{ "msg": "..." }`: throw a `ZetarisError` carrying the message and the SQL.
- Retry up to 3 times with backoff when the message contains `Connection refused` or `timed out` (openFDA calls made by Zetaris fail transiently).
- `rowsAsObjects()` helper that zips headers and rows.
- Load settings with `dotenv`.

## 2. `zetaris/setup/*.sql` and `scripts/zetaris-setup.ts`

Put each statement in its own numbered file under `zetaris/setup/` (so the order is obvious and judges can read them), and write a script that runs them in order, treating these messages as "already done, continue": `already exists`, `Duplicate`. Print one line per statement with ok / skipped / failed.

Statements (tested):

```sql
CREATE LIGHTNING DATABASE OPENFDA_REST DESCRIBE BY "openFDA drug APIs shortages, enforcement, NDC"
```
(Descriptions may only contain letters, digits, `_ . - ,` and spaces.)

```sql
CREATE SCHEMASTORE CONTAINER fda
```

```sql
CREATE LIGHTNING REST TABLE shortages_current FROM OPENFDA_REST REQUEST(
    endpoint "https://api.fda.gov/drug/shortages.json?search=status:%22Current%22&limit=1000",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()
```
Same again as `shortages_current_p2` with `&skip=1000` (there are about 1,142 current entries; openFDA pages at 1,000).

Ongoing drug recalls: `recalls_ongoing` with endpoint `https://api.fda.gov/drug/enforcement.json?search=status:%22Ongoing%22&limit=1000`, plus `recalls_ongoing_p2` (`&skip=1000`) and `recalls_ongoing_p3` (`&skip=2000`) (about 2,797 ongoing).

Flattened views (drop with `DROP SCHEMASTORE VIEW <name> FROM fda` before re-creating if the definition changes):

```sql
CREATE SCHEMASTORE VIEW shortages_current_v WITH CONTAINER fda AS
SELECT r.generic_name, r.package_ndc, r.presentation, r.company_name, r.availability, r.shortage_reason, r.status, r.update_date, r.initial_posting_date, r.dosage_form, r.related_info_link, r.openfda.product_ndc AS product_ndcs, r.openfda.application_number AS application_numbers, r.openfda.substance_name AS substances, r.therapeutic_category
FROM openfda_rest.shortages_current LATERAL VIEW explode(results) AS r
UNION ALL
SELECT <same columns> FROM openfda_rest.shortages_current_p2 LATERAL VIEW explode(results) AS r
```

`recalls_ongoing_v` in the same container: from the three recall pages, columns `recall_number, event_id, status, classification, reason_for_recall, product_description, code_info, recalling_firm, recall_initiation_date, report_date, openfda.product_ndc AS product_ndcs, openfda.package_ndc AS package_ndcs, openfda.application_number AS application_numbers, openfda.generic_name AS generic_names`.

FDA Orange Book (file already placed in Zetaris platform storage by the operator; the setup script must not try to upload it, only register it):

```sql
CREATE LIGHTNING DATABASE FDA_FILES DESCRIBE BY "FDA reference files, Orange Book"
```
```sql
CREATE LIGHTNING FILESTORE TABLE orange_book_products FROM FDA_FILES FORMAT CSV OPTIONS (
  path "file:///home/zetaris/customer-data/shared/orangebook/products.txt",
  header "true",
  delimiter "~"
)
```
Columns: `Ingredient, DF;Route, Trade_Name, Applicant, Strength, Appl_Type, Appl_No, Product_No, TE_Code, Approval_Date, RLD, RS, Type, Applicant_Full_Name`. Add a view `fda.orange_book_v` that renames them to snake_case (`ingredient, df_route, trade_name, applicant, strength, appl_type, appl_no, product_no, te_code, approval_date, rld, rs, type, applicant_full_name`) using backticks for `DF;Route`.

Hospital database (Postgres on the same Docker network as Zetaris, reachable as `hospital-db:5432`):

```sql
CREATE DATASOURCE hospital_pg DESCRIBE BY "Sample hospital pharmacy database" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://hospital-db:5432/hospital",
  username "buyer",
  password "<from HOSPITAL_DB_PASSWORD>",
  fetchsize "1000"
)
```
Then `REGISTER DATASOURCE TABLE '<table>' FROM hospital_pg` for each hospital table and the `days_of_cover` view (check the exact REGISTER syntax in https://zetaris.github.io/getting-started/docs/guides/zetaris-lightning-sql-commands.html section 4.2 if the plain form fails, and report what worked). Never write the password into a committed file: the script substitutes it from `.env` at run time.

## 3. `scripts/zetaris-check.ts`

Runs and prints the result of:
- `SELECT count(*), count(distinct generic_name) FROM fda.shortages_current_v` (expect about 1,142 rows)
- `SELECT count(*) FROM fda.recalls_ongoing_v` (expect about 2,797)
- `SELECT count(*) FROM fda.orange_book_v` (expect about 48,864)
- one join across sources: hospital formulary items whose package or product NDC appears in current shortages, with days of cover.

Add npm scripts `zetaris:setup` and `zetaris:check`. Typecheck. Do not run `zetaris:setup` yourself (the operator runs it against the live instance); do run the typecheck and report.
