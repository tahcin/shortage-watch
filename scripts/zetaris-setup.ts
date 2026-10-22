// Registers every Shortage Watch data source in Zetaris, in order, from zetaris/setup/*.sql.
// Safe to re-run: "already exists" counts as done, and views are dropped and re-created so a changed
// definition takes effect. Secrets (the hospital database password) are substituted from .env at run time.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { runSql, ZetarisError } from "../src/zetaris/client.js";

const dir = path.join(config.root, "zetaris", "setup");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
let failed = 0;

for (const file of files) {
  let sql = readFileSync(path.join(dir, file), "utf8").trim();
  if (sql.includes("${HOSPITAL_DB_PASSWORD}")) {
    if (!config.hospitalDbPassword) {
      console.log(`skip    ${file} (HOSPITAL_DB_PASSWORD not set)`);
      continue;
    }
    sql = sql.replaceAll("${HOSPITAL_DB_PASSWORD}", config.hospitalDbPassword);
  }
  const view = sql.match(/CREATE SCHEMASTORE VIEW (\w+) WITH CONTAINER (\w+)/i);
  if (view) {
    await runSql(`DROP SCHEMASTORE VIEW ${view[1]} FROM ${view[2]}`).catch(() => undefined);
  }
  try {
    const r = await runSql(sql);
    console.log(`ok      ${file} (${r.ms} ms)`);
  } catch (err) {
    const msg = err instanceof ZetarisError ? err.message : String(err);
    if (/already exists|duplicate/i.test(msg)) {
      console.log(`exists  ${file}`);
    } else {
      failed++;
      console.log(`FAILED  ${file}: ${msg.replace(config.hospitalDbPassword || "\u0000", "<hidden>").slice(0, 300)}`);
    }
  }
}

console.log(failed ? `\n${failed} statement(s) failed.` : "\nAll sources registered.");
process.exit(failed ? 1 : 0);
