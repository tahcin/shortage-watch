import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "data", "cache", "openfda");
const HOSPITAL_DIR = path.join(ROOT, "data", "hospital");
const USER_AGENT = "shortage-watch/0.1 (Open Agent Hackathon 2026; sample hospital builder)";
const MIN_DELAY_MS = 400;
const MAX_FETCH_ATTEMPTS = 4;
const SEED = 20261022;
const USAGE_DAYS = 90;

type Staple = {
  genericName: string;
  preferredForm: string;
};

type OpenFdaProduct = {
  product_ndc?: string;
  generic_name?: string | string[];
  brand_name?: string | string[];
  labeler_name?: string;
  dosage_form?: string;
  route?: string | string[];
  marketing_category?: string;
  product_type?: string;
  marketing_start_date?: string;
  marketing_end_date?: string;
  finished?: boolean;
  active_ingredients?: Array<{ name?: string; strength?: string }>;
  packaging?: Array<{
    package_ndc?: string;
    description?: string;
    marketing_start_date?: string;
    marketing_end_date?: string;
    sample?: boolean;
  }>;
  openfda?: {
    pharm_class_epc?: string[];
    pharm_class_cs?: string[];
    pharm_class_moa?: string[];
    pharm_class_pe?: string[];
  };
};

type OpenFdaResponse = {
  meta?: { results?: { total?: number } };
  results?: OpenFdaProduct[];
  error?: { code?: string; message?: string; details?: string };
};

type ChosenProduct = {
  genericName: string;
  preferredForm: string;
  queryUsed: string;
  searchAdjusted: boolean;
  productNdc: string;
  packageNdc: string;
  labeler: string;
  strength: string;
  dosageForm: string;
  route: string;
  therapeuticClass: string;
  brandName: string;
};

/** Hospital staples: generic name + preferred dosage form for openFDA search. */
const STAPLES: Staple[] = [
  { genericName: "midazolam", preferredForm: "INJECTION" },
  { genericName: "lidocaine", preferredForm: "INJECTION" },
  { genericName: "bupivacaine", preferredForm: "INJECTION" },
  { genericName: "cisplatin", preferredForm: "INJECTION" },
  { genericName: "carboplatin", preferredForm: "INJECTION" },
  { genericName: "methotrexate", preferredForm: "INJECTION" },
  { genericName: "fluorouracil", preferredForm: "INJECTION" },
  { genericName: "dexamethasone sodium phosphate", preferredForm: "INJECTION" },
  { genericName: "epinephrine", preferredForm: "INJECTION" },
  { genericName: "atropine sulfate", preferredForm: "INJECTION" },
  { genericName: "sodium bicarbonate", preferredForm: "INJECTION" },
  { genericName: "dextrose", preferredForm: "INJECTION" },
  { genericName: "furosemide", preferredForm: "INJECTION" },
  { genericName: "ondansetron", preferredForm: "INJECTION" },
  { genericName: "morphine sulfate", preferredForm: "INJECTION" },
  { genericName: "hydromorphone", preferredForm: "INJECTION" },
  { genericName: "fentanyl citrate", preferredForm: "INJECTION" },
  { genericName: "ketamine", preferredForm: "INJECTION" },
  { genericName: "propofol", preferredForm: "INJECTION, EMULSION" },
  { genericName: "vancomycin", preferredForm: "INJECTION" },
  { genericName: "cefazolin", preferredForm: "INJECTION" },
  { genericName: "ceftriaxone", preferredForm: "INJECTION" },
  { genericName: "amoxicillin", preferredForm: "FOR SUSPENSION" },
  { genericName: "albuterol", preferredForm: "SOLUTION" },
  { genericName: "heparin sodium", preferredForm: "INJECTION" },
  { genericName: "enoxaparin", preferredForm: "INJECTION" },
  { genericName: "potassium chloride", preferredForm: "INJECTION" },
  { genericName: "magnesium sulfate", preferredForm: "INJECTION" },
  { genericName: "labetalol", preferredForm: "INJECTION" },
  { genericName: "metoprolol tartrate", preferredForm: "INJECTION" },
  { genericName: "amiodarone", preferredForm: "INJECTION" },
  { genericName: "norepinephrine", preferredForm: "INJECTION" },
  { genericName: "vasopressin", preferredForm: "INJECTION" },
  { genericName: "rocuronium", preferredForm: "INJECTION" },
  { genericName: "succinylcholine", preferredForm: "INJECTION" },
  { genericName: "neostigmine", preferredForm: "INJECTION" },
  { genericName: "glycopyrrolate", preferredForm: "INJECTION" },
  { genericName: "famotidine", preferredForm: "INJECTION" },
  { genericName: "pantoprazole", preferredForm: "INJECTION" },
  { genericName: "acetaminophen", preferredForm: "INJECTION" },
  { genericName: "ketorolac", preferredForm: "INJECTION" },
  { genericName: "diphenhydramine", preferredForm: "INJECTION" },
  { genericName: "lorazepam", preferredForm: "INJECTION" },
  { genericName: "phenylephrine", preferredForm: "INJECTION" },
  { genericName: "methylprednisolone sodium succinate", preferredForm: "INJECTION" },
];

