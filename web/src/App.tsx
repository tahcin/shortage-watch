import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Evidence, MemoryRow, OrderLine, RunResult, Status, TraceLine } from "./types";

const AGENT_LABEL: Record<string, string> = {
  Orchestrator: "Run",
  Planner: "Planner",
  Investigator: "Investigator",
  SourceScout: "Source scout",
  Substitution: "Substitution",
  EvidenceCritic: "Evidence critic",
  Writer: "Writer",
  Memory: "Memory",
  CodeGuard: "Safety check",
};

function actionText(l: OrderLine): string {
  switch (l.action) {
    case "check_recall": return `Check your lots against FDA recall ${l.recall?.number ?? ""}${l.recall?.classification ? ` (${l.recall.classification})` : ""} and quarantine affected stock${l.order.length ? "; if stock is affected, these can replace it" : ""}`;
    case "order_substitute": return "Order a substitute";
    case "add_second_supplier": return "Add a second supplier";
    case "escalate": return "Escalate to the pharmacy team: the FDA Orange Book lists no interchangeable product that can be recommended";
    case "reorder_market_tight": return "Reorder now: most other makers' presentations of this drug are listed limited or unavailable";
    case "expedite_or_reorder": return l.open_orders.length ? "Chase your open order" : "Reorder now from your current supplier";
    case "already_ordered": return "You marked this as already ordered: watching only";
    case "watch": return "Watch";
    default: return "No action needed";
  }
}

const DEA: Record<string, string> = {
  CII: "Schedule II controlled substance: order on DEA Form 222 or CSOS.",
  CIII: "Schedule III controlled substance.",
  CIV: "Schedule IV controlled substance.",
  CV: "Schedule V controlled substance.",
};

function daysClass(d: number | null) {
  if (d === null) return "days";
  if (d < 7) return "days urgent";
  if (d < 14) return "days soon";
  return "days ok";
}

