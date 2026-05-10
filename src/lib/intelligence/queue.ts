import {
  PgBoss,
  type Job,
  type SendOptions,
  type WorkOptions,
  type ScheduleOptions,
} from "pg-boss";

// Single-job handler. pg-boss v12 always passes an array (default batchSize=1);
// this wrapper unwraps it so callers write simple per-job logic.
export type JobHandler<T> = (job: Job<T>) => Promise<void>;

class Queue {
  private boss: PgBoss | null = null;
  private started = false;
  private knownQueues = new Set<string>();

  async start(): Promise<void> {
    if (this.started) return;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "[queue] DATABASE_URL is not set. The queue needs the same Postgres " +
          "connection string as the worker (Session pooler at port 5432)."
      );
    }

    this.boss = new PgBoss({
      connectionString,
      schema: "pgboss",
      max: 5,
    });

    this.boss.on("error", (err) => {
      console.error("[queue] pg-boss error:", err);
    });

    await this.boss.start();
    this.started = true;
    console.log("[queue] started");
  }

  async stop(): Promise<void> {
    if (!this.boss) return;
    await this.boss.stop({ graceful: true, timeout: 30_000 });
    this.boss = null;
    this.started = false;
    this.knownQueues.clear();
    console.log("[queue] stopped");
  }

  async enqueue<T extends object = object>(
    name: string,
    data: T,
    options: SendOptions = {}
  ): Promise<string | null> {
    this.assertStarted();
    await this.ensureQueue(name);
    return this.boss!.send(name, data, options);
  }

  async register<T extends object = object>(
    name: string,
    handler: JobHandler<T>,
    options: WorkOptions = {}
  ): Promise<void> {
    this.assertStarted();
    await this.ensureQueue(name);
    await this.boss!.work<T>(name, options, async (jobs) => {
      for (const job of jobs) {
        await handler(job);
      }
    });
  }

  async cron<T extends object = object>(
    name: string,
    schedule: string,
    data: T = {} as T,
    options: ScheduleOptions = {}
  ): Promise<void> {
    this.assertStarted();
    await this.ensureQueue(name);
    await this.boss!.schedule(name, schedule, data, options);
  }

  // Internal: pg-boss v10+ requires explicit queue creation before send/work.
  // Memoised so we don't re-issue the call for every enqueue.
  // Defaults: retryLimit 3, exponential backoff. Override per-queue if needed.
  private async ensureQueue(name: string): Promise<void> {
    if (this.knownQueues.has(name)) return;
    await this.boss!.createQueue(name, {
      retryLimit: 3,
      retryBackoff: true,
    });
    this.knownQueues.add(name);
  }

  private assertStarted(): void {
    if (!this.started || !this.boss) {
      throw new Error("[queue] not started — call queue.start() first");
    }
  }
}

export const queue = new Queue();
