export type TraceLine = {
  timestamp: string;
  run_id: string;
  mode: "live" | "sample";
  item_id: number | null;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent?: string;
  evidence_ids?: string[];
  verdict?: string;
  confidence?: number;
  retry_count?: number;
  status: "ok" | "needs_revision" | "blocked" | "error" | "info";
  model_requested?: string;
  model_routed?: string | null;
  latency_ms?: number;
  provider?: string;
  fallback_from?: string;
  sql?: string;
};

export type OrderPackage = { ndc: string; labeler: string; description: string; fda_status: string; volume_ml?: number | null; container?: string | null };

export type OrderLine = {
  item_id: number;
  drug: string;
  generic_name: string;
  current_supplier: string;
  our_package: string;
  days_of_cover: number | null;
  risk: string;
  action: "check_recall" | "order_substitute" | "add_second_supplier" | "escalate" | "reorder_market_tight" | "expedite_or_reorder" | "already_ordered" | "watch" | "no_action";
  headline: string;
  why: string;
  order: Array<{ supplier: string; supplier_key: string; application: string; packages: OrderPackage[]; notes: string[]; to_bridge: string | null }>;
  open_orders: string[];
  gap: { runs_out: string; next_supply: string; next_supply_label: string; next_supply_passed: boolean; gap_days: number | null; units_to_bridge: number | null; incoming_units: number } | null;
  recall: { number: string; classification: string } | null;
  dea_schedule: string | null;
  market_note: string | null;
  evidence_ids: string[];
  confidence: number;
  status: "approved" | "blocked";
  blocked_reasons: string[];
  memory_applied?: string[];
  writer_checked?: boolean;
};

export type Evidence = { id: string; source: string; summary: string; link?: string; data: Record<string, unknown> };

export type RunResult = {
  run_id: string;
  mode: "live" | "sample";
  provider?: string;
  must_check?: number;
  checked?: number;
  board_ms?: number;
  started_at: string;
  finished_at: string;
  /** When the run's data was read; for a sample replay, when the recorded run started. */
  as_of?: string;
  lines: OrderLine[];
  evidence?: Evidence[];
  trace?: TraceLine[];
};

export type Status = {
  mode: "live" | "sample";
  zetaris: { url: string; reachable: boolean | null; sources: Record<string, number> | null };
  llm: { provider: string; base_url: string; status: string; nemotron: string[] };
  memory: { decisions: number };
  running: string | null;
};

export type MemoryRow = { id: string; content: string; layer: string; source: string; confidence: number; tags: string[]; created: string };
