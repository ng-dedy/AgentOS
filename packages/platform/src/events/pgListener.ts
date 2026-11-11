import pg from "pg";
import type { RunEvent } from "@agentos/contracts";
import type { PrismaClient } from "@agentos/db";
import { metrics } from "../observability/metrics";
import { EVENTS_CHANNEL, TRANSIENT_CHANNEL, toRunEvent, type EventBus } from "./bus";
import { currentXmin, readReconciliationWindow } from "./cursor";

interface Logger {
  info?: (o: unknown, m?: string) => void;
  warn?: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

export interface PgEventListenerOptions {
  /** Reconcile at least this often (covers lost notifications and advances the watermark). */
  reconcileMs?: number;
  /** Coalesce notifications for this long before reading. */
  debounceMs?: number;
}

/**
 * One dedicated LISTEN connection per process, plus reconciliation reads from Postgres
 * (the source of truth).
 *
 * A notification only means "something committed"; the listener then reads every row of
 * the subscribed organizations with `txid >= watermark` in one snapshot and publishes
 * them, and the snapshot's xmin becomes the next watermark (see `events/cursor.ts`).
 * Because the read is keyed by transaction id rather than seq, an event whose transaction
 * commits late, a notification lost while the connection was down, or a concurrent writer
 * cannot cause a committed event to be skipped. Re-read rows are dropped by the bus (seq).
 */
export class PgEventListener {
  private client: pg.Client | null = null;
  private closed = false;
  private watermark: bigint | null = null;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private attempt = 0;
  /** Connection state for health checks. */
  connected = false;
  reconnects = 0;
  /** Completed reconciliation passes and the last one's time (health, tests). */
  passes = 0;
  lastPassAt: Date | null = null;
  lastPassError: string | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly prisma: PrismaClient,
    private readonly bus: EventBus,
    private readonly logger?: Logger,
    private readonly opts: PgEventListenerOptions = {},
  ) {}

  async start(): Promise<void> {
    // Nothing committed before now needs a live publish: new subscribers replay from the database.
    this.watermark = await currentXmin(this.prisma);
    await this.connect();
    // Also runs with no subscribers: it then only advances the watermark (one cheap query),
    // so the first pass after a quiet period does not re-read a long window.
    this.interval = setInterval(() => this.schedule(0), this.opts.reconcileMs ?? 2_000);
    this.interval.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    const c = this.client;
    this.client = null;
    this.connected = false;
    await c?.end().catch(() => undefined);
    await this.running?.catch(() => undefined);
  }

  /** The watermark as of the last pass (diagnostics). */
  get currentWatermark(): bigint | null {
    return this.watermark;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on("error", (err) => this.onDisconnect(err));
    client.on("end", () => this.onDisconnect());
    client.on("notification", (n) => this.onNotification(n.channel, n.payload));
    await client.connect();
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    await client.query(`LISTEN ${TRANSIENT_CHANNEL}`);
    this.client = client;
    this.connected = true;
    this.attempt = 0;
  }

  private onDisconnect(err?: unknown) {
    if (this.closed || !this.connected) return;
    this.connected = false;
    this.client = null;
    this.logger?.warn?.({ event: "event_listener_disconnected", err: err instanceof Error ? err.message : undefined }, "event listener lost its connection");
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    while (!this.closed && !this.connected) {
      const wait = Math.min(10_000, 250 * 2 ** this.attempt++);
      await new Promise((r) => setTimeout(r, wait));
      try {
        await this.connect();
        this.reconnects++;
        metrics.inc("agentos_event_listener_reconnects_total");
        await this.reconcile();
        this.logger?.info?.({ event: "event_listener_reconnected", reconnects: this.reconnects }, "event listener reconnected");
      } catch {
        // keep trying
      }
    }
  }

  /** Run a reconciliation pass now (also used by tests and after reconnects). Passes never overlap. */
  async reconcile(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.closed);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Kept for API compatibility with milestone 2B callers. */
  catchUp(): Promise<void> {
    return this.reconcile();
  }

  private async pass(): Promise<void> {
    if (this.watermark === null) return;
    try {
      const { rows, xmin, orgs } = await readReconciliationWindow(this.prisma, this.watermark, () => this.bus.activeOrgs());
      for (const r of rows) this.bus.publish(r.organizationId, toRunEvent(r));
      metrics.inc("agentos_events_reconciled_total", {}, rows.length);
      metrics.set("agentos_event_window_rows", {}, rows.length);
      if (xmin > this.watermark) this.watermark = xmin;
      this.bus.publishWatermark(orgs, this.watermark);
      this.passes++;
      this.lastPassAt = new Date();
      this.lastPassError = null;
    } catch (err) {
      this.lastPassError = err instanceof Error ? err.message.slice(0, 200) : String(err);
      this.logger?.error({ event: "event_reconcile_failed", err: this.lastPassError }, "could not read events; will retry");
    }
  }

  private schedule(delayMs: number) {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile();
    }, delayMs);
  }

  private onNotification(channel: string, payload: string | undefined) {
    if (!payload) return;
    try {
      if (channel === TRANSIENT_CHANNEL) {
        const msg = JSON.parse(payload) as { o: string; e: RunEvent };
        if (this.bus.listenerCount(msg.o) > 0) this.bus.publish(msg.o, msg.e);
        return;
      }
      const msg = JSON.parse(payload) as { o: string; s: string };
      if (this.bus.listenerCount(msg.o) === 0) return;
      this.schedule(this.opts.debounceMs ?? 5);
    } catch (err) {
      this.logger?.warn?.({ event: "event_notification_invalid", err: err instanceof Error ? err.message : String(err) }, "ignored malformed notification");
    }
  }
}
