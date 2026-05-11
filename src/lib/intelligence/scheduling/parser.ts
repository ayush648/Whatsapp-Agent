import { z } from "zod";
import * as chrono from "chrono-node";
import { aiCall } from "@/lib/intelligence/ai/call";
import { SCHEDULE_PARSE_PROMPT } from "@/lib/intelligence/ai/prompts";

export type ParsedSchedule = {
  trigger_at: string | null; // ISO8601
  recurring_cron: string | null;
  condition: { type: "no_inbound_since"; window_hours: number } | null;
  action_text: string;
  confidence: number;
  source: "chrono" | "llm";
};

const ScheduleSchema = z.object({
  trigger_at: z.string().nullable(),
  recurring_cron: z.string().nullable(),
  condition: z
    .object({
      type: z.literal("no_inbound_since"),
      window_hours: z.number().positive(),
    })
    .nullable(),
  action_text: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const MODEL = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
const DEFAULT_TZ = "Asia/Kolkata";

export type ParseOptions = {
  text: string;
  /** TZ to interpret relative phrases in. Default IST. */
  timezone?: string;
  /** "Now" for deterministic tests. Default current time. */
  now?: Date;
  /** Conversation scope for kill-switch enforcement on the LLM call. */
  conversationId?: string;
};

export async function parseSchedule(opts: ParseOptions): Promise<ParsedSchedule> {
  const now = opts.now ?? new Date();
  const tz = opts.timezone ?? DEFAULT_TZ;

  // 1. Try chrono-node first — fast, no LLM cost, handles English well.
  const chronoResult = chrono.parse(opts.text, now, { forwardDate: true });
  if (chronoResult.length > 0) {
    const first = chronoResult[0];
    const date = first.date();
    // Action text = the input minus the date phrase. Best-effort.
    const action = opts.text.replace(first.text, "").trim().replace(/^[,\s]+|[,\s]+$/g, "");
    if (date.getTime() > now.getTime()) {
      return {
        trigger_at: date.toISOString(),
        recurring_cron: null,
        condition: null,
        action_text: action || opts.text,
        confidence: 0.85,
        source: "chrono",
      };
    }
  }

  // 2. Fall back to LLM (handles Hindi/Hinglish, conditional, recurring).
  const llm = await aiCall({
    name: "parse_schedule",
    model: MODEL,
    messages: [
      { role: "system", content: SCHEDULE_PARSE_PROMPT },
      {
        role: "user",
        content: `current_time: ${now.toISOString()}\nuser_tz: ${tz}\nraw_command: ${opts.text}`,
      },
    ],
    schema: ScheduleSchema,
    scope: opts.conversationId ? { conversationId: opts.conversationId } : {},
    temperature: 0.0,
  });

  return {
    ...llm.data,
    source: "llm",
  };
}
