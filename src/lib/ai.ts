import OpenAI from "openai";
import { VFASTRR_SYSTEM_PROMPT } from "@/lib/system-prompt";
import { CHAT_TOOLS, dispatchTool } from "@/lib/chat-tools";

let _openai: OpenAI | null = null;
function openaiClient(): OpenAI {
  if (!_openai) {
    const openaiKey = process.env.OPENAI_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (openaiKey) {
      _openai = new OpenAI({ apiKey: openaiKey });
    } else if (openrouterKey) {
      _openai = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: openrouterKey,
      });
    } else {
      throw new Error("Set OPENAI_API_KEY or OPENROUTER_API_KEY");
    }
  }
  return _openai;
}

function isDirectOpenAI() {
  return !!process.env.OPENAI_API_KEY;
}

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

const OPENROUTER_FALLBACKS = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "anthropic/claude-haiku-4.5",
];

const OPENAI_FALLBACKS = ["gpt-4o-mini", "gpt-4o"];

export type AIResponseOptions = {
  /** When provided, the AI gets access to tools (set_reminder etc.) scoped to this conversation. */
  conversationId?: string;
};

export async function getAIResponse(
  messages: AIMessage[],
  opts: AIResponseOptions = {}
) {
  const direct = isDirectOpenAI();
  const hasImage = messages.some(
    (m) => m.role === "user" && m.media_type === "image" && m.media_url
  );
  const visionModel = process.env.AI_VISION_MODEL;
  const defaultModel = direct ? "gpt-4o-mini" : "openai/gpt-4o-mini";
  const textModel = process.env.AI_MODEL || defaultModel;
  const useVision = hasImage && !!visionModel;
  const fallbacks = direct ? OPENAI_FALLBACKS : OPENROUTER_FALLBACKS;

  const candidates = useVision
    ? [visionModel!]
    : [textModel, ...fallbacks.filter((m) => m !== textModel)];

  const formatted = messages.map((m) => ({
    role: m.role,
    content: useVision ? toVisionContent(m) : toTextContent(m),
  }));

  // Tools enabled only when the caller provides a conversationId AND we're not
  // routing image input (vision models may not support tools).
  const toolsEnabled = !!opts.conversationId && !useVision;

  let lastError: unknown = null;
  for (const model of candidates) {
    try {
      const baseMessages = [
        { role: "system", content: VFASTRR_SYSTEM_PROMPT },
        ...formatted,
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];

      const completion = await openaiClient().chat.completions.create({
        model,
        messages: baseMessages,
        tools: toolsEnabled ? CHAT_TOOLS : undefined,
      });
      const message = completion.choices[0]?.message;

      // Tool-call path: execute the calls, append results, second completion to get final text.
      if (toolsEnabled && message?.tool_calls && message.tool_calls.length > 0) {
        const toolRunMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          // The assistant turn that requested the tools (must be included verbatim)
          message as OpenAI.Chat.Completions.ChatCompletionMessageParam,
        ];
        for (const call of message.tool_calls) {
          if (call.type !== "function") continue;
          let parsedArgs: unknown = {};
          try {
            parsedArgs = JSON.parse(call.function.arguments || "{}");
          } catch {
            // ignore — handler will report missing args
          }
          const result = await dispatchTool(call.function.name, parsedArgs, {
            conversationId: opts.conversationId!,
          });
          toolRunMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }

        const second = await openaiClient().chat.completions.create({
          model,
          messages: [...baseMessages, ...toolRunMessages],
        });
        const finalText = second.choices[0]?.message?.content;
        if (finalText) {
          if (model !== candidates[0]) {
            console.warn(`AI fallback: used ${model} (primary failed)`);
          }
          return finalText;
        }
        // If second call gave no content, fall through to try next model.
        continue;
      }

      if (message?.content) {
        if (model !== candidates[0]) {
          console.warn(`AI fallback: used ${model} (primary failed)`);
        }
        return message.content;
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
