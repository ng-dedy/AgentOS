import type { RunEvent } from "@agentos/contracts";
import type { PrismaClient } from "@agentos/db";
import type { EventSink, NewEvent } from "@agentos/runtime";

type Listener = (event: RunEvent) => void;

/**
 * In-process pub/sub keyed by organization. Correctness never depends on it:
 * every persisted event can be replayed from the database. Multi-instance
 * deployments need Postgres LISTEN/NOTIFY or Redis here (see risk R5).
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(orgId: string, listener: Listener): () => void {
    let set = this.listeners.get(orgId);
    if (!set) {
      set = new Set();
      this.listeners.set(orgId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(orgId);
    };
  }

  publish(orgId: string, event: RunEvent) {
    for (const l of this.listeners.get(orgId) ?? []) {
      try {
        l(event);
      } catch {
        // a broken subscriber must not affect the run
      }
    }
  }

  listenerCount(orgId: string): number {
    return this.listeners.get(orgId)?.size ?? 0;
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

/** Persist-then-publish sink used by the runtime. */
export class PrismaEventSink implements EventSink {
  private readonly roots = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly bus: EventBus,
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
    this.bus.publish(e.organizationId, {
      seq: null,
      type: e.type,
      taskId: e.taskId,
      rootTaskId,
      runId: e.runId,
      agentId: e.agentId,
      payload: e.payload,
      createdAt: new Date().toISOString(),
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON input type
export function jsonSafe(v: unknown): any {
  return JSON.parse(JSON.stringify(v ?? null)) ?? {};
}
