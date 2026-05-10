import { z } from "zod";
import { aiCall } from "@/lib/intelligence/ai/call";
import { SENTIMENT_PROMPT } from "@/lib/intelligence/ai/prompts";
import { supabase } from "@/lib/supabase";
import type { MessageRow } from "../processor";

const SentimentSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  urgency: z.enum(["low", "medium", "high"]),
  priority: z.number().int().min(0).max(100),
});

const MODEL = process.env.AI_MODEL ?? "openai/gpt-4o-mini";

export async function scoreSentiment(message: MessageRow, text: string): Promise<void> {
  const result = await aiCall({
    name: "score_sentiment",
    model: MODEL,
    messages: [
      { role: "system", content: SENTIMENT_PROMPT },
      { role: "user", content: text },
    ],
    schema: SentimentSchema,
    cacheKey: `${message.id}:sentiment`,
    scope: { conversationId: message.conversation_id },
  });

  await supabase
    .from("messages")
    .update({ ai_priority: result.data.priority })
    .eq("id", message.id);
}
