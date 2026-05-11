"use server";

import { revalidatePath } from "next/cache";
import { supabase } from "@/lib/supabase";

export type SaveSettingsInput = {
  conversationId: string;
  mode: "observe" | "suggest" | "assisted" | "autonomous";
  follow_up_enabled: boolean;
  cooldown_hours: number;
  max_followups_per_week: number;
  timezone: string;
  business_hours_json: string; // raw JSON; parsed here
  quiet_hours_json: string;
};

export type SaveResult = { ok: true } | { ok: false; reason: string };

export async function saveSettings(input: SaveSettingsInput): Promise<SaveResult> {
  let businessHours: unknown = null;
  let quietHours: unknown = null;
  try {
    if (input.business_hours_json.trim()) {
      businessHours = JSON.parse(input.business_hours_json);
    }
  } catch {
    return { ok: false, reason: "business_hours_json is not valid JSON" };
  }
  try {
    if (input.quiet_hours_json.trim()) {
      quietHours = JSON.parse(input.quiet_hours_json);
    }
  } catch {
    return { ok: false, reason: "quiet_hours_json is not valid JSON" };
  }

  const { error } = await supabase.from("ai_settings").upsert(
    {
      conversation_id: input.conversationId,
      mode: input.mode,
      follow_up_enabled: input.follow_up_enabled,
      cooldown_hours: Math.max(0, input.cooldown_hours),
      max_followups_per_week: Math.max(0, input.max_followups_per_week),
      timezone: input.timezone,
      business_hours: businessHours,
      quiet_hours: quietHours,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id" }
  );
  if (error) return { ok: false, reason: error.message };

  revalidatePath("/intel/settings");
  return { ok: true };
}
