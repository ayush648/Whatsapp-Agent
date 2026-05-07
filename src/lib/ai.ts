import OpenAI from "openai";
import { VFASTRR_SYSTEM_PROMPT } from "@/lib/system-prompt";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export interface AIMessage {
  role: "user" | "assistant";
  content: string | null;
  media_url?: string | null;
  media_type?: string | null;
}

type OAITextPart = { type: "text"; text: string };
type OAIImagePart = { type: "image_url"; image_url: { url: string } };
type OAIPart = OAITextPart | OAIImagePart;

function toVisionContent(m: AIMessage): string | OAIPart[] {
  if (m.role === "assistant" || !m.media_url || m.media_type !== "image") {
    return m.content ?? "";
  }
  const parts: OAIPart[] = [
    { type: "text", text: m.content?.trim() || "[image attached]" },
    { type: "image_url", image_url: { url: m.media_url } },
  ];
  return parts;
}

function toTextContent(m: AIMessage): string {
  if (m.content?.trim()) return m.content;
  if (m.media_type === "image") return "[Customer sent an image]";
  if (m.media_type === "audio") return "[Customer sent a voice note]";
  if (m.media_type === "document") return "[Customer sent a document]";
  if (m.media_type) return `[Customer sent ${m.media_type}]`;
  return "";
}

const TEXT_FALLBACKS = [
  "z-ai/glm-4.5-air:free",
  "openai/gpt-oss-20b:free",
  "openai/gpt-oss-120b:free",
];

export async function getAIResponse(messages: AIMessage[]) {
  const hasImage = messages.some(
    (m) => m.role === "user" && m.media_type === "image" && m.media_url
  );
  const visionModel = process.env.AI_VISION_MODEL;
  const textModel = process.env.AI_MODEL || "anthropic/claude-3.5-sonnet";
  const useVision = hasImage && !!visionModel;

  const candidates = useVision
    ? [visionModel!]
    : [textModel, ...TEXT_FALLBACKS.filter((m) => m !== textModel)];

  const formatted = messages.map((m) => ({
    role: m.role,
    content: useVision ? toVisionContent(m) : toTextContent(m),
  }));

  let lastError: unknown = null;
  for (const model of candidates) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: VFASTRR_SYSTEM_PROMPT },
          ...formatted,
        ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      });
      const text = completion.choices[0]?.message?.content;
      if (text) {
        if (model !== candidates[0]) {
          console.warn(`AI fallback: used ${model} (primary failed)`);
        }
        return text;
      }
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number })?.status;
      console.warn(`AI model ${model} failed (status=${status}); trying next`);
      if (status && status !== 429 && status !== 404 && status !== 503) {
        break;
      }
    }
  }

  console.error("All AI models failed:", lastError);
  return "Sorry, I couldn't generate a response right now. Please try again in a moment.";
}
