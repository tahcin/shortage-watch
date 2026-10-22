// Every fact the agents use is an Evidence record with a stable id and a source. Agents may only make
// claims that cite evidence ids, and the critic rejects any claim whose ids are not in this run's store.

export type EvidenceSource = "hospital" | "fda-shortage" | "fda-recall" | "orange-book" | "fda-ndc";

export type Evidence = {
  id: string;
  source: EvidenceSource;
  summary: string;
  data: Record<string, unknown>;
  link?: string;
};

export type Claim = { text: string; evidence_ids: string[] };

export class EvidenceStore {
  private readonly items = new Map<string, Evidence>();

  add(e: Evidence): Evidence {
    this.items.set(e.id, e);
    return e;
  }

  addAll(list: Evidence[]): Evidence[] {
    list.forEach((e) => this.add(e));
    return list;
  }

  get(id: string): Evidence | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /**
   * Models sometimes cite part of an id ("0409-1896-20" for "shortage-0409-1896-20"). Resolve a citation
   * to an id only when exactly one record matches; anything ambiguous or unknown stays unresolved.
   */
  resolve(cited: string): string | undefined {
    const c = cited.trim().replace(/^\[|\]$/g, "").replace(/^([a-z]+-)\1+/, "$1");
    if (this.items.has(c)) return c;
    const matches = [...this.items.keys()].filter((id) => id.endsWith(c) || id === c.replace(/^[a-z-]+:/, ""));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Rewrites a claim's citations to canonical ids; returns the citations that could not be resolved. */
  normalise(claim: Claim): string[] {
    const unresolved: string[] = [];
    claim.evidence_ids = claim.evidence_ids.map((id) => {
      const r = this.resolve(id);
      if (!r) unresolved.push(id);
      return r ?? id;
    });
    return unresolved;
  }

  all(): Evidence[] {
    return [...this.items.values()];
  }
}

export function shortageLink(genericName: string): string {
  return `https://dps.fda.gov/drugshortages/activeingredient/${encodeURIComponent(genericName.toLowerCase().split(" ")[0]!)}`;
}

export function recallLink(recallNumber: string): string {
  return `https://api.fda.gov/drug/enforcement.json?search=recall_number:%22${encodeURIComponent(recallNumber)}%22`;
}

export function orangeBookLink(applNo: string, productNo: string, applType: string): string {
  return `https://www.accessdata.fda.gov/scripts/cder/ob/results_product.cfm?Appl_Type=${applType}&Appl_No=${applNo}#${productNo}`;
}
