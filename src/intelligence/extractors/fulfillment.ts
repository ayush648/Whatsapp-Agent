import { z } from "zod";
import { aiCall } from "@/lib/intelligence/ai/call";
import { FULFILLMENT_PROMPT } from "@/lib/intelligence/ai/prompts";
import { supabase } from "@/lib/supabase";
import type { MessageRow } from "../processor";

const FulfillmentSchema = z.object({
  fulfilled_task_id: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().nullable(),
});

const MODEL = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
const MIN_CONFIDENCE = 0.7;

export async function matchFulfillment(message: MessageRow, text: string): Promise<void> {
  // Only inbound messages can fulfill counterparty's open promises.
  if (message.role !== "user") return;

  // Find open promises where THEY owe US something
  const { data: openTasks } = await supabase
    .from("ai_tasks")
    .select("id, description, direction")
    .eq("conversation_id", message.conversation_id)
    .eq("owner", "them")
    .in("status", ["open", "overdue"])
    .order("detected_at", { ascending: false })
    .limit(10);

  if (!openTasks || openTasks.length === 0) return;

  const taskList = openTasks
    .map((t) => `- id=${t.id} (${t.direction}): ${t.description}`)
    .join("\n");

  const result = await aiCall({
    name: "match_fulfillment",
    model: MODEL,
    messages: [
      { role: "system", content: FULFILLMENT_PROMPT },
      {
        role: "user",
        content: `Open items from counterparty:\n${taskList}\n\nNew inbound message:\n"${text}"`,
      },
    ],
    schema: FulfillmentSchema,
    // Don't cache — open task set changes over time
    scope: { conversationId: message.conversation_id },
  });

  const { fulfilled_task_id, confidence, evidence } = result.data;
  if (!fulfilled_task_id || confidence < MIN_CONFIDENCE) return;

  // Verify the task ID came from our candidate list (LLM hallucination guard)
  if (!openTasks.some((t) => t.id === fulfilled_task_id)) {
    console.warn(`[fulfillment] LLM returned task id ${fulfilled_task_id} not in candidate list`);
    return;
  }

  const { error } = await supabase
    .from("ai_tasks")
    .update({
      status: "fulfilled",
      fulfilled_at: new Date().toISOString(),
      fulfilling_message_id: message.id,
      confidence,
      evidence_span: { text: evidence, message_id: message.id, kind: "fulfillment" },
    })
    .eq("id", fulfilled_task_id);

  if (error) console.error("[fulfillment] update failed:", error.message);
}
