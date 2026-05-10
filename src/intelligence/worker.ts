import { EventListener, type AiEvent } from "./listener";

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
  // Sprint 0: log only. Real handlers (extraction, classification, memory)
  // come in Sprint 1 — this no-op proves the pipe is live.
  console.log("[worker] event:", JSON.stringify(event));
}

const listener = new EventListener(DATABASE_URL, handleEvent);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] received ${signal}, shutting down…`);
  await listener.stop();
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

console.log("[worker] starting…");
listener.start().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
