// Shared timezone + business-hours utilities. Used by both the follow-up gate
// (to block sends outside hours) and the reminder scheduler (to shift fires
// into the next valid window).

export type BusinessHoursConfig = Record<
  string, // 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
  { start: string; end: string } | null
> | null;

export type QuietHoursConfig = { start: string; end: string } | null;

export type ConversationHours = {
  business_hours: BusinessHoursConfig;
  quiet_hours: QuietHoursConfig;
  timezone: string;
};

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function isQuietHour(cfg: ConversationHours, now: Date): boolean {
  const q = cfg.quiet_hours;
  if (!q) return false;
  return inHHMMRange(toLocalHHMM(now, cfg.timezone), q.start, q.end);
}

export function isWithinBusinessHours(cfg: ConversationHours, now: Date): boolean {
  const bh = cfg.business_hours;
  if (!bh) return true; // not configured = always OK
  const day = DAYS[localDayIndex(now, cfg.timezone)];
  const win = bh[day];
  if (!win) return false;
  return inHHMMRange(toLocalHHMM(now, cfg.timezone), win.start, win.end);
}

/**
 * Given a desired fire time, return the earliest valid time that:
 *   - is NOT inside quiet_hours
 *   - IS inside business_hours (if configured)
 *   - is >= the desired time
 *
 * Returns the original time if already valid. Searches up to 7 days ahead
 * (defensive bound).
 */
export function nextSendableTime(desired: Date, cfg: ConversationHours): Date {
  const STEP_MIN = 15;
  const MAX_STEPS = (7 * 24 * 60) / STEP_MIN;

  let candidate = new Date(desired);
  for (let i = 0; i < MAX_STEPS; i++) {
    const okBusiness = isWithinBusinessHours(cfg, candidate);
    const okQuiet = !isQuietHour(cfg, candidate);
    if (okBusiness && okQuiet) return candidate;
    candidate = new Date(candidate.getTime() + STEP_MIN * 60_000);
  }
  // Fallback: return original. Better to send than to silently lose.
  console.warn("[hours] could not find sendable window within 7 days; returning desired time");
  return desired;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

export function toLocalHHMM(date: Date, tz: string): string {
  return date.toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function localDayIndex(date: Date, tz: string): number {
  // toLocaleString returns the date in the TZ; new Date() reparses in local;
  // .getDay() then gives the right weekday because day arithmetic doesn't
  // depend on time-of-day across most TZ boundaries.
  return new Date(date.toLocaleString("en-US", { timeZone: tz })).getDay();
}

function inHHMMRange(now: string, start: string, end: string): boolean {
  if (start <= end) return now >= start && now < end;
  // Crosses midnight (e.g. 21:00 → 08:00)
  return now >= start || now < end;
}
