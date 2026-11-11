import pg from "pg";
import type { RunEvent } from "@agentos/contracts";
import type { PrismaClient } from "@agentos/db";
import { EVENTS_CHANNEL, TRANSIENT_CHANNEL, toRunEvent, type EventBus } from "./bus";

interface Logger {
  info?: (o: unknown, m?: string) => void;
  warn?: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

/**
 * One dedicated LISTEN connection per process. Persisted-event notifications carry
 * ids only; the row is read back from Postgres (the source of truth) and published
 * on the local bus. After a dropped connection it reconnects with backoff and
 * catches up on rows written meanwhile, so live streams do not silently miss events.
 */
export class PgEventListener {
  private client: pg.Client | null = null;
  private closed = false;
  private lastSeq = 0n;
  private pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  /** Connection state for health checks. */
  connected = false;
  reconnects = 0;

  constructor(
    private readonly databaseUrl: string,
    private readonly prisma: PrismaClient,
    private readonly bus: EventBus,
    private readonly logger?: Logger,
  ) {}

  async start(): Promise<void> {
    const last = await this.prisma.runEvent.findFirst({ orderBy: { seq: "desc" }, select: { seq: true } });
    this.lastSeq = last?.seq ?? 0n;
    await this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const c = this.client;
    this.client = null;
    this.connected = false;
    await c?.end().catch(() => undefined);
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
        await this.catchUp();
        this.logger?.info?.({ event: "event_listener_reconnected", reconnects: this.reconnects }, "event listener reconnected");
      } catch {
        // keep trying
      }
    }
  }

  /** Publish rows written while the connection was down. */
  async catchUp(): Promise<void> {
    const orgs = this.bus.activeOrgs();
    if (orgs.length === 0) return;
    for (;;) {
      const rows = await this.prisma.runEvent.findMany({ where: { seq: { gt: this.lastSeq }, organizationId: { in: orgs } }, orderBy: { seq: "asc" }, take: 500 });
      for (const r of rows) this.publish(r.organizationId, toRunEvent(r));
      if (rows.length < 500) return;
    }
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
      if (this.bus.listenerCount(msg.o) === 0) {
        const s = BigInt(msg.s);
        if (s > this.lastSeq) this.lastSeq = s;
        return;
      }
      this.pending.add(msg.s);
      this.flushTimer ??= setTimeout(() => void this.flush(), 5);
    } catch (err) {
      this.logger?.warn?.({ event: "event_notification_invalid", err: err instanceof Error ? err.message : String(err) }, "ignored malformed notification");
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const seqs = [...this.pending].map((s) => BigInt(s));
    this.pending.clear();
    if (seqs.length === 0) return;
    try {
      const rows = await this.prisma.runEvent.findMany({ where: { seq: { in: seqs } }, orderBy: { seq: "asc" } });
      for (const r of rows) this.publish(r.organizationId, toRunEvent(r));
    } catch (err) {
      this.logger?.error({ event: "event_fetch_failed", err: err instanceof Error ? err.message : String(err) }, "could not read notified events");
    }
  }

  private publish(orgId: string, e: RunEvent) {
    const s = BigInt(e.seq!);
    if (s > this.lastSeq) this.lastSeq = s;
    this.bus.publish(orgId, e);
  }
}
