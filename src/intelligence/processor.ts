import { supabase } from "@/lib/supabase";
import { queue } from "@/lib/intelligence/queue";
import { flags } from "@/lib/intelligence/flags";
import { killSwitch } from "@/lib/intelligence/safety/kill-switch";
import type { AiEvent } from "./listener";
import { extractIntent } from "./extractors/intent";
import { extractEntities } from "./extractors/entities";
import { scoreSentiment } from "./extractors/sentiment";
import { extractTasks } from "./extractors/tasks";
import { matchFulfillment } from "./extractors/fulfillment";
import { writeMemory } from "./memory/writer";
import { updateConversationState } from "./state-machine";

const JOB_NAME = "process-message";
const CONSUMER = "message-processor";
const MASTER_FLAG = "intel.message_processing";

export type ProcessMessageJob = {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  sentByAi: boolean;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string | null;
  sent_by_ai: boolean | null;
  created_at: string;
  transcript: string | null;
  media_caption: string | null;
  media_type: string | null;
};

// Enqueue a job in response to a pg_notify event.
export async function enqueueMessageProcessing(event: AiEvent): Promise<void> {
  await queue.enqueue<ProcessMessageJob>(JOB_NAME, {
    messageId: event.message_id,
    conversationId: event.conversation_id,
    role: event.role,
    sentByAi: event.sent_by_ai,
  });
}

// Register the queue handler. Call once at worker boot.
export async function registerMessageProcessor(): Promise<void> {
  await queue.register<ProcessMessageJob>(JOB_NAME, async (job) => {
    await processMessage(job.data);
  });
}

async function processMessage(data: ProcessMessageJob): Promise<void> {
  const { messageId, conversationId, role } = data;
  const scope = { conversationId };

  // 1. Master feature flag — disabled by default. Admin flips per-tenant/conversation/global.
  if (!(await flags.isEnabled(MASTER_FLAG, scope))) return;

  // 2. Kill switch
  if (await killSwitch.isKilled(scope)) {
    console.log(`[processor] skip ${messageId}: kill switch tripped`);
    return;
  }

  // 3. Idempotency — never re-process the same message
  const eventId = `message:${messageId}`;
  const { data: already } = await supabase
    .from("ai_processed_events")
    .select("processed_at")
    .eq("consumer_name", CONSUMER)
    .eq("event_id", eventId)
    .maybeSingle();
  if (already) return;

  // 4. Fetch full message
  const { data: message, error } = await supabase
    .from("messages")
    .select(
      "id, conversation_id, role, content, sent_by_ai, created_at, transcript, media_caption, media_type"
    )
    .eq("id", messageId)
    .maybeSingle();
  if (error || !message) {
    console.error(`[processor] message ${messageId} not found:`, error?.message);
    return;
  }

  const text = textOf(message as MessageRow);
  if (!text) {
    await markProcessed(eventId, messageId);
    return;
  }

  // 5. Fan out to extractors. Each is independent; Promise.allSettled keeps
  // one failure from killing the rest.
  const tasks: Array<Promise<unknown>> = [];

  if (role === "user") {
    // Inbound message — full pipeline
    tasks.push(safe("intent", () => extractIntent(message as MessageRow, text)));
    tasks.push(safe("entities", () => extractEntities(message as MessageRow, text)));
    tasks.push(safe("sentiment", () => scoreSentiment(message as MessageRow, text)));
    tasks.push(safe("tasks", () => extractTasks(message as MessageRow, text)));
    tasks.push(safe("fulfillment", () => matchFulfillment(message as MessageRow, text)));
    tasks.push(safe("memory", () => writeMemory(message as MessageRow, text)));
  } else {
    // Our outbound — only memory + state (we don't need intent on our own messages)
    tasks.push(safe("memory", () => writeMemory(message as MessageRow, text)));
  }
  tasks.push(safe("state", () => updateConversationState(conversationId)));

  await Promise.allSettled(tasks);

  await markProcessed(eventId, messageId);
}

async function markProcessed(eventId: string, messageId: string): Promise<void> {
  // Insert idempotency row first (PK on (consumer, event) makes this idempotent).
  await supabase
    .from("ai_processed_events")
    .insert({ consumer_name: CONSUMER, event_id: eventId })
    .select()
    .maybeSingle();
  await supabase
    .from("messages")
    .update({ ai_processed_at: new Date().toISOString() })
    .eq("id", messageId);
}

function textOf(m: MessageRow): string | null {
  // Webhook stores merged text in `content` (raw text, transcript, or PDF text).
  // Fallbacks are belt-and-suspenders for older rows.
  return m.content || m.transcript || m.media_caption || null;
}

async function safe(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[processor.${name}] failed:`, err);
  }
}

