import type { FastifyReply, FastifyRequest } from "fastify";
import type { RunEvent } from "@agentos/contracts";
import type { EventBus } from "@agentos/platform";

interface StreamOptions {
  orgId: string;
  /** Live filter (e.g. by root task). */
  filter: (e: RunEvent) => boolean;
  /** Load persisted events with seq > after, in order. */
  replay: (after: bigint) => Promise<RunEvent[]>;
  allowedOrigin: string;
  heartbeatMs?: number;
}

export function lastEventId(req: FastifyRequest): bigint {
  const header = req.headers["last-event-id"];
  const q = (req.query as { after?: string } | undefined)?.after;
  const raw = (Array.isArray(header) ? header[0] : header) ?? q ?? "0";
  return /^\d{1,19}$/.test(raw) ? BigInt(raw) : 0n;
}

/**
 * Server-Sent Events with gap-free replay: subscribe first (buffering), replay
 * persisted rows after Last-Event-ID, then flush buffered live events.
 *
 * Duplicates are dropped by a set of delivered seqs rather than a "greater than the
 * last seq" cursor: events from different writers (two workers, two tasks) can commit
 * slightly out of seq order, and a cursor would silently drop the later-committed,
 * lower-seq event. Within one task there is a single writer, so per-task order holds.
 */
export async function streamEvents(req: FastifyRequest, reply: FastifyReply, bus: EventBus, opts: StreamOptions) {
  const after = lastEventId(req);
  reply.hijack();
  const res = reply.raw;
  const origin = req.headers.origin;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(origin && origin === opts.allowedOrigin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {}),
  });
  res.write("retry: 2000\n\n");

  let lastSeq = after;
  let replaying = true;
  const buffer: RunEvent[] = [];
  const delivered = new Set<string>();
  const write = (e: RunEvent) => {
    if (e.seq !== null) {
      const s = BigInt(e.seq);
      if (s <= after || delivered.has(e.seq)) return;
      delivered.add(e.seq);
      if (delivered.size > 10_000) delivered.delete(delivered.values().next().value!);
      if (s > lastSeq) lastSeq = s;
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    } else {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    }
  };

  const unsubscribe = bus.subscribe(opts.orgId, (e) => {
    if (!opts.filter(e)) return;
    if (replaying) buffer.push(e);
    else write(e);
  });
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), opts.heartbeatMs ?? 15_000);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.raw.on("close", close);

  try {
    for (const e of await opts.replay(after)) write(e);
    res.write(`event: replay.done\ndata: ${JSON.stringify({ lastSeq: lastSeq.toString() })}\n\n`);
  } finally {
    replaying = false;
    for (const e of buffer) if (e.seq !== null) write(e);
    buffer.length = 0;
  }
}
