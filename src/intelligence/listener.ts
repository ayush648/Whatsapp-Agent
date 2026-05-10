import { Client, type Notification } from "pg";

export type AiEvent = {
  message_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  sent_by_ai: boolean;
  created_at: string;
};

export type EventHandler = (event: AiEvent) => Promise<void> | void;

const CHANNEL = "ai_events";
const MAX_BACKOFF_MS = 30_000;

export class EventListener {
  private client: Client | null = null;
  private shouldStop = false;
  private reconnectDelayMs = 1000;

  constructor(
    private readonly connectionString: string,
    private readonly handler: EventHandler
  ) {}

  async start(): Promise<void> {
    while (!this.shouldStop) {
      try {
        await this.connectAndListen();
        if (this.shouldStop) break;
        console.warn("[listener] connection ended; reconnecting");
      } catch (err) {
        if (this.shouldStop) break;
        console.error(
          `[listener] error; reconnecting in ${this.reconnectDelayMs}ms:`,
          err
        );
        await sleep(this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async stop(): Promise<void> {
    this.shouldStop = true;
    if (this.client) {
      try {
        await this.client.end();
      } catch (err) {
        console.error("[listener] error during shutdown:", err);
      }
    }
  }

  private async connectAndListen(): Promise<void> {
    const client = new Client({ connectionString: this.connectionString });
    this.client = client;

    client.on("notification", (msg: Notification) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      let event: AiEvent;
      try {
        event = JSON.parse(msg.payload) as AiEvent;
      } catch (err) {
        console.error("[listener] failed to parse payload:", msg.payload, err);
        return;
      }
      Promise.resolve(this.handler(event)).catch((err) =>
        console.error("[listener] handler error:", err)
      );
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    console.log(`[listener] connected and listening on '${CHANNEL}'`);
    this.reconnectDelayMs = 1000;

    await new Promise<void>((resolve, reject) => {
      client.once("end", () => resolve());
      client.once("error", (err) => reject(err));
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
