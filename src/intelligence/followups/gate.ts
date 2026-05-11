import { supabase } from "@/lib/supabase";
import { flags } from "@/lib/intelligence/flags";
import { killSwitch } from "@/lib/intelligence/safety/kill-switch";

export type GateInput = {
  conversationId: string;
  taskId: string;
  taskDetectedAt: Date;
};

export type GateResult =
  | { proceed: true; mode: string; attempt: number; settings: Settings }
  | { proceed: false; reason: string };

type Settings = {
  mode: string;
  cooldown_hours: number;
  max_followups_per_week: number;
  business_hours: BusinessHours | null;
  quiet_hours: QuietHours | null;
  timezone: string;
  follow_up_enabled: boolean;
};

type BusinessHours = Record<
  string, // e.g. 'mon','tue',...
  { start: string; end: string } | null
>;

type QuietHours = { start: string; end: string } | null;

const DEFAULT_SETTINGS: Settings = {
  mode: "observe",
  cooldown_hours: 12,
  max_followups_per_week: 3,
  business_hours: null,
  quiet_hours: null,
  timezone: "Asia/Kolkata",
  follow_up_enabled: false,
};

export async function gateFollowup(input: GateInput, now = new Date()): Promise<GateResult> {
  const scope = { conversationId: input.conversationId };

  // 1. Kill switch
  if (await killSwitch.isKilled(scope)) {
    return { proceed: false, reason: "kill switch tripped" };
  }

  // 2. Master flag for follow-up consideration (separate from sending — this
  // gates even PROPOSING a follow-up in observe mode)
  if (!(await flags.isEnabled("intel.followup_proposal", scope))) {
    return { proceed: false, reason: "intel.followup_proposal disabled" };
  }

  // 3. Per-conversation settings (mode, hours, caps)
  const settings = await loadSettings(input.conversationId);
  if (!settings.follow_up_enabled) {
    return { proceed: false, reason: "follow_up_enabled=false on this conversation" };
  }
  if (settings.mode === "observe") {
    // observe doesn't propose follow-ups. Sprint 0 default mode.
    return { proceed: false, reason: "conversation mode=observe" };
  }

  // 4. Cooldown — no AI-sent outbound in the last N hours
  const cooldownCutoff = new Date(now.getTime() - settings.cooldown_hours * 3600_000).toISOString();
  const { count: recentOutbound } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", input.conversationId)
    .eq("sent_by_ai", true)
    .gte("created_at", cooldownCutoff);
  if ((recentOutbound ?? 0) > 0) {
    return { proceed: false, reason: `cooldown — AI sent within last ${settings.cooldown_hours}h` };
  }

  // 5. Weekly rate cap
  const weekCutoff = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const { count: weeklyCount } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", input.conversationId)
    .eq("sent_by_ai", true)
    .gte("created_at", weekCutoff);
  if ((weeklyCount ?? 0) >= settings.max_followups_per_week) {
    return {
      proceed: false,
      reason: `weekly cap reached (${weeklyCount}/${settings.max_followups_per_week})`,
    };
  }

  // 6. Quiet hours
  if (isQuietHour(settings, now)) {
    return { proceed: false, reason: "currently in quiet hours" };
  }

  // 7. Business hours (if configured) — only send within business window
  if (settings.business_hours && !isWithinBusinessHours(settings, now)) {
    return { proceed: false, reason: "outside business hours" };
  }

  // 8. Attempt number — count prior proposed/sent follow-ups for THIS task
  const { count: attempts } = await supabase
    .from("ai_followups")
    .select("id", { count: "exact", head: true })
    .eq("task_id", input.taskId)
    .in("state", ["proposed", "approved", "sent"]);

  const attemptNumber = (attempts ?? 0) + 1;
  if (attemptNumber > 3) {
    return { proceed: false, reason: "max 3 attempts per task reached — escalation needed" };
  }

  return { proceed: true, mode: settings.mode, attempt: attemptNumber, settings };
}

async function loadSettings(conversationId: string): Promise<Settings> {
  const { data } = await supabase
    .from("ai_settings")
    .select(
      "mode, cooldown_hours, max_followups_per_week, business_hours, quiet_hours, timezone, follow_up_enabled"
    )
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...data,
    business_hours: (data.business_hours as BusinessHours | null) ?? null,
    quiet_hours: (data.quiet_hours as QuietHours) ?? null,
  };
}

// Hours are stored as 'HH:MM' strings interpreted in the conversation's TZ.
// Naive parser — works for IST-style usage. Cross-midnight quiet hours
// (e.g. 21:00 → 08:00) are supported.
function isQuietHour(settings: Settings, now: Date): boolean {
  const q = settings.quiet_hours;
  if (!q) return false;
  const local = toLocalHHMM(now, settings.timezone);
  return inRangeHHMM(local, q.start, q.end);
}

function isWithinBusinessHours(settings: Settings, now: Date): boolean {
  const bh = settings.business_hours;
  if (!bh) return true;
  const localTime = toLocalHHMM(now, settings.timezone);
  const dayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
    new Date(now.toLocaleString("en-US", { timeZone: settings.timezone })).getDay()
  ];
  const window = bh[dayKey];
  if (!window) return false;
  return inRangeHHMM(localTime, window.start, window.end);
}

function toLocalHHMM(date: Date, tz: string): string {
  return date.toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function inRangeHHMM(now: string, start: string, end: string): boolean {
  if (start <= end) return now >= start && now < end;
  // Crosses midnight: e.g. 21:00 → 08:00
  return now >= start || now < end;
}
