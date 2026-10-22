// How drug strengths and supplier names are shown to a buyer. Follows ISMP's error-prone abbreviation
// list: never a naked decimal (".4" becomes "0.4"), "units" spelled out, thousands separated.

/** "ATROPINE SULFATE .4 mg/mL" -> "0.4 mg/mL"; "HEPARIN SODIUM 5000 [USP'U]/mL" -> "5,000 units/mL". */
export function displayStrength(strength: string): string {
  // FDA strengths read "<INGREDIENT IN CAPITALS> <amount> <unit>", sometimes several joined by "; ".
  return strength
    .split(/;\s*/)
    .map((part) => part.replace(/^[A-Z][A-Z ,()'-]*?\s+(?=[.\d])/, "").trim())
    .join(" + ")
    .replace(/\[USP'U\]|\[iU\]|\bU\b(?=\/)/g, " units")
    .replace(/\bug\b/g, "mcg")
    .replace(/(^|[^\d])\.(\d)/g, "$10.$2")
    .replace(/\b(\d{4,})\b/g, (n) => Number(n).toLocaleString("en-US"))
    .replace(/\s+/g, " ")
    .replace(/\s+\//g, "/")
    .trim();
}

/** "morphine sulfate" + "MORPHINE SULFATE 50 mg/mL" -> "morphine sulfate 50 mg/mL" (no doubled name). */
export function drugLabel(item: { generic_name: string; strength: string }): string {
  return `${item.generic_name} ${displayStrength(item.strength)}`;
}

const CORPORATE = /\b(INC|INCORPORATED|LLC|L\.L\.C|LTD|LIMITED|CO|CORP|CORPORATION|COMPANY|PLC|GMBH|AG|SA|PTE|PVT|PRIVATE|USA|US|EU|INTERNATIONAL|HOLDINGS|PHARMACEUTICALS?|PHARMA|MEDICAL|HEALTHCARE|THERAPEUTICS|SPECIALTY|LABORATORIES)\b\.?/g;

/** The name a buyer means by a supplier: "B BRAUN MEDICAL INC" -> "B Braun", "Hikma Pharmaceuticals USA Inc." -> "Hikma". */
export function supplierKey(name: string): string {
  const core = name.toUpperCase().replace(/[.,]/g, " ").replace(CORPORATE, " ").replace(/\s+/g, " ").trim();
  const key = core || name.toUpperCase().trim();
  return key.split(" ").map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(" ");
}

/** Whole-word match of a supplier key inside a company name: "B Braun" matches "B. Braun Medical Inc." but not "Micro Labs". */
export function supplierMatches(companyName: string, key: string): boolean {
  const norm = (s: string) => ` ${s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim()} `;
  const k = norm(key).trim();
  return k.length > 0 && norm(companyName).includes(` ${k} `);
}
