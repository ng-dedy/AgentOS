import { hostname } from "node:os";
import type { PrismaClient } from "@agentos/db";
import { activityStats } from "@agentos/workflows";

/** Writes this worker's liveness row every `intervalMs`. The API treats >30 s of silence as unhealthy. */
export class WorkerHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  readonly startedAt = new Date();

  constructor(
    private readonly prisma: PrismaClient,
    readonly id: string,
    private readonly taskQueue: string,
    private readonly version: string,
    private readonly onError: (err: unknown) => void,
    private readonly intervalMs = 5_000,
  ) {}

  async start(): Promise<void> {
    await this.beat("running").catch(this.onError);
    this.timer = setInterval(() => void this.beat("running").catch(this.onError), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.beat("stopping").catch(this.onError);
  }

  private async beat(status: "running" | "stopping") {
    const data = {
      hostname: hostname(),
      pid: process.pid,
      taskQueue: this.taskQueue,
      version: this.version,
      activeActivities: activityStats.active,
      status,
      startedAt: this.startedAt,
      lastSeenAt: new Date(),
    };
    await this.prisma.workerHeartbeat.upsert({ where: { id: this.id }, create: { id: this.id, ...data }, update: data });
  }
}
