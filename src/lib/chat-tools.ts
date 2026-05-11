// Tools exposed to the webhook's chat AI. When the user asks for something
// actionable ("remind me in 10 min"), the AI calls a tool here instead of
// replying it can't do it. The tool talks to the intelligence layer.
//
// To add a tool: register its spec in CHAT_TOOLS and add a case to dispatchTool.

import { parseSchedule } from "@/lib/intelligence/scheduling/parser";
import { scheduleReminder } from "@/intelligence/reminders/scheduler";

export const CHAT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "set_reminder",
      description:
        "Schedule a reminder for this WhatsApp conversation. Use this whenever the user asks to be reminded about something at a specific time or after a delay. Examples: 'remind me in 10 minutes', 'kal 4 baje yaad dilana', 'tomorrow at 5pm message me about payment'. Do NOT use for tasks the user wants someone else to do — only for self-reminders / scheduled pings.",
      parameters: {
        type: "object",
        properties: {
          when: {
            type: "string",
            description:
              "Natural-language time expression in the user's language. Examples: 'in 10 minutes', 'tomorrow at 4pm', 'kal subah', '2 din baad', 'next Monday 10am'.",
          },
          message: {
            type: "string",
            description:
              "The reminder text that will be sent on WhatsApp at the scheduled time. Keep it short and natural. Match the user's language.",
          },
        },
        required: ["when", "message"],
      },
    },
  },
];

export type ToolContext = { conversationId: string };

export type ToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  if (name === "set_reminder") {
    return setReminderTool(rawArgs, ctx);
  }
  return { ok: false, error: `Unknown tool: ${name}` };
}

async function setReminderTool(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = rawArgs as { when?: string; message?: string };
  if (!args.when || !args.message) {
    return { ok: false, error: "Both 'when' and 'message' are required." };
  }
  try {
    const parsed = await parseSchedule({
      text: args.when,
      conversationId: ctx.conversationId,
    });
    if (!parsed.trigger_at) {
      return {
        ok: false,
        error: `Couldn't parse a time from "${args.when}". Try a concrete time like 'in 30 minutes', 'tomorrow at 4pm', or 'kal sham 5 baje'.`,
      };
    }

    const result = await scheduleReminder({
      conversationId: ctx.conversationId,
      text: args.message,
      scheduledFor: new Date(parsed.trigger_at),
      createdBy: "chat",
      source: {
        command: args.when,
        parser_source: parsed.source,
        parser_confidence: parsed.confidence,
      },
    });
    if (!result.ok) return { ok: false, error: result.reason };

    return {
      ok: true,
      data: {
        reminder_id: result.reminderId,
        scheduled_for_iso: result.scheduledFor,
        scheduled_for_local: new Date(result.scheduledFor).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "short",
        }),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
