import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDeps } from "../src/app";
import { db, makeApp, resetDb, signup, TEST_DB, type Session } from "./helpers";

/**
 * Milestone 2C: committed events can never be permanently missed by a connected client.
 * Real Postgres, two API instances (each with its own LISTEN connection), raw writer
 * connections that hold transactions open, and real HTTP SSE clients.
 */
type Inst = { app: FastifyInstance; deps: AppDeps; base: string };
let A: Inst;
let B: Inst;
let s: Session;

async function instance(): Promise<Inst> {
  const { app, deps } = await makeApp({ EVENT_RECONCILE_MS: "200" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, deps, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

const writers: pg.Client[] = [];
async function writer(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  writers.push(c);
  return c;
}

/** Insert a RunEvent on `c` (inside whatever transaction `c` has open) and return its seq. */
async function insert(c: pg.Client, rootTaskId: string, label: string): Promise<string> {
  const r = await c.query<{ seq: string }>(
    `INSERT INTO "RunEvent" ("organizationId", "taskId", "rootTaskId", "type", "payload") VALUES ($1, $2, $2, 'task.status', $3) RETURNING seq::text`,
    [s.orgId, rootTaskId, JSON.stringify({ label })],
  );
  return r.rows[0]!.seq;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
}
/** A real SSE client: collects events until closed. */
function sse(url: string, headers: Record<string, string>) {
  const ctl = new AbortController();
  const events: SseEvent[] = [];
  const done = (async () => {
    const res = await fetch(url, { headers, signal: ctl.signal });
    const reader = res.body!.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const e: SseEvent = {};
        for (const line of chunk.split("\n")) {
          const m = /^(id|event|data): (.*)$/.exec(line);
          if (m) e[m[1] as keyof SseEvent] = m[2];
        }
        if (e.event) events.push(e);
      }
    }
  })().catch(() => undefined);
  const persisted = () => events.filter((e) => e.id && e.event !== "replay.done");
  return {
    events,
    seqs: () => persisted().map((e) => JSON.parse(e.data!).seq as string),
    lastId: () => [...events].reverse().find((e) => e.id)?.id,
    close: async () => {
      ctl.abort();
      await done;
    },
  };
}

const busCollector = (inst: Inst) => {
  const got: string[] = [];
  const unsub = inst.deps.bus.subscribe(s.orgId, (e) => {
    if (e.seq) got.push(e.seq);
  });
  return { got, unsub };
};

beforeAll(async () => {
  await resetDb();
  A = await instance();
  B = await instance();
  s = await signup(A.app, "Events Inc");
});

afterAll(async () => {
  for (const c of writers) await c.end().catch(() => undefined);
  await A?.app.close();
  await B?.app.close();
  await db().$disconnect();
});

describe("commit-safe event delivery", () => {
  it("delivers an event whose transaction commits after a later seq (the documented 2B race)", async () => {
    const root = "root_delayed";
    const live = busCollector(B);
    // Synthetic root ids (no Task row), so this uses the org-wide feed; it shares the cursor code with task streams.
    const org = sse(`${B.base}/api/v1/events/stream?after=1`, { cookie: s.cookie });
    await until("org stream replay", () => org.events.some((e) => e.event === "replay.done"));

    const slow = await writer();
    await slow.query("BEGIN");
    const early = await insert(slow, root, "early, commits late"); // seq N, not committed
    const fast = await writer();
    const late = await insert(fast, root, "later seq, commits first"); // seq N+1, committed
    expect(BigInt(late)).toBeGreaterThan(BigInt(early));

    await until("later event delivered live on instance B", () => live.got.includes(late));
    await until("later event on the SSE stream", () => org.seqs().includes(late));
    const cursorAfterLate = org.lastId()!;
    expect(cursorAfterLate).toMatch(/^\d+\.\d+$/);

    // A milestone 2B-style "seq > last seen" read now would never return the early event.
    const legacy = await db().runEvent.findMany({ where: { organizationId: s.orgId, rootTaskId: root, seq: { gt: BigInt(late) } } });
    expect(legacy).toHaveLength(0);

    // The client disconnects before the slow transaction commits...
    await org.close();
    await slow.query("COMMIT");

    // ...and the live path on the other instance still delivers it (txid >= watermark).
    await until("early event delivered live after its late commit", () => live.got.includes(early));

    // A reconnect with the stream's resume cursor gets it too.
    const again = sse(`${B.base}/api/v1/events/stream`, { cookie: s.cookie, "last-event-id": cursorAfterLate });
    await until("reconnect replay", () => again.events.some((e) => e.event === "replay.done"));
    expect(again.seqs()).toContain(early);
    await again.close();

    // The legacy numeric cursor keeps its 2B meaning and would skip it: this is the race the new cursor closes.
    const legacyStream = sse(`${B.base}/api/v1/events/stream`, { cookie: s.cookie, "last-event-id": late });
    await until("legacy replay", () => legacyStream.events.some((e) => e.event === "replay.done"));
    expect(legacyStream.seqs()).not.toContain(early);
    await legacyStream.close();
    live.unsub();
  });

  it("concurrent writers with random commit delays: every committed event reaches both instances, and a reconnecting client misses none", async () => {
    const root = "root_concurrent";
    const onA = busCollector(A);
    const onB = busCollector(B);
    const first = sse(`${B.base}/api/v1/events/stream?after=1`, { cookie: s.cookie });
    await until("stream ready", () => first.events.some((e) => e.event === "replay.done"));

    const all: string[] = [];
    const clients = await Promise.all(Array.from({ length: 8 }, () => writer()));
    let reconnect: ReturnType<typeof sse> | null = null;
    const work = clients.map(async (c, w) => {
      for (let i = 0; i < 25; i++) {
        await c.query("BEGIN");
        const seq = await insert(c, root, `w${w}-${i}`);
        await sleep(Math.floor(Math.random() * 25)); // commit order differs from seq order
        await c.query("COMMIT");
        all.push(seq);
        if (w === 0 && i === 12) {
          // Mid-way: the client drops and reconnects with its cursor.
          const id = first.lastId();
          await first.close();
          reconnect = sse(`${B.base}/api/v1/events/stream`, { cookie: s.cookie, ...(id ? { "last-event-id": id } : {}) });
        }
      }
    });
    await Promise.all(work);
    expect(all).toHaveLength(200);

    await until("all 200 on instance A", () => all.every((x) => onA.got.includes(x)));
    await until("all 200 on instance B", () => all.every((x) => onB.got.includes(x)));
    // The bus never hands a subscriber the same persisted event twice.
    expect(new Set(onB.got).size).toBe(onB.got.length);

    const r = reconnect as unknown as ReturnType<typeof sse>;
    await until("reconnected stream has everything", () => all.every((x) => first.seqs().includes(x) || r.seqs().includes(x)), 15_000);
    // Within one connection a seq is never written twice.
    expect(new Set(r.seqs()).size).toBe(r.seqs().length);
    // Across the reconnect some events may repeat (at-least-once); clients drop them by seq.
    const union = new Set([...first.seqs(), ...r.seqs()]);
    for (const x of all) expect(union.has(x)).toBe(true);
    await r.close();
    onA.unsub();
    onB.unsub();
  });

  it("survives the listener's database connection being killed while transactions are open", async () => {
    const root = "root_interrupt";
    const onB = busCollector(B);
    const before = B.deps.listener!.reconnects;
    const pending = await writer();
    await pending.query("BEGIN");
    const inFlight = await insert(pending, root, "open across the outage");

    // Kill B's LISTEN connection (only that one: it is the session that ran LISTEN).
    const killed = await db().$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%' AND pid <> pg_backend_pid() AND backend_start = (SELECT max(backend_start) FROM pg_stat_activity WHERE query LIKE 'LISTEN%')`,
    );
    expect(killed[0]!.n).toBeGreaterThanOrEqual(1);
    const during: string[] = [];
    const w = await writer();
    for (let i = 0; i < 5; i++) during.push(await insert(w, root, `during-${i}`));
    await pending.query("COMMIT");

    const listeners = [A.deps.listener!, B.deps.listener!];
    await until("a listener reconnected", () => listeners.some((l) => l.reconnects > 0) && listeners.every((l) => l.connected), 15_000);
    await until("everything written during the outage reached B", () => [...during, inFlight].every((x) => onB.got.includes(x)), 15_000);
    expect(B.deps.listener!.reconnects + A.deps.listener!.reconnects).toBeGreaterThan(before);
    onB.unsub();
  });

  it("an event persisted through instance A's sink streams live from instance B", async () => {
    const onB = busCollector(B);
    await A.deps.sink.emit({ organizationId: s.orgId, taskId: "root_sink", runId: null, agentId: null, type: "task.status", payload: { status: "running" } });
    const row = await db().runEvent.findFirst({ where: { organizationId: s.orgId, taskId: "root_sink" }, orderBy: { seq: "desc" } });
    await until("sink event on B", () => onB.got.includes(row!.seq.toString()));
    onB.unsub();
  });
});
