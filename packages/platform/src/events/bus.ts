import type { RunEvent } from "@agentos/contracts";
import type { PrismaClient } from "@agentos/db";
import type { EventSink, NewEvent } from "@agentos/runtime";
import { metrics } from "../observability/metrics";

type Listener = (event: RunEvent) => void;
/** Called after a reconciliation pass: every committed event with txid < watermark has been delivered. */
type WatermarkListener = (watermark: bigint) => void;
interface Subscriber {
  onEvent: Listener;
  onWatermark?: WatermarkListener;
}

/**
 * Per-process pub/sub keyed by organization. Correctness never depends on it:
 * every persisted event can be replayed from the database. Across processes it is
 * fed by `PgEventListener` (Postgres LISTEN/NOTIFY plus reconciliation reads), so an
 * event written by a worker or another API instance reaches every instance. A persisted
 * event can arrive more than once (local publish, notification, reconciliation); the bus
 * drops repeats by seq.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Subscriber>>();
  private readonly recent = new Set<string>();

  subscribe(orgId: string, listener: Listener, onWatermark?: WatermarkListener): () => void {
    let set = this.listeners.get(orgId);
    if (!set) {
      set = new Set();
      this.listeners.set(orgId, set);
    }
    const sub: Subscriber = { onEvent: listener, onWatermark };
    set.add(sub);
    return () => {
      set.delete(sub);
      if (set.size === 0) this.listeners.delete(orgId);
    };
  }

  publish(orgId: string, event: RunEvent) {
    if (event.seq !== null) {
      if (this.recent.has(event.seq)) {
        metrics.inc("agentos_events_duplicates_dropped_total", { at: "bus" });
        return;
      }
      this.recent.add(event.seq);
      if (this.recent.size > 20_000) this.recent.delete(this.recent.values().next().value!);
    }
    for (const l of this.listeners.get(orgId) ?? []) {
      try {
        l.onEvent(event);
      } catch {
        // a broken subscriber must not affect the run
      }
    }
  }

  /** Tell current subscribers of these organizations that the listener's watermark advanced. */
  publishWatermark(orgIds: string[], watermark: bigint) {
    for (const orgId of orgIds) {
      for (const l of this.listeners.get(orgId) ?? []) {
        try {
          l.onWatermark?.(watermark);
        } catch {
          // ignore
        }
      }
    }
  }

  listenerCount(orgId: string): number {
    return this.listeners.get(orgId)?.size ?? 0;
  }

  /** Organizations with at least one live subscriber in this process. */
  activeOrgs(): string[] {
    return [...this.listeners.keys()];
  }
}

export function toRunEvent(row: {
  seq: bigint;
  taskId: string;
  rootTaskId: string;
  runId: string | null;
  agentId: string | null;
  type: string;
  payload: unknown;
  createdAt: Date;
}): RunEvent {
  return {
    seq: row.seq.toString(),
    type: row.type as RunEvent["type"],
    taskId: row.taskId,
    rootTaskId: row.rootTaskId,
    runId: row.runId,
    agentId: row.agentId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Channel for live-only events (model deltas) between processes. */
export const TRANSIENT_CHANNEL = "agentos_transient";
/** Channel the RunEvent insert trigger notifies on (see the durable_execution migration). */
export const EVENTS_CHANNEL = "agentos_events";
/** NOTIFY payloads must stay under 8000 bytes; leave room for the envelope. */
const MAX_TRANSIENT_TEXT = 3000;

/**
 * Persist-then-publish sink used by the runtime. Persisted events reach other
 * processes through the database trigger; live-only deltas are sent with
 * `pg_notify` when `crossProcess` is on (worker processes).
 */
export class PrismaEventSink implements EventSink {
  private readonly roots = new Map<string, string>();
  /** Serializes NOTIFY calls so deltas arrive in order. */
  private notifyChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly bus: EventBus,
    private readonly opts: { crossProcess?: boolean } = {},
  ) {}

  private async rootOf(orgId: string, taskId: string): Promise<string> {
    const cached = this.roots.get(taskId);
    if (cached) return cached;
    const task = await this.prisma.task.findFirst({ where: { id: taskId, organizationId: orgId }, select: { parentTaskId: true } });
    const root = task?.parentTaskId ?? taskId;
    if (this.roots.size > 10_000) this.roots.clear();
    this.roots.set(taskId, root);
    return root;
  }

  async emit(e: NewEvent): Promise<void> {
    const rootTaskId = await this.rootOf(e.organizationId, e.taskId);
    const row = await this.prisma.runEvent.create({
      data: {
        organizationId: e.organizationId,
        taskId: e.taskId,
        rootTaskId,
        runId: e.runId,
        agentId: e.agentId,
        type: e.type,
        payload: jsonSafe(e.payload),
      },
    });
    this.bus.publish(e.organizationId, toRunEvent(row));
  }

  emitTransient(e: NewEvent): void {
    const rootTaskId = this.roots.get(e.taskId) ?? e.taskId;
    const event: RunEvent = {
      seq: null,
      type: e.type,
      taskId: e.taskId,
      rootTaskId,
      runId: e.runId,
      agentId: e.agentId,
      payload: e.payload,
      createdAt: new Date().toISOString(),
    };
    this.bus.publish(e.organizationId, event);
    if (!this.opts.crossProcess) return;
    for (const part of splitTransient(event)) {
      const msg = JSON.stringify({ o: e.organizationId, e: part });
      this.notifyChain = this.notifyChain
        .then(() => this.prisma.$executeRaw`SELECT pg_notify(${TRANSIENT_CHANNEL}, ${msg})`)
        .catch(() => undefined); // live deltas are best-effort; the persisted model.output is authoritative
    }
  }

  /** Wait for queued NOTIFYs (tests and shutdown). */
  async flush(): Promise<void> {
    await this.notifyChain;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON input type
export function jsonSafe(v: unknown): any {
  return JSON.parse(JSON.stringify(v ?? null)) ?? {};
}

/** Split a large delta into several NOTIFY-sized deltas. */
function splitTransient(e: RunEvent): RunEvent[] {
  const text = typeof e.payload.text === "string" ? e.payload.text : null;
  if (text === null || text.length <= MAX_TRANSIENT_TEXT) return [e];
  const out: RunEvent[] = [];
  for (let i = 0; i < text.length; i += MAX_TRANSIENT_TEXT) out.push({ ...e, payload: { ...e.payload, text: text.slice(i, i + MAX_TRANSIENT_TEXT) } });
  return out;
}
