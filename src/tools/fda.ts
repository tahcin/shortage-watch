import { orangeBookLink, recallLink, type Evidence } from "../evidence.js";
import { lit, query } from "../zetaris/client.js";
import { RECALLS, SHORTAGES } from "./snapshot.js";
import type { Item } from "./hospital.js";
import type { Pkg } from "./scout.js";

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

/** The item's own Orange Book row, then therapeutically equivalent products from other applications. */
export async function equivalentsFor(item: Item): Promise<{ own: ObRow | null; equivalents: ObRow[]; evidence: Evidence[] }> {
  const app = appNo(item.application_number);
  let ownRows: ObRow[] = [];
  if (app) {
    ({ rows: ownRows } = await query<ObRow>(`SELECT * FROM fda.orange_book_v WHERE appl_no = ${lit(app.no)} AND appl_type = ${lit(app.type)}`, 50));
  }
  // Prefer the row whose amount and volume match exactly (1MG/ML over 0.5MG/0.5ML), then same concentration.
  const exact = (a: string, b: string) => a.replace(/^[^\d.]+/, "").toLowerCase().replace(/\s|eq|base/g, "") === b.replace(/^[^\d.]+/, "").toLowerCase().replace(/\s|eq|base/g, "");
  const own = ownRows.find((r) => exact(r.strength, item.strength)) ?? ownRows.find((r) => sameConcentration(r.strength, item.strength)) ?? (ownRows.length === 1 ? ownRows[0]! : null);
  if (!own) return { own: null, equivalents: [], evidence: [] };

  // Same ingredient and dosage form/route; same concentration is checked in code so other vial sizes count.
  const { rows: candidates } = await query<ObRow>(`
SELECT * FROM fda.orange_book_v
WHERE ingredient = ${lit(own.ingredient)} AND df_route = ${lit(own.df_route)}
  AND te_code LIKE 'A%' AND type = 'RX' AND NOT (appl_no = ${lit(own.appl_no)} AND appl_type = ${lit(own.appl_type)})`, 300);
  const rows = candidates.filter((r) => sameConcentration(r.strength, own.strength));
  return {
    own,
    equivalents: rows,
    evidence: [obEvidence(own, " (our current product)"), ...rows.map((r) => obEvidence(r, ""))],
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
};

/**
 * Supply status of each equivalent, judged on ITS OWN package NDCs at our concentration (not the whole
 * application or label). One query for every candidate package on the shortage list, one for recalls.
 */
export async function substituteStatuses(equivalents: ObRow[], packagesByAppl: Map<string, Pkg[]>, own: ObRow | null): Promise<{ checks: Map<string, SubstituteCheck>; evidence: Evidence[] }> {
  const allNdcs = [...packagesByAppl.values()].flat().map((p) => p.ndc);
  const shortage = allNdcs.length
    ? ((await query(`SELECT generic_name, package_ndc, presentation, company_name, availability, shortage_reason, update_date, related_info, related_info_link, 'same_package' AS match
FROM ${SHORTAGES} WHERE package_ndc IN (${allNdcs.map(lit).join(", ")})`, 500)).rows as unknown as ShortageRow[])
    : [];
  const products = [...new Set([...packagesByAppl.values()].flat().map((p) => p.product_ndc))];
  const recalls = await recallsFor(products);
  const ownPf = own ? /PRESERVATIVE FREE/i.test(own.trade_name) : false;
  const checks = new Map<string, SubstituteCheck>();
  const seen = new Set<string>();
  for (const e of equivalents) {
    const appl = `${e.appl_type === "A" ? "ANDA" : "NDA"}${e.appl_no}`;
    if (seen.has(appl)) continue;
    seen.add(appl);
    const pkgs = packagesByAppl.get(appl) ?? [];
    const statuses = pkgs.map((pkg) => ({ pkg, availability: shortage.find((s) => s.package_ndc === pkg.ndc)?.availability ?? null }));
    const rows = shortage.filter((s) => pkgs.some((p) => p.ndc === s.package_ndc));
    const rec = recalls.rows.filter((r) => pkgs.some((p) => (r.product_ndcs ?? []).includes(p.product_ndc) || (r.package_ndcs ?? []).includes(p.ndc)));
    const recalled = rec.some((r) => /class i(i)?$/i.test(r.classification.trim()));
    const usable = statuses.filter((x) => x.availability === null || /^available$/i.test(x.availability));
    const verdict: SubstituteCheck["verdict"] = !pkgs.length ? "no_listing" : recalled ? "recalled" : !usable.length ? "constrained" : rows.length ? "listed_available" : "clear";
    const candPf = /PRESERVATIVE FREE/i.test(e.trade_name);
    const preservative_note = own && ownPf !== candPf ? (ownPf ? "Ours is preservative-free; this product is not labelled preservative-free. Pharmacist sign-off needed." : "This product is preservative-free; ours is not.") : null;
    checks.set(appl, { appl, applicant: e.applicant_full_name || e.applicant, packages: statuses, shortage: rows, recalls: rec, verdict, preservative_note });
  }
  return { checks, evidence: [...shortage.map(shortageEvidence), ...recalls.evidence] };
}
