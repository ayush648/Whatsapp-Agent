import { z } from "zod";
import { aiCall } from "@/lib/intelligence/ai/call";
import { FOLLOWUP_DRAFT_PROMPT } from "@/lib/intelligence/ai/prompts";
import { supabase } from "@/lib/supabase";

const DraftSchema = z.object({
  draft_text: z.string().min(1).max(500),
  language_hint: z.enum(["hi", "en", "hinglish"]),
  confidence: z.number().min(0).max(1),
});

export type DraftInput = {
  conversationId: string;
  taskId: string;
  taskDescription: string;
  sourceMessageText?: string | null;
  attemptNumber: number;
};

export type DraftResult = {
  text: string;
  language: "hi" | "en" | "hinglish";
  confidence: number;
  model: string;
};

const MODEL = process.env.AI_MODEL ?? "openai/gpt-4o-mini";

// Heuristic language detection from a sample of recent chat. The drafter
// validates this hint internally; we just pass it as a starting point.
function detectLanguage(samples: string[]): "hi" | "en" | "hinglish" {
  const joined = samples.join(" ");
  const devanagari = (joined.match(/[ऀ-ॿ]/g) ?? []).length;
  const latin = (joined.match(/[a-zA-Z]/g) ?? []).length;
  if (devanagari > Math.max(latin, 1) * 0.5) return "hi";
  if (latin > 0 && devanagari === 0) {
    const hinglishMarkers =
      /\b(hai|hain|kal|aap|bhai|kar|kya|nahi|nahin|theek|thik|jaldi|abhi|haan|main|mere|aapka|aapko|karna|karunga|dunga|bhejna|bhej|liya|gaya|tha|thi)\b/i;
    return hinglishMarkers.test(joined) ? "hinglish" : "en";
  }
  return "hinglish";
}

export async function draftFollowup(input: DraftInput): Promise<DraftResult> {
  // Pull last 6 messages for register + language detection
  const { data: recent } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", input.conversationId)
    .order("created_at", { ascending: false })
    .limit(6);

  const samples = (recent ?? [])
    .reverse()
    .filter((m) => m.content && m.content.length < 600)
    .map((m) => `${m.role === "user" ? "Them" : "Us"}: ${m.content}`);

  const detected = detectLanguage(samples);

  const userPrompt = [
    `Task to follow up on: ${input.taskDescription}`,
    input.sourceMessageText
      ? `\nOriginal message that created this task:\n"${input.sourceMessageText}"`
      : "",
    `\nRecent chat (latest last):\n${samples.length > 0 ? samples.join("\n") : "(no prior messages)"}`,
    `\nAttempt number: ${input.attemptNumber}`,
    `\nLanguage hint (from chat): ${detected}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await aiCall({
    name: "draft_followup",
    model: MODEL,
    messages: [
      { role: "system", content: FOLLOWUP_DRAFT_PROMPT },
      { role: "user", content: userPrompt },
    ],
    schema: DraftSchema,
    scope: { conversationId: input.conversationId },
    correlationId: input.taskId,
    // Higher temperature for a less canned tone
    temperature: 0.6,
  });

  return {
    text: result.data.draft_text.trim(),
    language: result.data.language_hint,
    confidence: result.data.confidence,
    model: result.modelUsed,
  };
}
