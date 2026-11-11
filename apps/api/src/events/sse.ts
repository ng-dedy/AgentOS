import type { FastifyReply, FastifyRequest } from "fastify";
import type { RunEvent } from "@agentos/contracts";
import { formatCursor, metrics, parseCursor, type EventBus, type EventCursor, type EventPage } from "@agentos/platform";
import type { Lifecycle } from "../app";

interface StreamOptions {
  orgId: string;
  /** Live filter (e.g. by root task). */
  filter: (e: RunEvent) => boolean;
  /** Load persisted events after the cursor, in seq order, with the snapshot's xmin. */
  replay: (cursor: EventCursor) => Promise<EventPage>;
  allowedOrigin: string;
  heartbeatMs?: number;
  lifecycle?: Lifecycle;
}

/** The resume cursor from `Last-Event-ID` (EventSource reconnects) or `?after=`. */
export function requestCursor(req: FastifyRequest): EventCursor {
  const header = req.headers["last-event-id"];
  const q = (req.query as { after?: string } | undefined)?.after;
  return parseCursor((Array.isArray(header) ? header[0] : header) ?? q ?? null);
}

/** Seq-only view of the cursor, for the non-streaming JSON endpoint. */
export function lastEventId(req: FastifyRequest): bigint {
  const c = requestCursor(req);
  return c.kind === "none" ? 0n : c.seq;
}

/**
 * Server-Sent Events with commit-safe resume.
 *
 * Order of operations: subscribe (buffering live events), replay persisted rows after the
 * client's cursor in one snapshot, then flush the buffer. Each persisted event's SSE id is
 * `<watermark>.<seq>`: the watermark is a transaction-id bound below which every committed
 * event has already been written to this stream, so a client that reconnects with it
 * (EventSource does this automatically) cannot miss an event that committed late. See
 * `packages/platform/src/events/cursor.ts`.
 *
 * Delivery is at-least-once: an event near the watermark can be sent again after a
 * reconnect. Within one connection repeats are dropped by seq; clients de-duplicate by seq.
 */
export async function streamEvents(req: FastifyRequest, reply: FastifyReply, bus: EventBus, opts: StreamOptions) {
  const cursor = requestCursor(req);
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

  // Until the replay is complete, resuming must start from the client's own cursor.
  let watermark = cursor.kind === "watermark" ? cursor.watermark : 0n;
  let lastSeq = cursor.kind === "none" ? 0n : cursor.seq;
  let replaying = true;
  const buffer: RunEvent[] = [];
  const delivered = new Set<string>();
  const write = (e: RunEvent) => {
    if (e.seq !== null) {
      // A legacy seq cursor keeps its milestone 2B meaning (everything up to it was seen).
      if (cursor.kind === "seq" && BigInt(e.seq) <= cursor.seq) return;
      if (delivered.has(e.seq)) {
        metrics.inc("agentos_events_duplicates_dropped_total", { at: "stream" });
        return;
      }
      delivered.add(e.seq);
      if (delivered.size > 20_000) delivered.delete(delivered.values().next().value!);
      const s = BigInt(e.seq);
      if (s > lastSeq) lastSeq = s;
      res.write(`id: ${formatCursor(watermark, e.seq)}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    } else {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    }
  };

  const unsubscribe = bus.subscribe(
    opts.orgId,
    (e) => {
      if (!opts.filter(e)) return;
      if (replaying) buffer.push(e);
      else write(e);
    },
    (w) => {
      // The listener delivered everything below w (its rows reached us before this call).
      if (!replaying && w > watermark) watermark = w;
    },
  );
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), opts.heartbeatMs ?? 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    opts.lifecycle?.streams.delete(end);
  };
  const end = () => {
    close();
    res.end();
  };
  opts.lifecycle?.streams.add(end);
  req.raw.on("close", close);

  try {
    const page = await opts.replay(cursor);
    for (const e of page.events) write(e);
    // Every event below the replay snapshot's xmin was in the replay (when it was complete).
    if (page.complete && page.snapshotXmin > watermark) watermark = page.snapshotXmin;
    res.write(
      `id: ${formatCursor(watermark, lastSeq)}\nevent: replay.done\ndata: ${JSON.stringify({ lastSeq: lastSeq.toString(), cursor: formatCursor(watermark, lastSeq), complete: page.complete })}\n\n`,
    );
  } finally {
    replaying = false;
    for (const e of buffer) if (e.seq !== null) write(e);
    buffer.length = 0;
  }
}