function sourceLabel(e: Evidence) {
  switch (e.source) {
    case "hospital": return "Your stock";
    case "fda-shortage": return "FDA shortage list";
    case "fda-recall": return "FDA recall";
    case "orange-book": return "FDA Orange Book";
    case "fda-ndc": return "FDA product listing";
    case "memory": return "Saved memory (H-MEM)";
    default: return e.source;
  }
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bMg\b/g, "mg").replace(/\bMl\b/g, "mL")
    .replace(/\b(Usa|Llc|Lp|Ii|Iii)\b/g, (w) => w.toUpperCase()).replace(/(^|\s)\.(\d)/g, "$10.$2");
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [trace, setTrace] = useState<TraceLine[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryRow[]>([]);
  const [evidence, setEvidence] = useState<Record<string, Evidence>>({});
  const items = 20;
  const [toast, setToast] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(() => fetch("/api/status").then((r) => r.json()).then(setStatus).catch(() => undefined), []);
  const loadMemory = useCallback(() => fetch("/api/memory").then((r) => r.json()).then(setMemory).catch(() => undefined), []);
  const loadEvidence = useCallback((runId: string) => fetch(`/api/runs/${runId}/evidence`).then((r) => (r.ok ? r.json() : [])).then((list: Evidence[]) => setEvidence(Object.fromEntries(list.map((e) => [e.id, e])))).catch(() => undefined), []);

  const listen = useCallback(() => {
    const es = new EventSource("/api/runs/live");
    es.addEventListener("trace", (ev) => setTrace((t) => [...t, JSON.parse((ev as MessageEvent).data) as TraceLine]));
    es.addEventListener("result", (ev) => {
      const r = JSON.parse((ev as MessageEvent).data) as RunResult;
      setResult(r);
      setRunning(false);
      loadEvidence(r.run_id);
      loadMemory();
      loadStatus();
      es.close();
    });
    es.addEventListener("error", (ev) => {
      const data = (ev as MessageEvent).data;
      if (data) { setError(JSON.parse(data).message); setRunning(false); es.close(); }
    });
    es.addEventListener("idle", () => es.close());
    return es;
  }, [loadEvidence, loadMemory, loadStatus]);

  useEffect(() => {
    loadMemory();
    // If a check is already running (opened in another tab, or the page was refreshed), follow it live;
    // otherwise show the most recent finished check.
    fetch("/api/status").then((r) => r.json()).then((st: Status) => {
      setStatus(st);
      if (st.running) {
        setRunning(true);
        setTrace([]);
        listen();
      } else {
        fetch("/api/runs/latest").then((r) => (r.ok ? r.json() : null)).then((r: RunResult | null) => {
          if (r) { setResult(r); setTrace(r.trace ?? []); loadEvidence(r.run_id); }
        });
      }
    }).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" }); }, [trace.length]);

  async function start() {
    setError(null);
    setTrace([]);
    setResult(null);
    setRunning(true);
    const r = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    if (!r.ok && r.status !== 409) { setError((await r.json()).error ?? "Could not start"); setRunning(false); return; }
    listen();
  }

  async function forget(id: string) {
    await fetch(`/api/memory/${id}`, { method: "DELETE" });
    setToast("Removed. The next check will not apply it.");
    setTimeout(() => setToast(null), 3500);
    loadMemory();
    loadStatus();
  }

  async function remember(kind: string, subject: string, item: string, note?: string) {
    await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, subject, ...(item ? { item } : {}), ...(note ? { note } : {}) }) });
    setToast("Saved. The agents will apply this on every future check.");
    setTimeout(() => setToast(null), 3500);
    loadMemory();
    loadStatus();
  }

  const progress = useMemo(() => {
    const planned = trace.find((t) => t.action === "plan_investigation");
    const done = new Set(trace.filter((t) => t.agent_name === "EvidenceCritic" && t.verdict !== "revise").map((t) => t.item_id));
    const total = planned ? Number(planned.output_summary.match(/Checking (\d+)/)?.[1] ?? 0) : 0;
    return { done: done.size, total };
  }, [trace]);

  const decisions = memory.filter((m) => m.source === "buyer_decision");
  const runNotes = memory.filter((m) => m.source.startsWith("run:")).slice(0, 4);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" /><path d="M8 17h6l2-5 3 10 2-5h3" /></svg>
          </span>
          <div>
            <h1>Shortage Watch</h1>
            <p className="lede">Finds the drugs your hospital is about to run short of, explains why from FDA records, and tells you what to order instead.</p>
          </div>
        </div>
        <div className="status">
          <StatusPill ok={status?.zetaris.reachable !== false} label={status ? (status.mode === "sample" ? "Recorded sample run" : "Your stock and FDA data, via Zetaris") : "Checking data"} />
          <StatusPill ok={!!status && ["online", "sample", "fallback"].includes(status.llm.status)} label={status ? (status.llm.provider === "meterless" ? `Nemotron via Meterless (${status.llm.status})` : status.mode === "sample" ? "Model replies replayed" : "Nemotron via NVIDIA (backup)") : "Checking models"} />
          <StatusPill ok label={`${status?.memory.decisions ?? 0} saved ${status?.memory.decisions === 1 ? "decision" : "decisions"}`} tone="memory" />
        </div>
      </header>

      <section className="action">
        <div>
          <h2>{result ? headlineFor(result) : "Check this week's orders"}</h2>
          <p>{result ? `Checked ${new Date(result.as_of ?? result.finished_at).toLocaleString([], { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}: ${result.checked ?? result.lines.length} drugs${result.must_check ? `, including all ${result.must_check} with under two weeks of cover or a supply problem on FDA data` : ""}. Every line cites the records behind it.` : "The agents read your stock levels, the FDA shortage and recall lists, and the FDA's list of interchangeable products."}</p>
        </div>
        <div className="run">
          <button className="primary" onClick={start} disabled={running}>{running ? `Checking${progress.total ? ` ${progress.done} of ${progress.total}` : ""}...` : result ? "Check again" : "Check this week's orders"}</button>
        </div>
      </section>
      {error && <div className="alert">The check stopped: {error}</div>}

      <main className="grid">
        <section className="results" aria-label="Order list">
          {!result && !running && <EmptyState />}
          {running && !result && <Waiting trace={trace} />}
          {result?.lines.map((l) => <OrderCard key={l.item_id} line={l} evidence={evidence} onRemember={remember} sample={status?.mode === "sample"} />)}
        </section>

        <aside className="side">
          <div className="panel feed">
            <h3>How the agents worked</h3>
            <p className="hint">Each step reads real records through Zetaris. The evidence critic can send work back.</p>
            <div className="feed-list" ref={feedRef}>
              {trace.length === 0 && <p className="muted">Steps appear here while a check runs.</p>}
              {trace.map((t, i) => <FeedRow key={i} t={t} />)}
            </div>
          </div>

          <div className="panel memory">
            <h3>What Shortage Watch remembers</h3>
            {decisions.length === 0 && <p className="muted">No saved decisions yet. Use the buttons on a result to teach it your rules.</p>}
            <ul>
              {decisions.map((m) => (
                <li key={m.id}>
                  <span className="dot" />{m.content.replace(/^Buyer decision: /, "")}
                  {status?.mode !== "sample" && <button className="link small-link" onClick={() => forget(m.id)}>Remove</button>}
                </li>
              ))}
            </ul>
            {runNotes.length > 0 && (
              <details>
                <summary>From earlier checks ({runNotes.length})</summary>
                <ul className="notes">{runNotes.map((m) => <li key={m.id}>{m.content}</li>)}</ul>
              </details>
            )}
            <p className="fine">Stored in Meterless H-MEM with an append-only audit ledger.{status?.mode === "sample" ? " This replay recorded one decision, \"Never use Hikma\"; other buttons need a live check." : ""}</p>
          </div>
        </aside>
      </main>

      <footer>
        <p>Sample hospital stock and usage on real FDA-listed products. FDA data from openFDA (drug shortages, enforcement reports, NDC directory) and the FDA Orange Book. Decision support only: a pharmacist reviews every order.</p>
      </footer>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function headlineFor(r: RunResult): string {
  const n = (a: OrderLine["action"][]) => r.lines.filter((l) => a.includes(l.action)).length;
  const parts = [
    [n(["escalate"]), "to escalate"],
    [n(["check_recall"]), "with a recall to check"],
    [n(["order_substitute", "add_second_supplier"]), "with a substitute to order"],
    [n(["reorder_market_tight", "expedite_or_reorder"]), "to reorder"],
  ].filter(([k]) => (k as number) > 0).map(([k, t]) => `${k} ${t}`);
  return parts.length ? `This week: ${parts.join(", ")}` : "This week: nothing needs action";
}

