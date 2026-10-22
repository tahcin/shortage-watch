import { orangeBookLink, recallLink, type Evidence } from "../evidence.js";
import { lit, query } from "../zetaris/client.js";
import { RECALLS, SHORTAGES } from "./snapshot.js";
import type { Item } from "./hospital.js";
import { isRepackager, parsePackage, type Pkg } from "./scout.js";

export type MatchType = "same_package" | "same_product" | "same_maker" | "same_ingredient";

export type ShortageRow = {
  generic_name: string;
  package_ndc: string;
  presentation: string;
  company_name: string;
  availability: string;
  shortage_reason: string | null;
  update_date: string;
  related_info: string | null;
  related_info_link: string | null;
  match: MatchType;
};

/** The first word(s) of the generic name that identify the active ingredient, for broad matching. */
export function ingredientKey(genericName: string): string {
  const stop = new Set(["sodium", "hydrochloride", "sulfate", "citrate", "tartrate", "bromide", "chloride", "phosphate", "succinate", "tromethamine", "methylsulfate", "lactate", "injection", "oral", "suspension", "solution"]);
  const words = genericName.toLowerCase().split(/\s+/).filter(Boolean);
  const head = words.filter((w) => !stop.has(w));
  // "sodium bicarbonate", "potassium chloride", "magnesium sulfate": keep the salt when it IS the drug.
  if (head.length === 0 || (words.length === 2 && ["sodium", "potassium", "magnesium"].includes(words[0]!))) return words.join(" ");
  return head[0]!;
}

function appNo(application: string): { type: string; no: string } | null {
  const m = application.toUpperCase().match(/^(ANDA|NDA|BLA)(\d+)$/);
  return m ? { type: m[1] === "ANDA" ? "A" : "N", no: m[2]!.padStart(6, "0") } : null;
}

/** "Next Delivery: January 2027; Estimated Recovery: March 2027; Shortage per Manufacturer: Manufacturing Delay" -> labelled parts. */
function relatedInfo(text: string | null): string {
  if (!text) return "";
  const parts = text.split(/;\s*/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const [k, ...v] = p.split(":");
    const val = v.join(":").trim();
    if (!val) return p;
    if (/shortage per manufacturer/i.test(k!)) return `manufacturer reports: ${val}`;
    if (/next delivery/i.test(k!)) return `next delivery: ${val}`;
    if (/estimated recovery/i.test(k!)) return `estimated recovery: ${val}`;
    return `${k!.trim().toLowerCase()}: ${val}`;
  });
  return parts.join("; ").slice(0, 500);
}

const shortageEvidence = (r: ShortageRow): Evidence => ({
  id: `shortage-${r.package_ndc}`,
  source: "fda-shortage",
  summary: `FDA shortage list: ${r.presentation || r.generic_name} from ${r.company_name}; availability: "${r.availability}"${r.shortage_reason ? `; FDA reason category: "${r.shortage_reason}"` : ""}${r.related_info ? `; ${relatedInfo(r.related_info)}` : ""}; updated ${r.update_date}`,
  data: { ...r },
  link: r.related_info_link || "https://dps.fda.gov/drugshortages",
});

/** First word of a company name, for matching "Fresenius Kabi USA, LLC" to "FRESENIUS KABI USA". */
export function makerKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/)[0] ?? "";
}

/**
 * Shortage records touching this item. Ours means the exact package or product NDC (the openFDA
 * application field lists every application on a shared label, so it is NOT used to decide "ours").
 * Same maker's other presentations and other makers of the ingredient are separate, softer signals.
 */
