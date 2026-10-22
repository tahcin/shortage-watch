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
const NDC_SEARCH_LIMIT = 100;

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
  application_number?: string;
  finished?: boolean;
  pharm_class?: string[];
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

type ShortageRecord = {
  package_ndc?: string;
  generic_name?: string;
  availability?: string;
  status?: string;
  therapeutic_category?: string[];
  openfda?: {
    package_ndc?: string[];
    product_ndc?: string[];
    generic_name?: string[];
  };
};

type ShortageResponse = {
  meta?: { results?: { total?: number } };
  results?: ShortageRecord[];
  error?: { code?: string; message?: string; details?: string };
};

type ShortageIndex = {
  /** Normalized package NDC -> availability text */
  byPackageNdc: Map<string, string>;
  /** Lowercased base generic token -> package NDCs on the list */
  byGenericToken: Map<string, Set<string>>;
  /** Lowercased base generic token -> therapeutic category text */
  therapeuticByGeneric: Map<string, string>;
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
  applicationNumber: string;
  onShortageListAtBuild: boolean;
  shortageAvailability: string | null;
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

/** Extra openFDA URLs tried first for staples that need a tighter match. */
const CUSTOM_SEARCH_URLS: Record<string, string[]> = {
  dextrose: [
    'https://api.fda.gov/drug/ndc.json?search=generic_name:"dextrose"+AND+active_ingredients.strength:"25+g/50mL"&limit=100',
    'https://api.fda.gov/drug/ndc.json?search=generic_name:"dextrose"+AND+active_ingredients.strength:"50+g/100mL"&limit=100',
    'https://api.fda.gov/drug/ndc.json?search=generic_name:"dextrose"+AND+active_ingredients.strength:"500+mg/mL"&limit=100',
  ],
  epinephrine: [
    'https://api.fda.gov/drug/ndc.json?search=generic_name:"epinephrine"+AND+active_ingredients.strength:"1+mg/mL"&limit=100',
  ],
  "heparin sodium": [
    'https://api.fda.gov/drug/ndc.json?search=generic_name:"heparin+sodium"+AND+dosage_form:"INJECTION"+AND+finished:true&limit=100',
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

/** Named repackagers / relabelers that a hospital buyer would not stock as "our product". */
const LABELER_DENY_EXACT = [
  "a-s medication solutions",
  "hf acquisition co llc, dba healthfirst",
  "hf acquisition",
  "healthfirst",
  "propharma distribution",
  "henry schein",
  "henry schein, inc.",
  "medical purchasing solutions",
  "medical purchasing solutions, llc",
  "general injectables and vaccines",
  "general injectables & vaccines",
  "cardinal health 107",
  "cardinal health 107, llc",
  "nucare",
  "nucare pharmaceuticals",
  "proficient rx",
  "proficient rx lp",
  "quality care products",
  "remedyrepack",
  "asclemed",
  "asclemed usa, inc.",
  "enovachem",
  "fagron",
  "direct_rx",
  "direct rx",
  "bryant ranch prepack",
  "pd-rx",
  "pd-rx pharmaceuticals",
  "preferred pharmaceuticals",
];

const LABELER_DENY_SUBSTRINGS = [
  "repack",
  "relabel",
  "medication solutions",
  "distribution",
  "healthfirst",
  "purchasing solutions",
];

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

function normalizeNdc(ndc: string): string {
  return ndc.replace(/[^0-9]/g, "");
}

function todayYyyymmdd(): string {
  const today = new Date();
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** openFDA wants quotes and + in the search query string. */
function buildOpenFdaUrl(genericName: string, dosageForm: string | null, limit = NDC_SEARCH_LIMIT): string {
  const search =
    dosageForm === null
      ? `generic_name:"${genericName}"`
      : `generic_name:"${genericName}"+AND+dosage_form:"${dosageForm}"`;
  return `https://api.fda.gov/drug/ndc.json?search=${search}&limit=${limit}`;
}

function isTransientOpenFdaError(
  body: OpenFdaResponse | ShortageResponse,
  httpStatus: number,
): boolean {
  if (httpStatus === 429 || httpStatus === 503 || httpStatus >= 500) return true;
  const details =
    `${body.error?.code ?? ""} ${body.error?.message ?? ""} ${body.error?.details ?? ""}`.toLowerCase();
  return details.includes("unavailable") || details.includes("too many");
}

async function fetchJsonCached<T extends OpenFdaResponse | ShortageResponse>(url: string): Promise<T> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, cacheKey(url));
  try {
    const cached = await readFile(file, "utf8");
    const body = JSON.parse(cached) as T;
    const transientCached =
      !!body.error && isTransientOpenFdaError(body, 503) && !("results" in body && body.results?.length);
    if (!transientCached) {
      return body;
    }
  } catch {
    // miss
  }

  let lastBody: T = {} as T;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    await sleep(MIN_DELAY_MS * attempt);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    lastStatus = res.status;
    const text = await res.text();
    try {
      lastBody = JSON.parse(text) as T;
    } catch {
      throw new Error(`openFDA non-JSON for ${url}: HTTP ${res.status}`);
    }
    if (!isTransientOpenFdaError(lastBody, res.status)) {
      await writeFile(file, JSON.stringify(lastBody, null, 2), "utf8");
      return lastBody;
    }
  }
  throw new Error(
    `openFDA transient failure for ${url} after ${MAX_FETCH_ATTEMPTS} attempts (HTTP ${lastStatus}): ${JSON.stringify(lastBody.error ?? lastBody)}`,
  );
}

async function fetchOpenFda(url: string): Promise<OpenFdaResponse> {
  return fetchJsonCached<OpenFdaResponse>(url);
}

async function fetchShortageList(): Promise<ShortageIndex> {
  const urls = [
    'https://api.fda.gov/drug/shortages.json?search=status:"Current"&limit=1000',
    'https://api.fda.gov/drug/shortages.json?search=status:"Current"&limit=1000&skip=1000',
  ];
  const byPackageNdc = new Map<string, string>();
  const byGenericToken = new Map<string, Set<string>>();
  const therapeuticByGeneric = new Map<string, string>();

  console.log("Fetching current FDA shortage list (cached)...");
  for (const url of urls) {
    const body = await fetchJsonCached<ShortageResponse>(url);
    if (body.error?.code === "NOT_FOUND" || !body.results?.length) continue;
    for (const row of body.results) {
      const availability = row.availability ?? "";
      const packageNdcs = new Set<string>();
      if (row.package_ndc) packageNdcs.add(row.package_ndc);
      for (const p of row.openfda?.package_ndc ?? []) packageNdcs.add(p);

      const genericTexts = [
        row.generic_name ?? "",
        ...(row.openfda?.generic_name ?? []),
      ];
      const tokens = new Set<string>();
      for (const g of genericTexts) {
        for (const token of genericTokens(g)) tokens.add(token);
      }

      for (const raw of packageNdcs) {
        const norm = normalizeNdc(raw);
        if (!norm) continue;
        if (!byPackageNdc.has(norm)) byPackageNdc.set(norm, availability);
        for (const token of tokens) {
          let set = byGenericToken.get(token);
          if (!set) {
            set = new Set();
            byGenericToken.set(token, set);
          }
          set.add(norm);
        }
      }

      const therapeutic = (row.therapeutic_category ?? []).join("; ");
      if (therapeutic) {
        for (const token of tokens) {
          if (!therapeuticByGeneric.has(token)) {
            therapeuticByGeneric.set(token, therapeutic);
          }
        }
      }
    }
  }

  console.log(
    `  Shortage index: ${byPackageNdc.size} package NDCs, ${byGenericToken.size} generic tokens`,
  );
  return { byPackageNdc, byGenericToken, therapeuticByGeneric };
}

/** Pull searchable tokens from a shortage or staple generic name. */
function genericTokens(name: string): string[] {
  const lower = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const stop = new Set([
    "injection",
    "solution",
    "suspension",
    "powder",
    "for",
    "and",
    "in",
    "the",
    "of",
    "usp",
    "hydrochloride",
    "sodium",
    "sulfate",
    "chloride",
    "phosphate",
    "bitartrate",
    "citrate",
    "bromide",
    "succinate",
    "tromethamine",
    "methylsulfate",
    "monohydrate",
    "heptahydrate",
  ]);
  // Keep salt tokens when they are the whole staple identity (e.g. "sodium bicarbonate").
  const parts = lower.split(/\s+/).filter((p) => p.length > 2 && !stop.has(p));
  const out = new Set<string>();
  if (parts.length) out.add(parts.join(" "));
  if (parts[0]) out.add(parts[0]!);
  // Also keep a lightly cleaned full string for exact-ish matching.
  const compact = lower.replace(/\s+/g, " ").trim();
  if (compact) out.add(compact);
  return [...out];
}

function stapleMatchesShortageGeneric(stapleName: string, index: ShortageIndex): boolean {
  for (const token of genericTokens(stapleName)) {
    if (index.byGenericToken.has(token)) return true;
    // Prefix match: shortage "midazolam hydrochloride injection" vs staple "midazolam"
    for (const key of index.byGenericToken.keys()) {
      if (key.startsWith(token) || token.startsWith(key)) return true;
    }
  }
  return false;
}

function shortagePackagesForStaple(stapleName: string, index: ShortageIndex): Set<string> {
  const out = new Set<string>();
  for (const token of genericTokens(stapleName)) {
    const direct = index.byGenericToken.get(token);
    if (direct) for (const n of direct) out.add(n);
    for (const [key, set] of index.byGenericToken) {
      if (key.startsWith(token) || token.startsWith(key)) {
        for (const n of set) out.add(n);
      }
    }
  }
  return out;
}

function shortageTherapeuticForStaple(stapleName: string, index: ShortageIndex): string {
  for (const token of genericTokens(stapleName)) {
    const direct = index.therapeuticByGeneric.get(token);
    if (direct) return direct;
    for (const [key, value] of index.therapeuticByGeneric) {
      if (key.startsWith(token) || token.startsWith(key)) return value;
    }
  }
  return "";
}

function isDeniedLabeler(labeler: string): boolean {
  const lower = labeler.toLowerCase();
  for (const exact of LABELER_DENY_EXACT) {
    if (lower === exact || lower.includes(exact)) return true;
  }
  for (const sub of LABELER_DENY_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  return false;
}

function stapleAllowsCombination(staple: Staple): boolean {
  return /\band\b/i.test(staple.genericName);
}

function isSingleIngredientOk(product: OpenFdaProduct, staple: Staple): boolean {
  const ingredients = product.active_ingredients ?? [];
  if (stapleAllowsCombination(staple)) return ingredients.length >= 1;
  if (ingredients.length !== 1) return false;
  // Reject combo products whose generic_name still names a partner drug.
  const generic = asString(product.generic_name).toLowerCase();
  if (/\band\b/.test(generic) || generic.includes(" with ")) return false;
  return true;
}

function isCurrentlyMarketed(product: OpenFdaProduct): boolean {
  if (product.finished === false) return false;
  if (product.marketing_end_date && product.marketing_end_date < todayYyyymmdd()) return false;
  const type = (product.product_type ?? "").toUpperCase();
  if (type && !type.includes("HUMAN")) return false;
  return true;
}

function packagePresentationBonus(description: string): number {
  const d = description.toLowerCase();
  if (/auto[- ]?injector|pen injector|\bkit\b|convenience kit|dual chamber/.test(d)) return -40;
  if (/\bvial\b/.test(d)) return 20;
  if (/\bampule\b|\bampoule\b/.test(d)) return 20;
  if (/syringe|prefilled/.test(d)) return 18;
  if (/\bbag\b|flexible container|intravenous (bag|solution)/.test(d)) return 16;
  return 0;
}

function pickBestPackage(
  product: OpenFdaProduct,
  preferShortage: Set<string> | null,
): { packageNdc: string; description: string; onShortage: boolean } | null {
  const packs = (product.packaging ?? []).filter((p) => {
    if (!p.package_ndc) return false;
    if (p.sample) return false;
    if (p.marketing_end_date && p.marketing_end_date < todayYyyymmdd()) return false;
    return true;
  });
  if (packs.length === 0) return null;

  let best: { packageNdc: string; description: string; onShortage: boolean; score: number } | null =
    null;
  for (const p of packs) {
    const ndc = p.package_ndc!;
    const desc = p.description ?? "";
    const onShortage = preferShortage ? preferShortage.has(normalizeNdc(ndc)) : false;
    let score = packagePresentationBonus(desc);
    if (preferShortage && onShortage) score += 50;
    if (!best || score > best.score) {
      best = { packageNdc: ndc, description: desc, onShortage, score };
    }
  }
  return best
    ? { packageNdc: best.packageNdc, description: best.description, onShortage: best.onShortage }
    : null;
}

function strengthFrom(product: OpenFdaProduct): string {
  const ingredients = product.active_ingredients ?? [];
  if (ingredients.length === 0) return "";
  return ingredients
    .map((i) => `${i.name ?? "unknown"} ${i.strength ?? ""}`.trim())
    .join("; ");
}

function therapeuticClassFrom(
  product: OpenFdaProduct,
  stapleName: string,
  shortageIndex: ShortageIndex,
): string {
  const classes = product.pharm_class ?? [];
  const epc = classes.find((c) => /\[EPC\]/i.test(c));
  if (epc) return epc;
  const fromOpenfda =
    product.openfda?.pharm_class_epc?.[0] ??
    product.openfda?.pharm_class_cs?.[0] ??
    product.openfda?.pharm_class_moa?.[0] ??
    product.openfda?.pharm_class_pe?.[0];
  if (fromOpenfda) return fromOpenfda;
  if (classes[0]) return classes[0];
  return shortageTherapeuticForStaple(stapleName, shortageIndex);
}

/** Hard hospital presentation rules: reject products that fail these. */
function passesHardPresentationRules(staple: Staple, product: OpenFdaProduct, pkgDesc: string): boolean {
  const strength = strengthFrom(product);
  const strengthLower = strength.toLowerCase();
  const form = (product.dosage_form ?? "").toLowerCase();
  const desc = pkgDesc.toLowerCase();
  const brand = asString(product.brand_name).toLowerCase();
  const name = staple.genericName;

  if (name === "epinephrine") {
    if (/auto[- ]?injector|epipen/.test(desc + " " + brand)) return false;
    // Prefer 1 mg/mL vials/syringes; reject auto-injector doses.
    return /1\s*mg\/mL/i.test(strength) && !/\.15\s*mg|\.3\s*mg|0\.15|0\.3/.test(strengthLower);
  }
  if (name === "dextrose") {
    return (
      /25\s*g\/50\s*ml/i.test(strength) ||
      /50\s*g\/100\s*ml/i.test(strength) ||
      /500\s*mg\/ml/i.test(strength)
    );
  }
  if (name === "heparin sodium") {
    // 5,000 units/mL (not dilute 5,000 U/100 mL bags).
    return /5000\s*\[usp'?u\]\/mL|5,000\s*\[usp'?u\]\/mL|5000\s*units?\s*\/\s*mL/i.test(strength);
  }
  if (name === "amoxicillin") {
    return /suspension/.test(form);
  }
  if (name === "albuterol") {
    const route = asString(product.route).toLowerCase();
    return /inhalation|respiratory/.test(route) || /solution/.test(form);
  }
  return true;
}

function strengthPreferenceScore(staple: Staple, product: OpenFdaProduct, pkgDesc: string): number {
  const strength = strengthFrom(product);
  const form = (product.dosage_form ?? "").toLowerCase();
  const desc = pkgDesc.toLowerCase();
  const name = staple.genericName;

  if (name === "epinephrine") return 40;
  if (name === "dextrose") return 40;
  if (name === "heparin sodium") return 40;
  if (name === "potassium chloride") {
    if (/2\s*meq\/mL/i.test(strength)) return 35;
    if (/\bbag\b|flexible/.test(desc) || /1000\s*mL|500\s*mL/.test(strength)) return 30;
    return 5;
  }
  if (name === "amoxicillin") {
    if (/suspension/.test(form)) return 30;
    return -20;
  }
  if (name === "albuterol") {
    if (/inhalation|respiratory/.test(asString(product.route).toLowerCase()) || /solution/.test(form)) {
      return 30;
    }
    return -10;
  }
  return 0;
}

function marketingCategoryScore(category: string | undefined): number {
  const c = (category ?? "").toUpperCase();
  if (c === "ANDA" || c === "NDA") return 25;
  if (c.includes("ANDA") || c.includes("NDA")) return 15;
  if (c.includes("BLA")) return 10;
  return 0;
}

type ScoredCandidate = {
  product: OpenFdaProduct;
  packageNdc: string;
  packageDescription: string;
  onShortage: boolean;
  score: number;
  queryUrl: string;
};

function scoreCandidate(
  product: OpenFdaProduct,
  staple: Staple,
  preferShortagePackages: Set<string> | null,
  queryUrl: string,
): ScoredCandidate | null {
  if (!isCurrentlyMarketed(product)) return null;
  if (isDeniedLabeler(product.labeler_name ?? "")) return null;
  if (!isSingleIngredientOk(product, staple)) return null;
  const pkg = pickBestPackage(product, preferShortagePackages);
  if (!pkg) return null;
  if (!passesHardPresentationRules(staple, product, pkg.description)) return null;

  let score = 0;
  score += 20; // marketed + finished
  score += marketingCategoryScore(product.marketing_category);
  score += packagePresentationBonus(pkg.description);
  score += strengthPreferenceScore(staple, product, pkg.description);

  const form = (product.dosage_form ?? "").toUpperCase();
  const preferred = staple.preferredForm.toUpperCase().split(",")[0]!.trim();
  if (form.includes(preferred)) score += 5;

  if (preferShortagePackages) {
    if (pkg.onShortage) score += 60;
    else score -= 5;
  } else {
    // Prefer well-known manufacturers when not forcing shortage NDCs.
    const labeler = (product.labeler_name ?? "").toLowerCase();
    if (
      /hospira|pfizer|fresenius|baxter|hikma|sagent|sandoz|wg critical|eugia|american regent|teva parenteral|mylan institutional|accord healthcare/.test(
        labeler,
      )
    ) {
      score += 20;
    }
  }

  if (product.application_number) score += 3;
  return {
    product,
    packageNdc: pkg.packageNdc,
    packageDescription: pkg.description,
    onShortage: pkg.onShortage,
    score,
    queryUrl,
  };
}

function chosenFromCandidate(
  staple: Staple,
  candidate: ScoredCandidate,
  adjusted: boolean,
  shortageIndex: ShortageIndex,
): ChosenProduct {
  const product = candidate.product;
  const norm = normalizeNdc(candidate.packageNdc);
  const availability = shortageIndex.byPackageNdc.get(norm) ?? null;
  const onList = shortageIndex.byPackageNdc.has(norm);
  return {
    genericName: staple.genericName,
    preferredForm: staple.preferredForm,
    queryUsed: candidate.queryUrl,
    searchAdjusted: adjusted,
    productNdc: product.product_ndc ?? "",
    packageNdc: candidate.packageNdc,
    labeler: product.labeler_name ?? "",
    strength: strengthFrom(product),
    dosageForm: product.dosage_form ?? staple.preferredForm,
    route: asString(product.route),
    therapeuticClass: therapeuticClassFrom(product, staple.genericName, shortageIndex),
    brandName: asString(product.brand_name),
    applicationNumber: product.application_number ?? "",
    onShortageListAtBuild: onList,
    shortageAvailability: onList ? availability : null,
  };
}

async function gatherCandidates(
  staple: Staple,
  preferShortagePackages: Set<string> | null,
): Promise<{ candidates: ScoredCandidate[]; queriesTried: string[]; adjusted: boolean }> {
  const queriesTried: string[] = [];
  const seenProduct = new Set<string>();
  const candidates: ScoredCandidate[] = [];
  let adjusted = false;

  const consider = (results: OpenFdaProduct[] | undefined, url: string, isAlt: boolean) => {
    if (!results?.length) {
      if (isAlt) adjusted = true;
      return;
    }
    if (isAlt) adjusted = true;
    for (const product of results) {
      const key = product.product_ndc ?? JSON.stringify(product.packaging?.[0]?.package_ndc);
      if (seenProduct.has(key)) continue;
      seenProduct.add(key);
      const scored = scoreCandidate(product, staple, preferShortagePackages, url);
      if (scored) candidates.push(scored);
    }
  };

  for (const url of CUSTOM_SEARCH_URLS[staple.genericName] ?? []) {
    queriesTried.push(url);
    const body = await fetchOpenFda(url);
    if (body.error?.code === "NOT_FOUND" || !body.results?.length) {
      adjusted = true;
      continue;
    }
    consider(body.results, url, true);
  }

  const attempts: Array<{ genericName: string; form: string | null }> = [
    { genericName: staple.genericName, form: staple.preferredForm },
    ...(SEARCH_FALLBACKS[staple.genericName] ?? []),
  ];
  if (
    !attempts.some((a) => a.form === "INJECTION, SOLUTION") &&
    staple.preferredForm === "INJECTION"
  ) {
    attempts.push({ genericName: staple.genericName, form: "INJECTION, SOLUTION" });
  }
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
    if (queriesTried.includes(url)) continue;
    queriesTried.push(url);
    const body = await fetchOpenFda(url);
    const isAlt =
      i > 0 ||
      attempt.genericName !== staple.genericName ||
      attempt.form !== staple.preferredForm;
    if (body.error?.code === "NOT_FOUND" || !body.results?.length) {
      if (isAlt) adjusted = true;
      continue;
    }
    consider(body.results, url, isAlt);
    // Enough good candidates: stop expanding searches.
    if (candidates.length >= 8 && candidates.some((c) => c.score >= 40)) break;
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates, queriesTried, adjusted };
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

/**
 * Assign intended days of cover so:
 * - at least 6 shortage-list items are under 10 days
 * - a few non-shortage items are under 10 days
 * - the rest sit between 10 and 60
 */
function assignDaysOfCover(
  products: ChosenProduct[],
  rng: () => number,
): number[] {
  const n = products.length;
  const days = new Array<number>(n).fill(0);
  const shortageIdx = products
    .map((p, i) => (p.onShortageListAtBuild ? i : -1))
    .filter((i) => i >= 0);
  const nonShortageIdx = products
    .map((p, i) => (!p.onShortageListAtBuild ? i : -1))
    .filter((i) => i >= 0);

  // Shuffle copies with rng for stable picks.
  const shuffle = (arr: number[]) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };

  const lowShortage = shuffle(shortageIdx).slice(0, Math.min(6, shortageIdx.length));
  const lowNon = shuffle(nonShortageIdx).slice(0, Math.min(4, nonShortageIdx.length));
  const lowSet = new Set([...lowShortage, ...lowNon]);

  for (let i = 0; i < n; i++) {
    if (lowSet.has(i)) {
      days[i] = 2 + rng() * 7.5; // ~2–9.5
    } else {
      days[i] = 10 + rng() * 50; // 10–60
    }
  }
  return days;
}

function printSummaryTable(
  products: ChosenProduct[],
  daysOfCover: number[],
): void {
  const rows = products.map((p, i) => ({
    generic: p.genericName,
    labeler: p.labeler,
    strength: p.strength.length > 48 ? p.strength.slice(0, 45) + "..." : p.strength,
    form: p.dosageForm,
    shortage: p.onShortageListAtBuild ? "yes" : "no",
    cover: daysOfCover[i]!.toFixed(1),
  }));

  const cols = ["generic", "labeler", "strength", "form", "shortage", "cover"] as const;
  const widths: Record<(typeof cols)[number], number> = {
    generic: 8,
    labeler: 8,
    strength: 8,
    form: 4,
    shortage: 8,
    cover: 5,
  };
  for (const row of rows) {
    for (const c of cols) {
      widths[c] = Math.max(widths[c], String(row[c]).length);
    }
  }
  const header = cols.map((c) => c.padEnd(widths[c])).join(" | ");
  const rule = cols.map((c) => "-".repeat(widths[c])).join("-+-");
  console.log("");
  console.log(header);
  console.log(rule);
  for (const row of rows) {
    console.log(cols.map((c) => String(row[c]).padEnd(widths[c])).join(" | "));
  }
  const onList = products.filter((p) => p.onShortageListAtBuild).length;
  const lowShort = products.filter(
    (p, i) => p.onShortageListAtBuild && daysOfCover[i]! < 10,
  ).length;
  const lowNon = products.filter(
    (p, i) => !p.onShortageListAtBuild && daysOfCover[i]! < 10,
  ).length;
  console.log("");
  console.log(
    `Summary: ${products.length} products, ${onList} on shortage list at build, ${lowShort} shortage with <10 days cover, ${lowNon} non-shortage with <10 days cover.`,
  );
}

async function main(): Promise<void> {
  await mkdir(HOSPITAL_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const rng = createRng(SEED);
  const shortageIndex = await fetchShortageList();

  const targetShortage = Math.round(STAPLES.length / 3);
  let shortageChosen = 0;

  const products: ChosenProduct[] = [];
  const adjustedNames: string[] = [];
  const missingNames: string[] = [];

  console.log(`Resolving ${STAPLES.length} staples from openFDA (cache: ${CACHE_DIR})...`);
  console.log(`Target ~${targetShortage} products tied to current shortage-list package NDCs.`);

  for (const staple of STAPLES) {
    process.stdout.write(`  ${staple.genericName}... `);
    const genericOnList = stapleMatchesShortageGeneric(staple.genericName, shortageIndex);
    const wantShortage =
      genericOnList && shortageChosen < targetShortage;
    const preferPackages = wantShortage
      ? shortagePackagesForStaple(staple.genericName, shortageIndex)
      : null;

    const { candidates, queriesTried, adjusted } = await gatherCandidates(
      staple,
      preferPackages && preferPackages.size > 0 ? preferPackages : null,
    );

    let picked: ScoredCandidate | null = null;
    if (wantShortage && preferPackages && preferPackages.size > 0) {
      picked = candidates.find((c) => c.onShortage) ?? null;
    }
    if (!picked) {
      // Major manufacturer path: ignore shortage preference scoring bias by re-gathering
      // without shortage boost if we only had shortage-biased candidates that failed.
      if (!candidates.length) {
        console.log(`NOT FOUND (tried ${queriesTried.length} queries)`);
        missingNames.push(staple.genericName);
        continue;
      }
      picked = candidates[0]!;
    }

    // If we wanted shortage but landed on a non-shortage pack, try manufacturer-only best
    // among non-denied singles (already filtered).
    const chosen = chosenFromCandidate(staple, picked, adjusted, shortageIndex);
    if (chosen.onShortageListAtBuild) shortageChosen++;

    products.push(chosen);
    if (adjusted || chosen.searchAdjusted) {
      adjustedNames.push(`${staple.genericName} -> ${chosen.queryUsed}`);
      console.log(
        `ok (adjusted), NDC ${chosen.packageNdc}${chosen.onShortageListAtBuild ? " [shortage]" : ""}`,
      );
    } else {
      console.log(
        `ok, NDC ${chosen.packageNdc}${chosen.onShortageListAtBuild ? " [shortage]" : ""}`,
      );
    }
  }

  // Second pass: if we are short of the ~1/3 shortage target, swap eligible products
  // to shortage-list packages when candidates exist.
  if (shortageChosen < targetShortage) {
    console.log(
      `Shortage ties ${shortageChosen}/${targetShortage}; attempting upgrades for remaining slots...`,
    );
    for (let i = 0; i < products.length && shortageChosen < targetShortage; i++) {
      const current = products[i]!;
      if (current.onShortageListAtBuild) continue;
      if (!stapleMatchesShortageGeneric(current.genericName, shortageIndex)) continue;
      const preferPackages = shortagePackagesForStaple(current.genericName, shortageIndex);
      if (preferPackages.size === 0) continue;
      const staple = STAPLES.find((s) => s.genericName === current.genericName)!;
      const { candidates, adjusted } = await gatherCandidates(staple, preferPackages);
      const better = candidates.find((c) => c.onShortage);
      if (!better) continue;
      const upgraded = chosenFromCandidate(staple, better, adjusted || current.searchAdjusted, shortageIndex);
      if (!upgraded.onShortageListAtBuild) continue;
      products[i] = upgraded;
      shortageChosen++;
      console.log(`  upgraded ${current.genericName} -> shortage NDC ${upgraded.packageNdc}`);
    }
  }

  if (products.length === 0) {
    throw new Error("No products resolved from openFDA; cannot write seed.");
  }

  const criticalFlags = products.map((p) => CRITICAL_NAMES.has(p.genericName));
  let criticalCount = criticalFlags.filter(Boolean).length;
  const targetCritical = Math.round(products.length / 3);
  for (let i = 0; i < products.length && criticalCount < targetCritical; i++) {
    if (!criticalFlags[i] && rng() < 0.35) {
      criticalFlags[i] = true;
      criticalCount++;
    }
  }

  const intendedCover = assignDaysOfCover(products, rng);

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

  lines.push("-- Formulary: real openFDA NDC products");
  for (let i = 0; i < products.length; i++) {
    const p = products[i]!;
    const isCritical = criticalFlags[i]!;
    lines.push(
      `INSERT INTO formulary (generic_name, strength, dosage_form, route, package_ndc, product_ndc, labeler, therapeutic_class, application_number, is_critical) VALUES (${sqlString(p.genericName)}, ${sqlString(p.strength)}, ${sqlString(p.dosageForm)}, ${sqlString(p.route)}, ${sqlString(p.packageNdc)}, ${sqlString(p.productNdc)}, ${sqlString(p.labeler)}, ${sqlString(p.therapeuticClass)}, ${sqlString(p.applicationNumber)}, ${isCritical});`,
    );
  }
  lines.push("");

  lines.push("-- Inventory and 90 days of usage (seeded synthetic SAMPLE DATA)");
  const onHandByIndex: number[] = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i]!;
    const tier = USAGE_TIER[p.genericName] ?? "medium";
    const mean = meanDailyUse(tier, rng);
    const daysOfCover = intendedCover[i]!;
    const onHand = Math.max(1, Math.round(mean * daysOfCover));
    onHandByIndex.push(onHand);
    const itemRef = `(SELECT item_id FROM formulary WHERE package_ndc = ${sqlString(p.packageNdc)})`;
    lines.push(
      `INSERT INTO inventory (item_id, location, on_hand_units, snapshot_at) VALUES (${itemRef}, 'Central Pharmacy', ${onHand}, ${sqlString(snapshotAt)});`,
    );

    for (let dayOffset = 0; dayOffset < USAGE_DAYS; dayOffset++) {
      const day = addDays(startDay, dayOffset);
      const noise = 0.5 + rng();
      const used = Math.max(0, Math.round(mean * noise));
      lines.push(
        `INSERT INTO usage_daily (item_id, day, units_used) VALUES (${itemRef}, ${sqlString(isoDateOnly(day))}, ${used});`,
      );
    }
  }
  lines.push("");

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
    shortageListPackageCount: shortageIndex.byPackageNdc.size,
    missingNames,
    adjustedSearches: adjustedNames,
    products: products.map((p, i) => ({
      genericName: p.genericName,
      preferredForm: p.preferredForm,
      queryUsed: p.queryUsed,
      searchAdjusted: p.searchAdjusted,
      productNdc: p.productNdc,
      packageNdc: p.packageNdc,
      labeler: p.labeler,
      strength: p.strength,
      dosageForm: p.dosageForm,
      route: p.route,
      therapeuticClass: p.therapeuticClass,
      brandName: p.brandName,
      applicationNumber: p.applicationNumber,
      onShortageListAtBuild: p.onShortageListAtBuild,
      shortageAvailability: p.shortageAvailability,
      intendedDaysOfCover: Number(intendedCover[i]!.toFixed(2)),
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

  printSummaryTable(products, intendedCover);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
