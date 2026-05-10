import { z } from "zod";
import { aiCall } from "@/lib/intelligence/ai/call";
import { SALIENCE_PROMPT } from "@/lib/intelligence/ai/prompts";
import { embed } from "@/lib/intelligence/ai/embed";
import { supabase } from "@/lib/supabase";
import type { MessageRow } from "../processor";

const SalienceSchema = z.object({
  salient: z.boolean(),
  kind: z
    .enum(["fact", "preference", "history", "relationship", "policy", "outcome"])
    .nullable(),
  summary: z.string().nullable(),
});

const MODEL = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
const INITIAL_SALIENCE = 0.7;

export async function writeMemory(message: MessageRow, text: string): Promise<void> {
  // Short messages rarely carry durable info — cheap heuristic skip.
  if (text.length < 12) return;

  const verdict = await aiCall({
    name: "salience_check",
    model: MODEL,
    messages: [
      { role: "system", content: SALIENCE_PROMPT },
      {
        role: "user",
        content: `Speaker: ${message.role === "user" ? "counterparty" : "us"}\n\n${text}`,
      },
    ],
    schema: SalienceSchema,
    cacheKey: `${message.id}:salience`,
    scope: { conversationId: message.conversation_id },
  });

  if (!verdict.data.salient || !verdict.data.kind || !verdict.data.summary) return;

  // Embed the summary (more semantically clean than raw chat message).
  let vector: number[];
  try {
    vector = await embed(verdict.data.summary);
  } catch (err) {
    console.error("[memory.writer] embedding failed:", err);
    return;
  }

  const { error } = await supabase.from("ai_memory_chunks").insert({
    conversation_id: message.conversation_id,
    kind: verdict.data.kind,
    text: verdict.data.summary,
    embedding: vector as unknown as string, // pgvector accepts JSON-array literal
    source: {
      message_id: message.id,
      role: message.role,
      original_text_preview: text.slice(0, 200),
    },
    salience: INITIAL_SALIENCE,
  });

  if (error) console.error("[memory.writer] insert failed:", error.message);
}