/** Extra openFDA URLs tried first for staples that need a tighter match (e.g. dextrose 50%). */
const CUSTOM_SEARCH_URLS: Record<string, string[]> = {
  dextrose: [
    'https://api.fda.gov/drug/ndc.json?search=generic_name:"dextrose"+AND+active_ingredients.strength:"25+g/50mL"&limit=20',
    'https://api.fda.gov/drug/ndc.json?search=generic_name:"dextrose"+AND+active_ingredients.strength:"50+g/100mL"&limit=20',
  ],
};

/** Fallback search queries when the preferred form returns nothing. */
const SEARCH_FALLBACKS: Record<string, Array<{ genericName: string; form: string }>> = {
  dextrose: [
    { genericName: "dextrose", form: "INJECTION, SOLUTION" },
    { genericName: "dextrose monohydrate", form: "INJECTION, SOLUTION" },
  ],
  propofol: [
    { genericName: "propofol", form: "INJECTION, EMULSION" },
    { genericName: "propofol", form: "EMULSION" },
  ],
  amoxicillin: [
    { genericName: "amoxicillin", form: "FOR SUSPENSION" },
    { genericName: "amoxicillin", form: "POWDER, FOR SUSPENSION" },
    { genericName: "amoxicillin", form: "SUSPENSION" },
  ],
  albuterol: [
    { genericName: "albuterol sulfate", form: "SOLUTION" },
    { genericName: "albuterol", form: "SOLUTION" },
    { genericName: "albuterol sulfate", form: "INHALATION SOLUTION" },
  ],
  "dexamethasone sodium phosphate": [
    { genericName: "dexamethasone sodium phosphate", form: "INJECTION, SOLUTION" },
    { genericName: "dexamethasone", form: "INJECTION" },
  ],
  "atropine sulfate": [
    { genericName: "atropine sulfate", form: "INJECTION, SOLUTION" },
    { genericName: "atropine", form: "INJECTION" },
  ],
  "morphine sulfate": [
    { genericName: "morphine sulfate", form: "INJECTION, SOLUTION" },
    { genericName: "morphine", form: "INJECTION" },
  ],
  "fentanyl citrate": [
    { genericName: "fentanyl citrate", form: "INJECTION, SOLUTION" },
    { genericName: "fentanyl", form: "INJECTION" },
  ],
  "heparin sodium": [
    { genericName: "heparin sodium", form: "INJECTION, SOLUTION" },
    { genericName: "heparin", form: "INJECTION" },
  ],
  enoxaparin: [
    { genericName: "enoxaparin sodium", form: "INJECTION" },
    { genericName: "enoxaparin sodium", form: "INJECTION, SOLUTION" },
  ],
  "metoprolol tartrate": [
    { genericName: "metoprolol tartrate", form: "INJECTION, SOLUTION" },
    { genericName: "metoprolol", form: "INJECTION" },
  ],
  "sodium bicarbonate": [
    { genericName: "sodium bicarbonate", form: "INJECTION, SOLUTION" },
  ],
  "potassium chloride": [
    { genericName: "potassium chloride", form: "INJECTION, SOLUTION" },
  ],
  "magnesium sulfate": [
    { genericName: "magnesium sulfate", form: "INJECTION, SOLUTION" },
  ],
  "methylprednisolone sodium succinate": [
    { genericName: "methylprednisolone sodium succinate", form: "INJECTION, POWDER, FOR SOLUTION" },
    { genericName: "methylprednisolone", form: "INJECTION" },
  ],
  succinylcholine: [
    { genericName: "succinylcholine chloride", form: "INJECTION" },
    { genericName: "succinylcholine chloride", form: "INJECTION, SOLUTION" },
  ],
  rocuronium: [
    { genericName: "rocuronium bromide", form: "INJECTION" },
    { genericName: "rocuronium bromide", form: "INJECTION, SOLUTION" },
  ],
  hydromorphone: [
    { genericName: "hydromorphone hydrochloride", form: "INJECTION" },
    { genericName: "hydromorphone hydrochloride", form: "INJECTION, SOLUTION" },
  ],
  ketamine: [
    { genericName: "ketamine hydrochloride", form: "INJECTION" },
    { genericName: "ketamine hydrochloride", form: "INJECTION, SOLUTION" },
  ],
  vancomycin: [
    { genericName: "vancomycin hydrochloride", form: "INJECTION" },
    { genericName: "vancomycin hydrochloride", form: "INJECTION, POWDER, FOR SOLUTION" },
  ],
  cefazolin: [
    { genericName: "cefazolin sodium", form: "INJECTION" },
    { genericName: "cefazolin sodium", form: "INJECTION, POWDER, FOR SOLUTION" },
  ],
  ceftriaxone: [
    { genericName: "ceftriaxone sodium", form: "INJECTION" },
    { genericName: "ceftriaxone sodium", form: "INJECTION, POWDER, FOR SOLUTION" },
  ],
  pantoprazole: [
    { genericName: "pantoprazole sodium", form: "INJECTION" },
    { genericName: "pantoprazole sodium", form: "INJECTION, POWDER, FOR SOLUTION" },
  ],
  ketorolac: [
    { genericName: "ketorolac tromethamine", form: "INJECTION" },
    { genericName: "ketorolac tromethamine", form: "INJECTION, SOLUTION" },
  ],
  diphenhydramine: [
    { genericName: "diphenhydramine hydrochloride", form: "INJECTION" },
    { genericName: "diphenhydramine hydrochloride", form: "INJECTION, SOLUTION" },
  ],
  phenylephrine: [
    { genericName: "phenylephrine hydrochloride", form: "INJECTION" },
    { genericName: "phenylephrine hydrochloride", form: "INJECTION, SOLUTION" },
  ],
  norepinephrine: [
    { genericName: "norepinephrine bitartrate", form: "INJECTION" },
    { genericName: "norepinephrine bitartrate", form: "INJECTION, SOLUTION" },
  ],
  neostigmine: [
    { genericName: "neostigmine methylsulfate", form: "INJECTION" },
    { genericName: "neostigmine methylsulfate", form: "INJECTION, SOLUTION" },
  ],
  amiodarone: [
    { genericName: "amiodarone hydrochloride", form: "INJECTION" },
    { genericName: "amiodarone hydrochloride", form: "INJECTION, SOLUTION" },
  ],
  labetalol: [
    { genericName: "labetalol hydrochloride", form: "INJECTION" },
    { genericName: "labetalol hydrochloride", form: "INJECTION, SOLUTION" },
  ],
  ondansetron: [
    { genericName: "ondansetron hydrochloride", form: "INJECTION" },
    { genericName: "ondansetron", form: "INJECTION, SOLUTION" },
  ],
  midazolam: [
    { genericName: "midazolam hydrochloride", form: "INJECTION" },
    { genericName: "midazolam", form: "INJECTION, SOLUTION" },
  ],
  lidocaine: [
    { genericName: "lidocaine hydrochloride", form: "INJECTION" },
    { genericName: "lidocaine", form: "INJECTION, SOLUTION" },
  ],
  bupivacaine: [
    { genericName: "bupivacaine hydrochloride", form: "INJECTION" },
    { genericName: "bupivacaine", form: "INJECTION, SOLUTION" },
  ],
  furosemide: [{ genericName: "furosemide", form: "INJECTION, SOLUTION" }],
  epinephrine: [
    { genericName: "epinephrine", form: "INJECTION, SOLUTION" },
    { genericName: "epinephrine hydrochloride", form: "INJECTION" },
  ],
  lorazepam: [{ genericName: "lorazepam", form: "INJECTION, SOLUTION" }],
  famotidine: [{ genericName: "famotidine", form: "INJECTION, SOLUTION" }],
  acetaminophen: [
    { genericName: "acetaminophen", form: "INJECTION, SOLUTION" },
    { genericName: "acetaminophen", form: "INJECTION" },
  ],
  vasopressin: [
    { genericName: "vasopressin", form: "INJECTION, SOLUTION" },
    { genericName: "vasopressin", form: "INJECTION" },
  ],
  glycopyrrolate: [
    { genericName: "glycopyrrolate", form: "INJECTION, SOLUTION" },
    { genericName: "glycopyrrolate", form: "INJECTION" },
  ],
  cisplatin: [{ genericName: "cisplatin", form: "INJECTION, SOLUTION" }],
  carboplatin: [{ genericName: "carboplatin", form: "INJECTION, SOLUTION" }],
  methotrexate: [
    { genericName: "methotrexate sodium", form: "INJECTION" },
    { genericName: "methotrexate", form: "INJECTION, SOLUTION" },
  ],
  fluorouracil: [{ genericName: "fluorouracil", form: "INJECTION, SOLUTION" }],
};