export async function shortageFor(item: Item): Promise<{ rows: ShortageRow[]; evidence: Evidence[] }> {
  const key = ingredientKey(item.generic_name);
  const maker = makerKey(item.labeler);
  const { rows } = await query(`
SELECT generic_name, package_ndc, presentation, company_name, availability, shortage_reason, update_date, related_info, related_info_link,
  CASE WHEN package_ndc = ${lit(item.package_ndc)} THEN 'same_package'
       WHEN package_ndc LIKE ${lit(`${item.product_ndc}-%`)} THEN 'same_product'
       WHEN lower(company_name) LIKE ${lit(`${maker}%`)} THEN 'same_maker'
       ELSE 'same_ingredient' END AS match
FROM ${SHORTAGES}
WHERE package_ndc = ${lit(item.package_ndc)}
   OR package_ndc LIKE ${lit(`${item.product_ndc}-%`)}
   OR lower(generic_name) LIKE ${lit(`${key}%`)}`, 500);
  const typed = rows.map((r) => ({ ...r, match: r.match as MatchType }) as ShortageRow);
  return { rows: typed, evidence: typed.map(shortageEvidence) };
}

export type RecallRow = { recall_number: string; classification: string; reason_for_recall: string; product_description: string; recalling_firm: string; recall_initiation_date: string; report_date: string; product_ndcs?: string[]; package_ndcs?: string[] };

/** Ongoing FDA recalls touching any of these package or product NDCs. */
export async function recallsFor(ndcs: string[]): Promise<{ rows: RecallRow[]; evidence: Evidence[] }> {
  const conds = [...new Set(ndcs.filter(Boolean))].flatMap((n) => [`array_contains(product_ndcs, ${lit(n)})`, `array_contains(package_ndcs, ${lit(n)})`]);
  if (!conds.length) return { rows: [], evidence: [] };
  const { rows } = await query<RecallRow>(`
SELECT recall_number, classification, reason_for_recall, product_description, recalling_firm, recall_initiation_date, report_date,
       product_ndcs, package_ndcs
FROM ${RECALLS} WHERE ${conds.join(" OR ")}`, 200);
  return {
    rows,
    evidence: rows.map((r) => ({
      id: `recall-${r.recall_number}`,
      source: "fda-recall",
      summary: `FDA recall ${r.recall_number} (${r.classification}, ongoing) by ${r.recalling_firm}: ${String(r.reason_for_recall).slice(0, 220)}`,
      data: { ...r },
      link: recallLink(r.recall_number),
    })),
  };
}

export type ObRow = { ingredient: string; df_route: string; trade_name: string; applicant: string; applicant_full_name: string; strength: string; appl_type: string; appl_no: string; product_no: string; te_code: string | null; type: string };

const obEvidence = (r: ObRow, note: string): Evidence => ({
  id: `ob-${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}-${r.product_no}`,
  source: "orange-book",
  summary: `Orange Book: ${r.trade_name} ${r.strength} (${r.df_route}) by ${r.applicant_full_name || r.applicant}, application ${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}, TE code ${r.te_code ?? "none"}${note}`,
  data: { ...r },
  link: orangeBookLink(r.appl_no, r.product_no, r.appl_type),
});

export type Concentration = { value: number; unit: "mg/ml" | "meq/ml" | "u/ml" | "mg" | "meq" | "u" };

const MASS: Record<string, number> = { g: 1000, gm: 1000, mg: 1, mcg: 0.001, ug: 0.001 };
const VOLUME: Record<string, number> = { ml: 1, l: 1000 };

/**
 * Parses a strength string into a comparable concentration, so "1 mg/mL", "EQ 1MG BASE/ML", "1%",
 * "8MG/20ML (0.4MG/ML)" and "MIDAZOLAM HYDROCHLORIDE 1 mg/mL" can be compared as numbers.
 */
export function parseConcentration(raw: string): Concentration | null {
  let s = raw.toLowerCase().split(";")[0]!;
  const paren = s.match(/\(([^)]*\/[^)]*)\)/);
  if (paren) s = paren[1]!;
  s = s.replace(/\[usp'u\]|usp units|units|unit|iu/g, "u").replace(/,/g, "");
  const pct = s.match(/([\d.]+)\s*%/);
  if (pct) return { value: Number(pct[1]) * 10, unit: "mg/ml" };
  const m = s.match(/([\d.]+)\s*(g|gm|mg|mcg|ug|meq|u)\b[^/\d]*(?:\/\s*([\d.]*)\s*(ml|l)\b)?/);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2]!;
  const perVol = m[4] ? (m[3] ? Number(m[3]) : 1) * VOLUME[m[4]]! : null;
  if (unit === "meq") return perVol ? { value: amount / perVol, unit: "meq/ml" } : { value: amount, unit: "meq" };
  if (unit === "u") return perVol ? { value: amount / perVol, unit: "u/ml" } : { value: amount, unit: "u" };
  const mg = amount * MASS[unit]!;
  return perVol ? { value: mg / perVol, unit: "mg/ml" } : { value: mg, unit: "mg" };
}

