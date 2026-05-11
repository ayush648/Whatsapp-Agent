import { supabase } from "@/lib/supabase";
import { queue } from "@/lib/intelligence/queue";
import { nextSendableTime, type ConversationHours } from "@/lib/intelligence/scheduling/hours";
import { sendThroughGateway } from "@/lib/intelligence/safety/gateway";

const FIRE_JOB = "fire-reminder";

export type FireReminderJob = {
  reminderId: string;
};

export type ScheduleReminderInput = {
  conversationId: string;
  text: string;
  scheduledFor: Date;
  recurringCron?: string | null;
  condition?: { type: "no_inbound_since"; window_hours: number } | null;
  createdBy?: string;
  source?: Record<string, unknown> | null;
};

export type ScheduleReminderResult =
  | { ok: true; reminderId: string; jobId: string | null; scheduledFor: string }
  | { ok: false; reason: string };

/**
 * Schedule a reminder. Inserts the ai_reminders row + enqueues a delayed
 * pg-boss job. The handler fires the reminder when the job runs.
 */
export async function scheduleReminder(
  input: ScheduleReminderInput
): Promise<ScheduleReminderResult> {
  // Honour business hours / quiet hours when scheduling
  const settings = await loadHoursConfig(input.conversationId);
  const fireAt = nextSendableTime(input.scheduledFor, settings);

  const { data: row, error } = await supabase
    .from("ai_reminders")
    .insert({
      conversation_id: input.conversationId,
      text: input.text,
      scheduled_for: fireAt.toISOString(),
      recurring_cron: input.recurringCron ?? null,
      condition: input.condition ?? null,
      state: "pending",
      created_by: input.createdBy ?? "system",
      source: input.source ?? null,
    })
    .select("id")
    .single();
  if (error || !row) {
    return { ok: false, reason: error?.message ?? "insert failed" };
  }

  // Compute delay in seconds for pg-boss (clamp to 0 if past)
  const delaySec = Math.max(0, Math.floor((fireAt.getTime() - Date.now()) / 1000));
  const jobId = await queue.enqueue<FireReminderJob>(
    FIRE_JOB,
    { reminderId: row.id },
    { startAfter: delaySec }
  );

  return { ok: true, reminderId: row.id, jobId, scheduledFor: fireAt.toISOString() };
}

async function loadHoursConfig(conversationId: string): Promise<ConversationHours> {
  const { data } = await supabase
    .from("ai_settings")
    .select("business_hours, quiet_hours, timezone")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return {
    business_hours: (data?.business_hours as ConversationHours["business_hours"]) ?? null,
    quiet_hours: (data?.quiet_hours as ConversationHours["quiet_hours"]) ?? null,
    timezone: data?.timezone ?? "Asia/Kolkata",
  };
}

/**
 * Cancel a pending reminder. Job will still fire but handler will see
 * state='cancelled' and do nothing.
 */
export async function cancelReminder(reminderId: string): Promise<void> {
  await supabase
    .from("ai_reminders")
    .update({ state: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", reminderId)
    .eq("state", "pending");
}

// ─────────────────────────────────────────────────────────────────────────────
// Fire-handler — called by pg-boss when the scheduled time arrives.
// ─────────────────────────────────────────────────────────────────────────────

async function fireReminder(reminderId: string): Promise<void> {
  const { data: r, error } = await supabase
    .from("ai_reminders")
    .select("id, conversation_id, text, scheduled_for, condition, state, recurring_cron")
    .eq("id", reminderId)
    .maybeSingle();
  if (error || !r) {
    console.log(`[reminder] ${reminderId} not found — skipping`);
    return;
  }
  if (r.state !== "pending") {
    console.log(`[reminder] ${reminderId} state=${r.state} — skipping`);
    return;
  }

  // Condition evaluation (3.3) — if any condition fails, mark and stop
  if (r.condition) {
    const ok = await evaluateCondition(r.conversation_id, r.condition, r.scheduled_for);
    if (!ok) {
      await supabase
        .from("ai_reminders")
        .update({ state: "condition_failed", updated_at: new Date().toISOString() })
        .eq("id", r.id);
      console.log(`[reminder] ${r.id} condition_failed — counterparty already replied`);
      return;
    }
  }

  // Send through Plane C
  const result = await sendThroughGateway({
    conversationId: r.conversation_id,
    kind: "followup_send", // reminders share the followup_send rate limits + flag
    text: r.text,
    sourceId: r.id,
    decidedBy: "reminder_scheduler",
    modeAtTime: "scheduled",
    confidence: 1.0,
  });

  if (!result.ok) {
    await supabase
      .from("ai_reminders")
      .update({
        state: "failed",
        failure_reason: result.reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    return;
  }

  await supabase
    .from("ai_reminders")
    .update({
      state: "fired",
      fired_at: new Date().toISOString(),
      fired_message_id: result.messageId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", r.id);

  // If recurring, schedule the next fire via pg-boss cron is NOT how we do it
  // (one-off delayed jobs are simpler). Instead, schedule the next one-shot
  // off the cron expression and a fresh ai_reminders row.
  // For v1: leave recurring as a future enhancement — log and skip.
  if (r.recurring_cron) {
    console.log(`[reminder] ${r.id} fired; recurring (${r.recurring_cron}) re-scheduling deferred to Sprint 4+`);
  }
}

type ReminderCondition = { type: "no_inbound_since"; window_hours: number };

async function evaluateCondition(
  conversationId: string,
  condition: unknown,
  scheduledFor: string
): Promise<boolean> {
  const c = condition as ReminderCondition;
  if (c.type !== "no_inbound_since") return true; // unknown → pass through

  // "Fire only if NO inbound message since (scheduled - window_hours)"
  const since = new Date(new Date(scheduledFor).getTime() - c.window_hours * 3600_000).toISOString();
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .gte("created_at", since);
  return (count ?? 0) === 0; // no reply since window started = condition holds
}

export async function registerReminderHandler(): Promise<void> {
  await queue.register<FireReminderJob>(FIRE_JOB, async (job) => {
    await fireReminder(job.data.reminderId);
  });
}