/** Chemo and specialty: low daily use. High: common OR / floor staples. */
const USAGE_TIER: Record<string, "high" | "medium" | "low"> = {
  midazolam: "medium",
  lidocaine: "high",
  bupivacaine: "medium",
  cisplatin: "low",
  carboplatin: "low",
  methotrexate: "low",
  fluorouracil: "low",
  "dexamethasone sodium phosphate": "medium",
  epinephrine: "medium",
  "atropine sulfate": "medium",
  "sodium bicarbonate": "high",
  dextrose: "high",
  furosemide: "high",
  ondansetron: "high",
  "morphine sulfate": "medium",
  hydromorphone: "medium",
  "fentanyl citrate": "medium",
  ketamine: "medium",
  propofol: "high",
  vancomycin: "medium",
  cefazolin: "high",
  ceftriaxone: "high",
  amoxicillin: "high",
  albuterol: "high",
  "heparin sodium": "high",
  enoxaparin: "medium",
  "potassium chloride": "high",
  "magnesium sulfate": "medium",
  labetalol: "medium",
  "metoprolol tartrate": "medium",
  amiodarone: "medium",
  norepinephrine: "medium",
  vasopressin: "low",
  rocuronium: "medium",
  succinylcholine: "medium",
  neostigmine: "medium",
  glycopyrrolate: "medium",
  famotidine: "medium",
  pantoprazole: "high",
  acetaminophen: "high",
  ketorolac: "medium",
  diphenhydramine: "medium",
  lorazepam: "medium",
  phenylephrine: "medium",
  "methylprednisolone sodium succinate": "medium",
};