export function sameConcentration(a: string, b: string): boolean {
  const x = parseConcentration(a);
  const y = parseConcentration(b);
  if (!x || !y || x.unit !== y.unit) return false;
  return Math.abs(x.value - y.value) <= 0.02 * Math.max(x.value, y.value);
}

/** The item's own Orange Book row: exact amount and volume first (1MG/ML over 0.5MG/0.5ML), then same concentration. */
export async function ownObRow(item: Item): Promise<ObRow | null> {
  const app = appNo(item.application_number);
  if (!app) return null;
  const { rows } = await query<ObRow>(`SELECT * FROM fda.orange_book_v WHERE appl_no = ${lit(app.no)} AND appl_type = ${lit(app.type)}`, 50);
  const exact = (a: string, b: string) => a.replace(/^[^\d.]+/, "").toLowerCase().replace(/\s|eq|base/g, "") === b.replace(/^[^\d.]+/, "").toLowerCase().replace(/\s|eq|base/g, "");
  return rows.find((r) => exact(r.strength, item.strength)) ?? rows.find((r) => sameConcentration(r.strength, item.strength)) ?? (rows.length === 1 ? rows[0]! : null);
}

/**
 * The substitute board: ONE Zetaris query per ingredient that joins four sources. The FDA Orange Book
 * (CSV file) gives every A-rated equivalent; the openFDA NDC directory (the REST source the scout
 * registered at run time, snapshotted to Parquet) gives each equivalent's packages; the FDA shortage and
 * recall snapshots give each package's supply status. Code then keeps our concentration and presentation.
 */
export function substituteBoardSql(item: Item, own: ObRow, ndcTable: string): string {
  return `WITH ob AS (
  SELECT concat(CASE appl_type WHEN 'A' THEN 'ANDA' ELSE 'NDA' END, appl_no) AS appl, appl_type, appl_no, product_no, trade_name,
         applicant, applicant_full_name, strength, te_code, ingredient, df_route, type
  FROM fda.orange_book_v
  WHERE ingredient = ${lit(own.ingredient)} AND df_route = ${lit(own.df_route)} AND te_code LIKE 'A%' AND type = 'RX'
    AND NOT (appl_no = ${lit(own.appl_no)} AND appl_type = ${lit(own.appl_type)})
), pk AS (
  SELECT n.application_number AS appl, n.product_ndc, n.labeler_name, n.brand_name, n.dosage_form, n.strength AS listed_strength,
         n.dea_schedule, n.listing_expiration_date, trim(ndc) AS package_ndc, trim(descr) AS package_description
  FROM ${ndcTable} n
  LATERAL VIEW posexplode(split(n.package_ndcs, ' [|] ')) a AS i, ndc
  LATERAL VIEW posexplode(split(n.package_descriptions, ' [|] ')) b AS j, descr
  WHERE i = j AND (n.application_number IN (SELECT appl FROM ob) OR n.product_ndc = ${lit(item.product_ndc)})
), rec AS (
  SELECT recall_number, classification, reason_for_recall, recalling_firm, pndc
  FROM ${RECALLS} LATERAL VIEW explode(product_ndcs) t AS pndc
)
SELECT coalesce(ob.appl, pk.appl) AS appl, ob.appl_type, ob.appl_no, ob.product_no, ob.trade_name, ob.applicant, ob.applicant_full_name,
       ob.strength, ob.te_code, ob.ingredient, ob.df_route, ob.type,
       pk.product_ndc, pk.labeler_name, pk.brand_name, pk.dosage_form, pk.listed_strength, pk.dea_schedule, pk.listing_expiration_date,
       pk.package_ndc, pk.package_description,
       s.availability, s.generic_name AS shortage_generic, s.presentation, s.company_name, s.shortage_reason, s.update_date, s.related_info, s.related_info_link,
       r.recall_number, r.classification, r.reason_for_recall, r.recalling_firm
FROM ob FULL OUTER JOIN pk ON pk.appl = ob.appl
LEFT JOIN ${SHORTAGES} s ON s.package_ndc = pk.package_ndc
LEFT JOIN rec r ON r.pndc = pk.product_ndc`;
}