function StatusPill({ ok, label, tone }: { ok: boolean; label: string; tone?: "memory" }) {
  return <span className={`pill ${tone ?? ""} ${ok ? "" : "bad"}`}><i />{label}</span>;
}

function EmptyState() {
  return (
    <div className="empty">
      <h3>Nothing checked yet</h3>
      <p>Press "Check this week's orders". A live check runs unattended for about 20 minutes (a recorded replay takes about a minute), then you get a short list: which drugs are running low, whether the FDA lists them as short, and an interchangeable product you can order instead.</p>
    </div>
  );
}

function Waiting({ trace }: { trace: TraceLine[] }) {
  const last = [...trace].reverse().find((t) => t.agent_name !== "Memory");
  return (
    <div className="empty waiting">
      <div className="spinner" aria-hidden />
      <h3>Checking your stock against the FDA</h3>
      <p>{last ? `${AGENT_LABEL[last.agent_name] ?? last.agent_name}: ${last.output_summary.slice(0, 180)}` : "Starting..."}</p>
    </div>
  );
}

/** Plain-language version of a trace step; the raw trace stays in the log files. */
function friendly(t: TraceLine): string {
  const o = t.output_summary;
  switch (t.action) {
    case "start_run": return t.mode === "sample" ? "Replaying a recorded check (no live services needed)." : "Started a live check.";
    case "fda_snapshot_status": return `FDA data ready: ${o.replace(/shortages: (\d+) rows captured ([^ ;]+).*recalls: (\d+) rows.*/, "$1 shortage entries and $3 recalls")}.`;
    case "snapshot_fda_source": return "Saved a fresh copy of today's FDA list inside Zetaris.";
    case "load_hospital_stock": return `Read your stock: ${o}.`;
    case "risk_board": return `One Zetaris query across your stock, the FDA shortage and recall lists and the Orange Book: ${o}.`;
    case "check_writer": return o;
    case "reuse_zetaris_source": return o;
    case "reinject_decision": return `Applying your rule: ${o.replace(/^Buyer decision: /, "")}`;
    case "reinject_memory": return `Recalled from an earlier check: ${o.replace(/ \(relevance.*$/, "")}`;
    case "load_buyer_memory": return o;
    case "plan_investigation": return `Plan: ${o}`;
    case "query_sources": return `Searched FDA records: ${o}`;
    case "assess_risk": case "revise_risk_assessment": return `${t.action === "revise_risk_assessment" ? "Revised: " : ""}${o.replace(/^supply_risk: /, "Supply problem. ").replace(/^low_stock_only: /, "Low stock, no FDA supply problem. ").replace(/^recall: /, "Recall. ").replace(/^no_risk: /, "No risk. ")}`;
    case "register_zetaris_source": return o;
    case "find_equivalents": return `Interchangeable products (FDA Orange Book), checked package by package: ${o}.`;
    case "apply_buyer_decision": return o.replace(/ \(memory-[^)]+\)/g, "");
    case "propose_substitutes": case "revise_substitutes": return `${t.action === "revise_substitutes" ? "Revised: " : ""}${o.replace(/^split: /, "Add a second supplier: ").replace(/^switch: /, "Switch to: ").replace(/^no_safe_substitute: .*/, "No safe substitute.").replace(/ \((clear|listed_available)\)/g, "")}`;
    case "no_safe_substitute": return o;
    case "guard_remove_unsafe_substitute": case "guard_remove_unorderable": return `Safety check: ${o}`;
    case "send_back": return `Sent back to ${t.target_agent}: ${o.replace(/^revise: /, "")}`;
    case "approve": return o;
    case "block_claims": return `Blocked: ${o.replace(/^block: /, "")}`;
    case "write_order_list": return "Wrote the order list.";
    case "write_line": return `Wrote: ${o}`;
    case "remember_run": return "Remembered this check's advice for next time.";
    case "finish_run": return `Done: ${o}.`;
    default: return o;
  }
}