const CRITICAL_NAMES = new Set([
  "epinephrine",
  "norepinephrine",
  "vasopressin",
  "succinylcholine",
  "rocuronium",
  "propofol",
  "midazolam",
  "fentanyl citrate",
  "morphine sulfate",
  "hydromorphone",
  "heparin sodium",
  "vancomycin",
  "cefazolin",
  "potassium chloride",
  "sodium bicarbonate",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mulberry32 seeded PRNG for reproducible sample usage and stock. */
function createRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function asString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex") + ".json";
}

/** openFDA wants quotes and + in the search query string. */
function buildOpenFdaUrl(genericName: string, dosageForm: string | null, limit = 20): string {
  const search =
    dosageForm === null
      ? `generic_name:"${genericName}"`
      : `generic_name:"${genericName}"+AND+dosage_form:"${dosageForm}"`;
  return `https://api.fda.gov/drug/ndc.json?search=${search}&limit=${limit}`;
}

function isTransientOpenFdaError(body: OpenFdaResponse, httpStatus: number): boolean {
  if (httpStatus === 429 || httpStatus === 503 || httpStatus >= 500) return true;
  const details =
    `${body.error?.code ?? ""} ${body.error?.message ?? ""} ${body.error?.details ?? ""}`.toLowerCase();
  return details.includes("unavailable") || details.includes("too many");
}

async function fetchOpenFda(url: string): Promise<OpenFdaResponse> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, cacheKey(url));
  try {
    const cached = await readFile(file, "utf8");
    const body = JSON.parse(cached) as OpenFdaResponse;
    const transientCached =
      !!body.error &&
      isTransientOpenFdaError(body, 503) &&
      !body.results?.length;
    if (!transientCached) {
      return body;
    }
  } catch {
    // miss
  }

  let lastBody: OpenFdaResponse = {};
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    await sleep(MIN_DELAY_MS * attempt);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    lastStatus = res.status;
    const text = await res.text();
    try {
      lastBody = JSON.parse(text) as OpenFdaResponse;
    } catch {
      throw new Error(`openFDA non-JSON for ${url}: HTTP ${res.status}`);
    }
    if (!isTransientOpenFdaError(lastBody, res.status)) {
      // Cache successes and stable NOT_FOUND only.
      await writeFile(file, JSON.stringify(lastBody, null, 2), "utf8");
      return lastBody;
    }
  }
  throw new Error(
    `openFDA transient failure for ${url} after ${MAX_FETCH_ATTEMPTS} attempts (HTTP ${lastStatus}): ${JSON.stringify(lastBody.error ?? lastBody)}`,
  );
}

