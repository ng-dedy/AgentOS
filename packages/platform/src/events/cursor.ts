import type { RunEvent } from "@agentos/contracts";
import type { PrismaClient } from "@agentos/db";
import { toRunEvent } from "./bus";

/**
 * Commit-safe event cursor.
 *
 * `RunEvent.seq` is assigned when a row is inserted, not when its transaction commits, so
 * a transaction holding seq 10 can commit after seq 11. A "seq > last seen" cursor then
 * skips 10 for good. Instead every row records the id of the transaction that inserted it
 * (`txid`, xid8), and a reader remembers the `xmin` of the snapshot it read with: the
 * oldest transaction that was still running. Every transaction below that xmin had
 * finished, so its rows were visible to that read. Reading `txid >= watermark` next time
 * therefore sees every row that committed since, however late, and never misses one.
 * Rows near the watermark can be read twice: delivery is at-least-once and consumers
 * de-duplicate by seq (the bus, each SSE stream, and the web client all do).
 *
 * The SSE resume token is `<watermark>.<seq>`; a bare number is a legacy seq cursor.
 */
export type EventCursor = { kind: "watermark"; watermark: bigint; seq: bigint } | { kind: "seq"; seq: bigint } | { kind: "none" };

export function parseCursor(raw: string | undefined | null): EventCursor {
  if (!raw) return { kind: "none" };
  const m = /^(\d{1,20})\.(\d{1,19})$/.exec(raw);
  if (m) return { kind: "watermark", watermark: BigInt(m[1]!), seq: BigInt(m[2]!) };
  if (/^\d{1,19}$/.test(raw)) return BigInt(raw) === 0n ? { kind: "none" } : { kind: "seq", seq: BigInt(raw) };
  return { kind: "none" };
}

export const formatCursor = (watermark: bigint, seq: bigint | string) => `${watermark}.${seq}`;

export interface EventPage {
  events: RunEvent[];
  /** xmin of the snapshot the rows were read with; safe to resume from when `complete`. */
  snapshotXmin: bigint;
  /** False when `limit` cut the read short (resume from the old cursor in that case). */
  complete: boolean;
}

const COLUMNS = `"seq", "organizationId", "taskId", "rootTaskId", "runId", "agentId", "type", "payload", "createdAt"`;
type Row = Parameters<typeof toRunEvent>[0] & { organizationId: string };

/**
 * Read events in one REPEATABLE READ snapshot together with that snapshot's xmin.
 * `where` is a fixed SQL fragment built by the callers below; parameters are bound.
 */
async function readPage(
  prisma: PrismaClient,
  where: string,
  params: unknown[],
  limit: number,
  order: "asc" | "desc" = "asc",
): Promise<{ rows: Row[]; xmin: bigint; complete: boolean }> {
  return prisma.$transaction(
    async (tx) => {
      const [snap] = await tx.$queryRawUnsafe<{ xmin: string }[]>(`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`);
      const rows: Row[] = [];
      let lastSeq: bigint | null = null;
      const page = Math.min(500, limit);
      for (;;) {
        const cont: string = lastSeq === null ? "" : order === "asc" ? ` AND "seq" > ${lastSeq}` : ` AND "seq" < ${lastSeq}`;
        const batch: Row[] = await tx.$queryRawUnsafe<Row[]>(
          `SELECT ${COLUMNS} FROM "RunEvent" WHERE ${where}${cont} ORDER BY "seq" ${order} LIMIT ${page}`,
          ...params,
        );
        rows.push(...batch);
        if (batch.length < page) return { rows, xmin: BigInt(snap!.xmin), complete: true };
        if (rows.length >= limit) return { rows, xmin: BigInt(snap!.xmin), complete: false };
        lastSeq = batch.at(-1)!.seq;
      }
    },
    { isolationLevel: "RepeatableRead", timeout: 15_000, maxWait: 10_000 },
  );
}

/** Events of one task tree after `cursor` (all of them when there is none). */
export async function readTreeEvents(prisma: PrismaClient, orgId: string, rootTaskId: string, cursor: EventCursor, limit = 5000): Promise<EventPage> {
  const base = `"organizationId" = $1 AND "rootTaskId" = $2`;
  const { rows, xmin, complete } =
    cursor.kind === "watermark"
      ? await readPage(prisma, `${base} AND "txid" >= $3::text::xid8`, [orgId, rootTaskId, cursor.watermark.toString()], limit)
      : cursor.kind === "seq"
        ? await readPage(prisma, `${base} AND "seq" > $3`, [orgId, rootTaskId, cursor.seq], limit)
        : await readPage(prisma, base, [orgId, rootTaskId], limit);
  return { events: rows.map(toRunEvent), snapshotXmin: xmin, complete };
}

/** Organization-wide events after `cursor`; with no cursor, the most recent `recent` events. */
export async function readOrgEvents(prisma: PrismaClient, orgId: string, cursor: EventCursor, opts: { limit?: number; recent?: number } = {}): Promise<EventPage> {
  const limit = opts.limit ?? 500;
  if (cursor.kind === "none") {
    const { rows, xmin } = await readPage(prisma, `"organizationId" = $1`, [orgId], opts.recent ?? 50, "desc");
    const latest = rows.slice(0, opts.recent ?? 50).reverse();
    // Only the latest few are replayed, so resuming from this snapshot is not complete history.
    return { events: latest.map(toRunEvent), snapshotXmin: xmin, complete: false };
  }
  const { rows, xmin, complete } =
    cursor.kind === "watermark"
      ? await readPage(prisma, `"organizationId" = $1 AND "txid" >= $2::text::xid8`, [orgId, cursor.watermark.toString()], limit)
      : await readPage(prisma, `"organizationId" = $1 AND "seq" > $2`, [orgId, cursor.seq], limit);
  return { events: rows.map(toRunEvent), snapshotXmin: xmin, complete };
}

/**
 * Listener reconciliation: rows of the given organizations with `txid >= watermark`, read
 * in one snapshot, plus that snapshot's xmin (the next watermark). The organization list
 * is taken after the snapshot so a subscriber that joins later is covered by its own replay.
 */
export async function readReconciliationWindow(
  prisma: PrismaClient,
  watermark: bigint,
  activeOrgs: () => string[],
): Promise<{ rows: Row[]; xmin: bigint; orgs: string[] }> {
  return prisma.$transaction(
    async (tx) => {
      const [snap] = await tx.$queryRawUnsafe<{ xmin: string }[]>(`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`);
      const orgs = activeOrgs();
      const rows: Row[] = [];
      if (orgs.length > 0) {
        let lastSeq = 0n;
        for (;;) {
          const batch: Row[] = await tx.$queryRawUnsafe<Row[]>(
            `SELECT ${COLUMNS} FROM "RunEvent" WHERE "txid" >= $1::text::xid8 AND "organizationId" = ANY($2::text[]) AND "seq" > $3 ORDER BY "seq" ASC LIMIT 500`,
            watermark.toString(),
            orgs,
            lastSeq,
          );
          rows.push(...batch);
          if (batch.length < 500) break;
          lastSeq = batch.at(-1)!.seq;
        }
      }
      return { rows, xmin: BigInt(snap!.xmin), orgs };
    },
    { isolationLevel: "RepeatableRead", timeout: 15_000, maxWait: 10_000 },
  );
}

/** Current snapshot xmin (listener start: nothing older needs to be published live). */
export async function currentXmin(prisma: PrismaClient): Promise<bigint> {
  const [snap] = await prisma.$queryRawUnsafe<{ xmin: string }[]>(`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`);
  return BigInt(snap!.xmin);
}
