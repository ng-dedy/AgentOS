/**
 * Minimal in-process metrics registry with Prometheus text exposition.
 * No dependency: counters, gauges and fixed-bucket histograms with string labels.
 * One registry per process (`metrics`); the API and the worker each expose it.
 * Label values must never contain secrets or user content: only enums and ids.
 */
type Labels = Record<string, string>;

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

const HELP: Record<string, string> = {
  agentos_kms_operations_total: "KMS calls by operation and outcome (ok, config, integrity, unavailable).",
  agentos_kms_operation_seconds: "KMS call latency.",
  agentos_credential_resolutions_total: "Credential lookups for model calls by outcome.",
  agentos_events_reconciled_total: "Run events published by the listener's reconciliation passes.",
  agentos_events_duplicates_dropped_total: "Persisted events dropped because their seq was already delivered.",
  agentos_event_listener_reconnects_total: "Reconnects of the Postgres LISTEN connection.",
  agentos_event_window_rows: "Rows re-read by the last reconciliation pass (open transaction window).",
  agentos_event_watermark_lag_seconds: "Age of the oldest transaction holding the event watermark back.",
  agentos_model_call_reservations_total: "Pre-call budget reservations by outcome.",
  agentos_possible_duplicate_billing_total: "Model calls that may have been billed without a stored result.",
  agentos_budget_exceeded_total: "Runs stopped by a spending limit, by scope.",
  agentos_activity_executions_total: "Temporal activity executions by type and outcome.",
  agentos_worker_active_activities: "Activities currently executing on this worker.",
  agentos_http_requests_total: "HTTP requests by route and status class.",
  agentos_sse_connections: "Open SSE streams on this API instance.",
  agentos_process_draining: "1 while this process is draining for shutdown.",
};

class Registry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, { buckets: number[]; sum: number; count: number }>>();

  inc(name: string, labels: Labels = {}, by = 1) {
    const m = this.counters.get(name) ?? new Map<string, number>();
    this.counters.set(name, m);
    const k = key(labels);
    m.set(k, (m.get(k) ?? 0) + by);
  }

  set(name: string, labels: Labels, value: number) {
    const m = this.gauges.get(name) ?? new Map<string, number>();
    this.gauges.set(name, m);
    m.set(key(labels), value);
  }

  observe(name: string, labels: Labels, value: number) {
    const m = this.histograms.get(name) ?? new Map();
    this.histograms.set(name, m);
    const k = key(labels);
    const h = m.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    m.set(k, h);
    BUCKETS.forEach((b, i) => {
      if (value <= b) h.buckets[i]!++;
    });
    h.sum += value;
    h.count++;
  }

  /** Current value of a counter (tests). */
  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(key(labels)) ?? 0;
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  render(extraGauges: { name: string; help: string; labels?: Labels; value: number }[] = []): string {
    const out: string[] = [];
    const header = (name: string, type: string, help?: string) => {
      out.push(`# HELP ${name} ${help ?? HELP[name] ?? name}`);
      out.push(`# TYPE ${name} ${type}`);
    };
    for (const [name, m] of this.counters) {
      header(name, "counter");
      for (const [k, v] of m) out.push(`${name}${k} ${v}`);
    }
    for (const [name, m] of this.gauges) {
      header(name, "gauge");
      for (const [k, v] of m) out.push(`${name}${k} ${v}`);
    }
    for (const g of extraGauges) {
      header(g.name, "gauge", g.help);
      out.push(`${g.name}${key(g.labels ?? {})} ${g.value}`);
    }
    for (const [name, m] of this.histograms) {
      header(name, "histogram");
      for (const [k, h] of m) {
        const base = k === "" ? "" : k.slice(1, -1);
        BUCKETS.forEach((b, i) => out.push(`${name}_bucket{${base ? `${base},` : ""}le="${b}"} ${h.buckets[i]}`));
        out.push(`${name}_bucket{${base ? `${base},` : ""}le="+Inf"} ${h.count}`);
        out.push(`${name}_sum${k} ${h.sum}`);
        out.push(`${name}_count${k} ${h.count}`);
      }
    }
    return `${out.join("\n")}\n`;
  }
}

function key(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join(",")}}`;
}

export const metrics = new Registry();
export type MetricsRegistry = Registry;
