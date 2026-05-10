import { z } from "zod";
import { aiCall } from "@/lib/intelligence/ai/call";
import { INTENT_PROMPT } from "@/lib/intelligence/ai/prompts";
import { supabase } from "@/lib/supabase";
import type { MessageRow } from "../processor";

const IntentSchema = z.object({
  intent: z.enum([
    "greeting",
    "question",
    "promise",
    "complaint",
    "status_check",
    "info",
    "confirmation",
    "other",
  ]),
  confidence: z.number().min(0).max(1),
});

const MODEL = process.env.AI_MODEL ?? "openai/gpt-4o-mini";

export async function extractIntent(message: MessageRow, text: string): Promise<void> {
  const result = await aiCall({
    name: "extract_intent",
    model: MODEL,
    messages: [
      { role: "system", content: INTENT_PROMPT },
      { role: "user", content: text },
    ],
    schema: IntentSchema,
    cacheKey: `${message.id}:intent`,
    scope: { conversationId: message.conversation_id },
  });

  await supabase
    .from("messages")
    .update({ ai_intent: result.data.intent })
    .eq("id", message.id);
}
