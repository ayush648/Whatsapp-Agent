import { z } from "zod";
import { aiCall } from "@/lib/intelligence/ai/call";
import { TASK_PROMPT } from "@/lib/intelligence/ai/prompts";
import { supabase } from "@/lib/supabase";
import type { MessageRow } from "../processor";

const TaskSchema = z.object({
  direction: z.enum([
    "inbound_promise",
    "outbound_promise",
    "question_to_us",
    "question_to_them",
  ]),
  description: z.string().min(1).max(500),
  owner: z.enum(["us", "them"]),
  soft_due: z.enum([
    "2_hours",
    "4_hours",
    "eod",
    "today",
    "tomorrow",
    "this_week",
    "unspecified",
  ]),
  evidence: z.string().max(500),
  confidence: z.number().min(0).max(1),
});

const TasksSchema = z.object({
  tasks: z.array(TaskSchema),
});

const MODEL = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
const MIN_CONFIDENCE = 0.5;

export async function extractTasks(message: MessageRow, text: string): Promise<void> {
  const result = await aiCall({
    name: "extract_tasks",
    model: MODEL,
    messages: [
      { role: "system", content: TASK_PROMPT },
      { role: "user", content: text },
    ],
    schema: TasksSchema,
    cacheKey: `${message.id}:tasks`,
    scope: { conversationId: message.conversation_id },
  });

  const accepted = result.data.tasks.filter((t) => t.confidence >= MIN_CONFIDENCE);
  if (accepted.length === 0) return;

  const baseTime = new Date(message.created_at).getTime();
  const rows = accepted.map((t) => ({
    conversation_id: message.conversation_id,
    source_message_id: message.id,
    direction: t.direction,
    description: t.description.slice(0, 500),
    owner: t.owner,
    status: "open" as const,
    due_at: resolveSoftDue(t.soft_due, baseTime),
    detected_at: new Date().toISOString(),
    confidence: t.confidence,
    evidence_span: { text: t.evidence, message_id: message.id },
  }));

  const { error } = await supabase.from("ai_tasks").insert(rows);
  if (error) console.error("[tasks] insert failed:", error.message);
}

// Convert the LLM's coarse soft_due hint into an actual timestamp.
// All offsets are relative to the message timestamp, not "now", so retries
// produce consistent due_at values.
function resolveSoftDue(soft: string, baseMs: number): string | null {
  switch (soft) {
    case "2_hours":   return new Date(baseMs + 2 * 3600_000).toISOString();
    case "4_hours":   return new Date(baseMs + 4 * 3600_000).toISOString();
    case "eod": {
      // 6 PM IST on the message day. IST = UTC+5:30.
      const d = new Date(baseMs);
      const ist = new Date(baseMs + 5.5 * 3600_000);
      ist.setUTCHours(12, 30, 0, 0); // 12:30 UTC = 18:00 IST
      const result = new Date(ist.getTime() - 5.5 * 3600_000);
      // If EOD has already passed today, push to tomorrow EOD
      return result.getTime() < d.getTime()
        ? new Date(result.getTime() + 24 * 3600_000).toISOString()
        : result.toISOString();
    }
    case "today":     return new Date(baseMs + 8 * 3600_000).toISOString(); // ~8hr cushion
    case "tomorrow":  return new Date(baseMs + 24 * 3600_000).toISOString();
    case "this_week": return new Date(baseMs + 3 * 24 * 3600_000).toISOString();
    case "unspecified": return null;
    default: return null;
  }
}