function FeedRow({ t }: { t: TraceLine }) {
  const cls = t.status === "needs_revision" ? "revise" : t.status === "blocked" || t.status === "error" ? "block" : t.agent_name === "Memory" ? "mem" : t.agent_name === "SourceScout" ? "scout" : "";
  const what = friendly(t);
  return (
    <div className={`feed-row ${cls}`}>
      <div className="who">{AGENT_LABEL[t.agent_name] ?? t.agent_name}{t.item_id !== null ? <span className="item">#{t.item_id}</span> : null}</div>
      <div className="what">{what.length > 420 ? `${what.slice(0, 420)}...` : what}</div>
      {t.model_routed && <div className="model">{t.model_routed.replace(/^nvidia\//, "")}{t.provider === "nvidia" && t.fallback_from ? ", NVIDIA direct (Nightshift gave up)" : t.provider === "meterless" ? ", via Meterless Nightshift" : ""}{t.latency_ms ? `, ${(t.latency_ms / 1000).toFixed(1)}s` : ""}</div>}
    </div>
  );
}

function OrderCard({ line, evidence, onRemember, sample }: { line: OrderLine; evidence: Record<string, Evidence>; onRemember: (kind: string, subject: string, item: string, note?: string) => void; sample: boolean }) {
  const [open, setOpen] = useState(false);
  const drugName = titleCase(line.generic_name ?? line.drug);
  const strength = line.drug.slice((line.generic_name ?? "").length).trim();
  const ev = line.evidence_ids.map((id) => evidence[id]).filter(Boolean);
  const blocked = line.status === "blocked";
  return (
    <article className={`card ${blocked ? "blocked" : line.action}`}>
      <div className="card-top">
        <div>
          <h3>{drugName} <span className="strength">{strength}</span></h3>
          <p className="supplier">Current supplier: {line.current_supplier}{line.our_package ? ` · Our package: ${line.our_package}` : ""}</p>
        </div>
        <span className={daysClass(line.days_of_cover)}>{line.days_of_cover ?? "?"} days left</span>
      </div>

      {blocked ? (
        <div className="verdict block">Needs a manual check: the evidence did not hold up, so the agents made no recommendation.</div>
      ) : (
        <div className={`verdict ${line.action}`}>
          <strong>{actionText(line)}</strong>
          {line.order.map((o) => (
            <div key={o.application} className="order">
              <div className="supplier-name">{titleCase(o.supplier)} <span className="appl">{o.application}, FDA-rated interchangeable</span></div>
              <ul className="packages">
                {o.packages.map((p) => (
                  <li key={p.ndc}><span className="ndc">NDC {p.ndc}</span> {p.description} <span className="muted-inline">by {p.labeler}; {p.fda_status}</span></li>
                ))}
              </ul>
              {o.to_bridge && <p className="small">{o.to_bridge}</p>}
              {o.notes.map((n) => <p key={n} className="note">{n}</p>)}
            </div>
          ))}
          {line.gap && (
            <p className="gap">
              {line.gap.next_supply_passed
                ? `FDA ${line.gap.next_supply_label} was ${line.gap.next_supply}, which has passed: confirm the date with your supplier.`
                : `You run out about ${line.gap.runs_out}${line.gap.incoming_units ? `, counting ${line.gap.incoming_units} units on open orders` : ""}. FDA ${line.gap.next_supply_label}: ${line.gap.next_supply} (planned as the end of that month). ${line.gap.gap_days ? `About ${line.gap.gap_days} days with no supply from your current maker: about ${line.gap.units_to_bridge} units to bridge.` : "Supply should return before you run out."}`}
            </p>
          )}
          {line.open_orders.length > 0 && line.action !== "already_ordered" && <p className="small">Open orders: {line.open_orders.join("; ")}</p>}
        </div>
      )}

      {line.memory_applied && line.memory_applied.length > 0 && (
        <p className="rule">Your saved rule applied: {line.memory_applied.join("; ")}</p>
      )}
      <p className="headline">{line.headline}</p>
      {line.why && <p className="why">{line.why}</p>}
      {(line.dea_schedule || line.market_note) && (
        <p className="small">{[line.dea_schedule ? DEA[line.dea_schedule] ?? `Controlled substance (${line.dea_schedule}).` : null, line.market_note ? `Market: ${line.market_note}` : null].filter(Boolean).join(" ")}</p>
      )}

      <div className="card-actions">
        <button className="link" onClick={() => setOpen(!open)}>{open ? "Hide evidence" : `See the evidence (${ev.length || line.evidence_ids.length})`}</button>
        {!blocked && [...new Set(line.order.map((o) => o.supplier_key))].filter((k) => !sample || k === "Hikma").map((k) => (
          <button key={k} className="ghost" onClick={() => onRemember("avoid_supplier", k, "")}>Never use {k}</button>
        ))}
        {!blocked && !sample && (line.action === "expedite_or_reorder" || line.action === "reorder_market_tight" || line.action === "watch") && (
          <button className="ghost" onClick={() => onRemember("already_ordered", line.generic_name, "")}>Already ordered</button>
        )}
      </div>

      {open && (
        <ul className="evidence">
          {blocked && line.blocked_reasons.map((r, i) => <li key={`b${i}`} className="reason">{r}</li>)}
          {ev.map((e) => (
            <li key={e.id}>
              <span className="src">{sourceLabel(e)}</span>
              <span>{e.summary}</span>
              {e.link && <a href={e.link} target="_blank" rel="noreferrer">Open record</a>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