function isCurrentlyMarketed(product: OpenFdaProduct): boolean {
  if (product.finished === false) return false;
  if (product.marketing_end_date) {
    const end = product.marketing_end_date;
    // Dates are YYYYMMDD strings from openFDA.
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, "0");
    const d = String(today.getUTCDate()).padStart(2, "0");
    const todayStr = `${y}${m}${d}`;
    if (end < todayStr) return false;
  }
  const type = (product.product_type ?? "").toUpperCase();
  if (type && !type.includes("HUMAN")) return false;
  return true;
}

function pickPackage(product: OpenFdaProduct): { packageNdc: string; description: string } | null {
  const packs = (product.packaging ?? []).filter((p) => {
    if (!p.package_ndc) return false;
    if (p.sample) return false;
    if (p.marketing_end_date) {
      const today = new Date();
      const y = today.getUTCFullYear();
      const m = String(today.getUTCMonth() + 1).padStart(2, "0");
      const d = String(today.getUTCDate()).padStart(2, "0");
      if (p.marketing_end_date < `${y}${m}${d}`) return false;
    }
    return true;
  });
  const first = packs[0];
  if (!first?.package_ndc) return null;
  return { packageNdc: first.package_ndc, description: first.description ?? "" };
}

function strengthFrom(product: OpenFdaProduct): string {
  const ingredients = product.active_ingredients ?? [];
  if (ingredients.length === 0) return "";
  return ingredients
    .map((i) => `${i.name ?? "unknown"} ${i.strength ?? ""}`.trim())
    .join("; ");
}

function therapeuticClassFrom(product: OpenFdaProduct): string {
  const o = product.openfda;
  if (!o) return "";
  return (
    o.pharm_class_epc?.[0] ??
    o.pharm_class_cs?.[0] ??
    o.pharm_class_moa?.[0] ??
    o.pharm_class_pe?.[0] ??
    ""
  );
}

