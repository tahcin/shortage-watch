// Checks every source answers through Zetaris, then runs one query that joins the hospital database
// (Postgres) to the live FDA shortage list (openFDA REST) in a single SQL statement.

import { query } from "../src/zetaris/client.js";

const checks: Array<[string, string]> = [
  ["FDA current shortages (REST)", "SELECT count(*) AS n, count(distinct generic_name) AS drugs FROM fda.shortages_current_v"],
  ["FDA ongoing recalls (REST)", "SELECT count(*) AS n FROM fda.recalls_ongoing_v"],
  ["FDA Orange Book (file)", "SELECT count(*) AS n FROM fda.orange_book_v"],
  ["Hospital formulary (Postgres)", "SELECT count(*) AS n FROM hospital_pg.formulary"],
];

for (const [name, sql] of checks) {
  const { rows, ms } = await query(sql);
  console.log(`${name}: ${JSON.stringify(rows[0])} (${ms} ms)`);
}

const { rows, ms } = await query(`
SELECT f.generic_name, f.labeler, round(d.days_of_cover, 1) AS days_of_cover, s.availability, s.shortage_reason
FROM hospital_pg.formulary f
JOIN hospital_pg.days_of_cover d ON d.item_id = f.item_id
JOIN fda.shortages_current_v s ON s.package_ndc = f.package_ndc
ORDER BY d.days_of_cover
LIMIT 10`);
console.log(`\nHospital stock joined to live FDA shortages (${ms} ms):`);
console.table(rows);
