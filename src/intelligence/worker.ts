import { EventListener, type AiEvent } from "./listener";
import { queue } from "@/lib/intelligence/queue";
import { enqueueMessageProcessing, registerMessageProcessor } from "./processor";
import { registerScanner } from "./followups/scanner";
import { registerFollowupHandler } from "./followups/handler";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    [
      "[worker] DATABASE_URL is not set.",
      "",
      "Add it to .env.local using your Supabase Postgres connection string.",
      "IMPORTANT: use the Direct connection or Session pooler — NOT the",
      "Transaction pooler (port 6543), which breaks LISTEN/NOTIFY.",
      "",
      "Copy from: Supabase Dashboard → Project Settings → Database",
      "                              → Connection string → 'Session pooler' or 'Direct'",
    ].join("\n")
  );
  process.exit(1);
}

async function handleEvent(event: AiEvent): Promise<void> {
  try {
    await enqueueMessageProcessing(event);
  } catch (err) {
    console.error("[worker] failed to enqueue message processing:", err);
    // Watermark replay (Sprint 6) will catch missed events on next restart.
  }
}

const listener = new EventListener(DATABASE_URL, handleEvent);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] received ${signal}, shutting down…`);
  await listener.stop();
  await queue.stop();
  console.log("[worker] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[worker] uncaught exception:", err);
  void shutdown("uncaughtException");
});

async function main(): Promise<void> {
  console.log("[worker] starting…");
  await queue.start();
  await registerMessageProcessor();
  await registerFollowupHandler();
  await registerScanner();
  console.log("[worker] queue + processor + follow-up scanner registered");
  await listener.start(); // blocks until listener is stopped
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