function prefersDextrose50(product: OpenFdaProduct): boolean {
  const strength = strengthFrom(product).toLowerCase();
  const brand = asString(product.brand_name).toLowerCase();
  const ingredients = product.active_ingredients ?? [];
  // Prefer single-ingredient D50 (25 g/50 mL or 50 g/100 mL), not D5W admixtures.
  if (ingredients.length !== 1) return false;
  return (
    /25\s*g\/50\s*ml/.test(strength) ||
    /50\s*g\/100\s*ml/.test(strength) ||
    /50\s*%/.test(brand) ||
    /500\s*mg\/ml/.test(strength)
  );
}

function scoreProduct(product: OpenFdaProduct, staple: Staple): number {
  let score = 0;
  if (product.finished !== false) score += 10;
  if (isCurrentlyMarketed(product)) score += 20;
  if (pickPackage(product)) score += 15;
  const form = (product.dosage_form ?? "").toUpperCase();
  if (form.includes(staple.preferredForm.toUpperCase().split(",")[0]!.trim())) score += 5;
  if (staple.genericName === "dextrose" && prefersDextrose50(product)) score += 30;
  if ((product.labeler_name ?? "").length > 0) score += 2;
  return score;
}

function chooseFromResults(
  results: OpenFdaProduct[],
  staple: Staple,
): OpenFdaProduct | null {
  const candidates = results
    .filter((p) => isCurrentlyMarketed(p) && pickPackage(p))
    .map((p) => ({ p, score: scoreProduct(p, staple) }))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.p ?? null;
}

function chosenFromProduct(
  staple: Staple,
  product: OpenFdaProduct,
  url: string,
  adjusted: boolean,
  fallbackForm: string,
): ChosenProduct | null {
  const pkg = pickPackage(product);
  if (!pkg) return null;
  return {
    genericName: staple.genericName,
    preferredForm: staple.preferredForm,
    queryUsed: url,
    searchAdjusted: adjusted,
    productNdc: product.product_ndc ?? "",
    packageNdc: pkg.packageNdc,
    labeler: product.labeler_name ?? "",
    strength: strengthFrom(product),
    dosageForm: product.dosage_form ?? fallbackForm,
    route: asString(product.route),
    therapeuticClass: therapeuticClassFrom(product),
    brandName: asString(product.brand_name),
  };
}