type BoardRow = Partial<ObRow> & {
  appl: string; product_ndc: string | null; labeler_name: string | null; brand_name: string | null; dosage_form: string | null; listed_strength: string | null;
  dea_schedule: string | null; listing_expiration_date: string | null; package_ndc: string | null; package_description: string | null;
  availability: string | null; shortage_generic: string | null; presentation: string | null; company_name: string | null; shortage_reason: string | null;
  update_date: string | null; related_info: string | null; related_info_link: string | null;
  recall_number: string | null; classification: string | null; reason_for_recall: string | null; recalling_firm: string | null;
};

export type SubstituteBoard = {
  sql: string;
  ms: number;
  rows: number;
  equivalents: ObRow[];
  /** Every manufacturer package of those equivalents (and our own product), repackagers removed. */
  packages: Pkg[];
  shortage: ShortageRow[];
  recalls: RecallRow[];
  evidence: Evidence[];
};

export async function substituteBoard(item: Item, own: ObRow, ndcTable: string): Promise<SubstituteBoard> {
  const sql = substituteBoardSql(item, own, ndcTable);
  const { rows, ms } = await query<BoardRow>(sql, 5000);
  const eqSeen = new Map<string, ObRow>();
  const pkgSeen = new Map<string, Pkg>();
  const shortage = new Map<string, ShortageRow>();
  const recalls = new Map<string, RecallRow & { product_ndcs: string[] }>();
  for (const r of rows) {
    if (r.appl_no && r.product_no && r.strength && sameConcentration(r.strength, own.strength)) {
      eqSeen.set(`${r.appl}-${r.product_no}`, { ingredient: r.ingredient!, df_route: r.df_route!, trade_name: r.trade_name!, applicant: r.applicant!, applicant_full_name: r.applicant_full_name!, strength: r.strength, appl_type: r.appl_type!, appl_no: r.appl_no, product_no: r.product_no, te_code: r.te_code ?? null, type: r.type! });
    }
    if (r.package_ndc && r.labeler_name && !isRepackager(r.labeler_name) && !pkgSeen.has(r.package_ndc)) {
      pkgSeen.set(r.package_ndc, { ndc: r.package_ndc, product_ndc: r.product_ndc!, labeler: r.labeler_name, application_number: r.appl, strength: r.listed_strength ?? "", description: r.package_description ?? "", dea_schedule: r.dea_schedule ?? null, ...parsePackage(r.package_description ?? "") });
    }
    if (r.package_ndc && r.availability && !shortage.has(r.package_ndc)) {
      shortage.set(r.package_ndc, { generic_name: r.shortage_generic ?? "", package_ndc: r.package_ndc, presentation: r.presentation ?? "", company_name: r.company_name ?? "", availability: r.availability, shortage_reason: r.shortage_reason, update_date: r.update_date ?? "", related_info: r.related_info, related_info_link: r.related_info_link, match: "same_ingredient" });
    }
    if (r.recall_number && r.product_ndc) {
      const prev = recalls.get(r.recall_number);
      if (prev) { if (!prev.product_ndcs.includes(r.product_ndc)) prev.product_ndcs.push(r.product_ndc); }
      else recalls.set(r.recall_number, { recall_number: r.recall_number, classification: r.classification ?? "", reason_for_recall: r.reason_for_recall ?? "", product_description: "", recalling_firm: r.recalling_firm ?? "", recall_initiation_date: "", report_date: "", product_ndcs: [r.product_ndc] });
    }
  }
  const equivalents = [...eqSeen.values()];
  const packages = [...pkgSeen.values()];
  const listings = new Map<string, Pkg[]>();
  for (const p of packages) listings.set(p.product_ndc, [...(listings.get(p.product_ndc) ?? []), p]);
  return {
    sql,
    ms,
    rows: rows.length,
    equivalents,
    packages,
    shortage: [...shortage.values()],
    recalls: [...recalls.values()],
    evidence: [
      obEvidence(own, " (our current product)"),
      ...equivalents.map((r) => obEvidence(r, "")),
      ...[...listings.entries()].map(([productNdc, pk]) => ({
        id: `ndc-${productNdc}`,
        source: "fda-ndc" as const,
        summary: `openFDA NDC directory: ${pk[0]!.strength} by ${pk[0]!.labeler}, ${pk[0]!.application_number}${pk[0]!.dea_schedule ? `, DEA schedule ${pk[0]!.dea_schedule}` : ""}; packages: ${pk.map((x) => `${x.ndc} (${(x.description.split("/").pop() ?? "").trim()})`).join("; ").slice(0, 400)}`,
        data: { product_ndc: productNdc, application_number: pk[0]!.application_number, labeler: pk[0]!.labeler, packages: pk.map((x) => x.ndc) },
        link: `https://api.fda.gov/drug/ndc.json?search=product_ndc:%22${productNdc}%22`,
      })),
      ...[...shortage.values()].map(shortageEvidence),
      ...[...recalls.values()].map((r) => ({ id: `recall-${r.recall_number}`, source: "fda-recall" as const, summary: `FDA recall ${r.recall_number} (${r.classification}, ongoing) by ${r.recalling_firm}: ${String(r.reason_for_recall).slice(0, 220)}`, data: { ...r }, link: recallLink(r.recall_number) })),
    ],
  };
}

export type PackageStatus = { pkg: Pkg; availability: string | null };

export type SubstituteCheck = {
  appl: string;
  applicant: string;
  packages: PackageStatus[];
  shortage: ShortageRow[];
  recalls: RecallRow[];
  verdict: "clear" | "listed_available" | "constrained" | "recalled" | "no_listing";
  preservative_note: string | null;
  /** The Orange Book product name says preservative-free. */
  preservative_free: boolean;
};

/**
 * Supply status of each equivalent, judged on ITS OWN package NDCs at our concentration (not the whole
 * application or label), from the substitute board's shortage and recall columns.
 */
export function checksFromBoard(equivalents: ObRow[], packagesByAppl: Map<string, Pkg[]>, own: ObRow | null, board: SubstituteBoard): Map<string, SubstituteCheck> {
  const ownPf = own ? /PRESERVATIVE FREE/i.test(own.trade_name) : false;
  const checks = new Map<string, SubstituteCheck>();
  for (const e of equivalents) {
    const appl = `${e.appl_type === "A" ? "ANDA" : "NDA"}${e.appl_no}`;
    if (checks.has(appl)) continue;
    const pkgs = packagesByAppl.get(appl) ?? [];
    const statuses = pkgs.map((pkg) => ({ pkg, availability: board.shortage.find((s) => s.package_ndc === pkg.ndc)?.availability ?? null }));
    const rows = board.shortage.filter((s) => pkgs.some((p) => p.ndc === s.package_ndc));
    const rec = board.recalls.filter((r) => pkgs.some((p) => (r.product_ndcs ?? []).includes(p.product_ndc)));
    const recalled = rec.some((r) => /class i(i)?$/i.test(r.classification.trim()));
    const usable = statuses.filter((x) => x.availability === null || /^available$/i.test(x.availability));
    const verdict: SubstituteCheck["verdict"] = !pkgs.length ? "no_listing" : recalled ? "recalled" : !usable.length ? "constrained" : rows.length ? "listed_available" : "clear";
    const candPf = /PRESERVATIVE FREE/i.test(e.trade_name);
    const preservative_note = own && ownPf !== candPf ? (ownPf ? "Ours is preservative-free; this product is not labelled preservative-free. Pharmacist sign-off needed." : "This product is preservative-free; ours is not.") : null;
    checks.set(appl, { appl, applicant: e.applicant_full_name || e.applicant, packages: statuses, shortage: rows, recalls: rec, verdict, preservative_note, preservative_free: candPf });
  }
  return checks;
}