async function resolveProduct(
  staple: Staple,
): Promise<{ chosen: ChosenProduct | null; adjusted: boolean; queriesTried: string[] }> {
  const queriesTried: string[] = [];
  let adjusted = false;

  // Custom strength/brand searches first (dextrose 50%, etc.).
  for (const url of CUSTOM_SEARCH_URLS[staple.genericName] ?? []) {
    queriesTried.push(url);
    const body = await fetchOpenFda(url);
    if (body.error?.code === "NOT_FOUND" || !body.results?.length) {
      adjusted = true;
      continue;
    }
    const product = chooseFromResults(body.results, staple);
    if (!product) {
      adjusted = true;
      continue;
    }
    const chosen = chosenFromProduct(staple, product, url, true, staple.preferredForm);
    if (chosen) return { chosen, adjusted: true, queriesTried };
    adjusted = true;
  }

  const attempts: Array<{ genericName: string; form: string | null }> = [
    { genericName: staple.genericName, form: staple.preferredForm },
    ...(SEARCH_FALLBACKS[staple.genericName] ?? []),
  ];
  // Also try INJECTION, SOLUTION as a common NDC form.
  if (!attempts.some((a) => a.form === "INJECTION, SOLUTION") && staple.preferredForm === "INJECTION") {
    attempts.push({ genericName: staple.genericName, form: "INJECTION, SOLUTION" });
  }
  // Last resort: generic name only, filter finished marketed packs in code.
  attempts.push({ genericName: staple.genericName, form: null });
  const saltFallbacks = SEARCH_FALLBACKS[staple.genericName] ?? [];
  for (const fb of saltFallbacks) {
    if (!attempts.some((a) => a.genericName === fb.genericName && a.form === null)) {
      attempts.push({ genericName: fb.genericName, form: null });
    }
  }

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    const url = buildOpenFdaUrl(attempt.genericName, attempt.form);
    queriesTried.push(url);
    const body = await fetchOpenFda(url);
    if (body.error?.code === "NOT_FOUND" || !body.results?.length) {
      if (i > 0 || queriesTried.length > 1) adjusted = true;
      continue;
    }
    const product = chooseFromResults(body.results, staple);
    if (!product) {
      if (i > 0 || queriesTried.length > 1) adjusted = true;
      continue;
    }
    if (i > 0 || attempt.genericName !== staple.genericName || attempt.form !== staple.preferredForm) {
      adjusted = true;
    }
    const chosen = chosenFromProduct(
      staple,
      product,
      url,
      adjusted,
      attempt.form ?? staple.preferredForm,
    );
    if (chosen) return { chosen, adjusted, queriesTried };
    adjusted = true;
  }

  return { chosen: null, adjusted: true, queriesTried };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function meanDailyUse(tier: "high" | "medium" | "low", rng: () => number): number {
  if (tier === "high") return 18 + rng() * 22; // ~18–40
  if (tier === "medium") return 4 + rng() * 10; // ~4–14
  return 0.4 + rng() * 1.6; // ~0.4–2.0 chemo/specialty
}

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function main(): Promise<void> {
  await mkdir(HOSPITAL_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const rng = createRng(SEED);
  const products: ChosenProduct[] = [];
  const adjustedNames: string[] = [];
  const missingNames: string[] = [];

  console.log(`Fetching ${STAPLES.length} staples from openFDA (cache: ${CACHE_DIR})...`);

  for (const staple of STAPLES) {
    process.stdout.write(`  ${staple.genericName}... `);
    const { chosen, adjusted, queriesTried } = await resolveProduct(staple);
    if (!chosen) {
      console.log(`NOT FOUND (tried ${queriesTried.length} queries)`);
      missingNames.push(staple.genericName);
      continue;
    }
    products.push(chosen);
    if (adjusted || chosen.searchAdjusted) {
      adjustedNames.push(`${staple.genericName} -> ${chosen.queryUsed}`);
      console.log(`ok (adjusted search), NDC ${chosen.packageNdc}`);
    } else {
      console.log(`ok, NDC ${chosen.packageNdc}`);
    }
  }

  if (products.length === 0) {
    throw new Error("No products resolved from openFDA; cannot write seed.");
  }

  // About one third critical: prefer the named set, then fill by rng.
  const criticalFlags = products.map((p) => CRITICAL_NAMES.has(p.genericName));
  let criticalCount = criticalFlags.filter(Boolean).length;
  const targetCritical = Math.round(products.length / 3);
  for (let i = 0; i < products.length && criticalCount < targetCritical; i++) {
    if (!criticalFlags[i] && rng() < 0.35) {
      criticalFlags[i] = true;
      criticalCount++;
    }
  }

  const today = new Date();
  const snapshotAt = today.toISOString();
  const startDay = addDays(today, -(USAGE_DAYS - 1));

  const lines: string[] = [];
  lines.push(
    `-- SAMPLE DATA: synthetic stock, usage and orders on real FDA-listed products (openFDA NDC directory). Generated ${today.toISOString()}. Not real hospital data.`,
  );
  lines.push("");
  lines.push("BEGIN;");
  lines.push("");

  // Formulary
  lines.push("-- Formulary: real openFDA NDC products");
  for (let i = 0; i < products.length; i++) {
    const p = products[i]!;
    const isCritical = criticalFlags[i]!;
    lines.push(
      `INSERT INTO formulary (generic_name, strength, dosage_form, route, package_ndc, product_ndc, labeler, therapeutic_class, is_critical) VALUES (${sqlString(p.genericName)}, ${sqlString(p.strength)}, ${sqlString(p.dosageForm)}, ${sqlString(p.route)}, ${sqlString(p.packageNdc)}, ${sqlString(p.productNdc)}, ${sqlString(p.labeler)}, ${sqlString(p.therapeuticClass)}, ${isCritical});`,
    );
  }
  lines.push("");

  // Inventory and usage
  lines.push("-- Inventory and 90 days of usage (seeded synthetic SAMPLE DATA)");
  const onHandByIndex: number[] = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i]!;
    const tier = USAGE_TIER[p.genericName] ?? "medium";
    const mean = meanDailyUse(tier, rng);
    const daysOfCover = 2 + rng() * 58; // 2–60
    const onHand = Math.max(1, Math.round(mean * daysOfCover));
    onHandByIndex.push(onHand);
    const itemRef = `(SELECT item_id FROM formulary WHERE package_ndc = ${sqlString(p.packageNdc)})`;
    lines.push(
      `INSERT INTO inventory (item_id, location, on_hand_units, snapshot_at) VALUES (${itemRef}, 'Central Pharmacy', ${onHand}, ${sqlString(snapshotAt)});`,
    );

    for (let dayOffset = 0; dayOffset < USAGE_DAYS; dayOffset++) {
      const day = addDays(startDay, dayOffset);
      // Poisson-ish noise around mean; keep non-negative integer.
      const noise = 0.5 + rng();
      const used = Math.max(0, Math.round(mean * noise));
      lines.push(
        `INSERT INTO usage_daily (item_id, day, units_used) VALUES (${itemRef}, ${sqlString(isoDateOnly(day))}, ${used});`,
      );
    }
  }
  lines.push("");

  // Purchase orders: a few open / backordered / received
  lines.push("-- Purchase orders (SAMPLE DATA)");
  const wholesalers = ["McKesson", "Cardinal Health", "AmerisourceBergen"];
  const poStatuses: Array<"open" | "backordered" | "received"> = [
    "open",
    "backordered",
    "open",
    "backordered",
    "received",
    "open",
    "backordered",
  ];
  const poCount = Math.min(7, products.length);
  for (let i = 0; i < poCount; i++) {
    const p = products[i]!;
    const status = poStatuses[i]!;
    const wholesaler = wholesalers[i % wholesalers.length]!;
    const orderedUnits = Math.max(10, Math.round((onHandByIndex[i] ?? 50) * (0.5 + rng())));
    const orderedOn = addDays(today, -((i + 1) * 3));
    const expectedOn = addDays(orderedOn, 7 + i);
    const itemRef = `(SELECT item_id FROM formulary WHERE package_ndc = ${sqlString(p.packageNdc)})`;
    lines.push(
      `INSERT INTO purchase_orders (po_id, item_id, wholesaler, ordered_units, ordered_on, expected_on, status) VALUES (${sqlString(`PO-SAMPLE-${String(i + 1).padStart(3, "0")}`)}, ${itemRef}, ${sqlString(wholesaler)}, ${orderedUnits}, ${sqlString(isoDateOnly(orderedOn))}, ${sqlString(isoDateOnly(expectedOn))}, ${sqlString(status)});`,
    );
  }

  lines.push("");
  lines.push("COMMIT;");
  lines.push("");

  const seedPath = path.join(HOSPITAL_DIR, "seed.sql");
  await writeFile(seedPath, lines.join("\n"), "utf8");

  const productsJson = {
    generatedAt: today.toISOString(),
    note: "SAMPLE DATA metadata: real FDA-listed products chosen via openFDA NDC; stock/usage/orders are synthetic.",
    seed: SEED,
    productCount: products.length,
    missingNames,
    adjustedSearches: adjustedNames,
    products: products.map((p, i) => ({
      ...p,
      isCritical: criticalFlags[i],
      usageTier: USAGE_TIER[p.genericName] ?? "medium",
    })),
  };
  const productsPath = path.join(HOSPITAL_DIR, "products.json");
  await writeFile(productsPath, JSON.stringify(productsJson, null, 2) + "\n", "utf8");

  console.log("");
  console.log(`Wrote ${products.length} products to ${seedPath}`);
  console.log(`Wrote product metadata to ${productsPath}`);
  if (adjustedNames.length) {
    console.log(`Adjusted searches (${adjustedNames.length}):`);
    for (const a of adjustedNames) console.log(`  - ${a}`);
  }
  if (missingNames.length) {
    console.log(`Missing (${missingNames.length}): ${missingNames.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
