import { supabase } from "@/lib/supabase";
import { killSwitch } from "./kill-switch";
import { flags } from "../flags";
import { sendWhatsAppMessage } from "@/lib/whatsapp";

export type OutboundAction = {
  conversationId: string;
  kind: "followup_send" | "manual_send" | "escalation";
  text: string;
  /** UUID of the proposing artefact (e.g. ai_followups.id). Used for dedup. */
  sourceId?: string;
  /** For audit attribution. */
  decidedBy?: string;
  /** What mode was in effect when this was proposed. */
  modeAtTime?: string;
  /** Confidence the action is correct. Compared against mode floor. */
  confidence?: number;
};

export type GatewayResult =
  | { ok: true; messageId: string; whatsappMsgId: string | null }
  | { ok: false; reason: string; code: GatewayBlockCode };

export type GatewayBlockCode =
  | "kill_switch"
  | "feature_disabled"
  | "duplicate"
  | "rate_limit"
  | "low_confidence"
  | "phone_missing"
  | "send_failed";

const RATE_WINDOW_MS = 7 * 24 * 3600_000; // 7 days
const DUPLICATE_WINDOW_MS = 30 * 60_000; // 30 minutes

// Confidence floor by mode. assertNotKilled() handles the kill switch; this
// table is just for confidence requirements.
const MODE_CONFIDENCE_FLOOR: Record<string, number> = {
  observe: 999, // never sends in observe — caller must check separately
  suggest: 0.0, // human approves, so any confidence is OK to propose
  assisted: 0.85,
  autonomous: 0.95,
};

/**
 * The Plane C chokepoint. Every AI-driven outbound goes through here.
 * Returns immediately if anything is wrong; otherwise sends and logs.
 */
export async function sendThroughGateway(action: OutboundAction): Promise<GatewayResult> {
  const scope = { conversationId: action.conversationId };
  const correlationId = action.sourceId ?? null;

  // 1. Kill switch (5s cache — fastest check, fail-closed)
  if (await killSwitch.isKilled(scope)) {
    await audit("denied", action, correlationId, "kill_switch", "kill switch tripped");
    return { ok: false, reason: "kill switch tripped", code: "kill_switch" };
  }

  // 2. Master feature gate for this kind
  const featureKey =
    action.kind === "followup_send"
      ? "intel.followup_sending"
      : action.kind === "escalation"
        ? "intel.escalation_sending"
        : "intel.manual_send";
  if (!(await flags.isEnabled(featureKey, scope))) {
    await audit("denied", action, correlationId, "feature_disabled", `${featureKey} disabled`);
    return { ok: false, reason: `feature ${featureKey} disabled`, code: "feature_disabled" };
  }

  // 3. Confidence vs mode floor
  if (action.confidence != null && action.modeAtTime) {
    const floor = MODE_CONFIDENCE_FLOOR[action.modeAtTime];
    if (floor != null && action.confidence < floor) {
      await audit("denied", action, correlationId, "low_confidence",
        `confidence ${action.confidence} below mode '${action.modeAtTime}' floor ${floor}`);
      return { ok: false, reason: "confidence below mode floor", code: "low_confidence" };
    }
  }

  // 4. Duplicate check — same text to same conversation within 30 min
  if (await isDuplicate(action)) {
    await audit("denied", action, correlationId, "duplicate", "same text sent recently");
    return { ok: false, reason: "duplicate send blocked", code: "duplicate" };
  }

  // 5. Rate limit — per-conversation per-week
  const rateLimitHit = await checkRateLimit(action.conversationId);
  if (rateLimitHit) {
    await audit("denied", action, correlationId, "rate_limit",
      `per-week rate limit: ${rateLimitHit.sent}/${rateLimitHit.cap}`);
    return { ok: false, reason: `rate limit ${rateLimitHit.sent}/${rateLimitHit.cap}`, code: "rate_limit" };
  }

  // 6. Look up phone number
  const { data: conv } = await supabase
    .from("conversations")
    .select("phone")
    .eq("id", action.conversationId)
    .maybeSingle();
  if (!conv?.phone) {
    await audit("failed", action, correlationId, "phone_missing", "no phone for conversation");
    return { ok: false, reason: "conversation has no phone", code: "phone_missing" };
  }

  // 7. Send. After this point, side effect is live.
  let sendResult;
  try {
    sendResult = await sendWhatsAppMessage(conv.phone, action.text);
  } catch (err) {
    await audit("failed", action, correlationId, "send_failed", errMsg(err));
    return { ok: false, reason: errMsg(err), code: "send_failed" };
  }

  const whatsappMsgId: string | null = sendResult?.messages?.[0]?.id ?? null;

  // 8. Mirror into messages table so the existing dashboard sees it
  const { data: inserted, error: insertErr } = await supabase
    .from("messages")
    .insert({
      conversation_id: action.conversationId,
      role: "assistant",
      content: action.text,
      whatsapp_msg_id: whatsappMsgId,
      status: whatsappMsgId ? "sent" : null,
      sent_by_ai: true,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    // The WhatsApp send succeeded but our DB insert failed — log loudly.
    console.error("[gateway] sent to WhatsApp but failed to mirror to messages:", insertErr?.message);
    await audit("failed", action, correlationId, "send_failed",
      `WhatsApp sent (${whatsappMsgId}) but DB mirror failed: ${insertErr?.message}`);
    return { ok: false, reason: "DB mirror failed after WhatsApp send", code: "send_failed" };
  }

  // 9. Bump conversation timestamp (matches webhook pattern)
  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", action.conversationId);

  // 10. Audit: executed
  await audit("executed", action, correlationId, undefined,
    `sent message ${inserted.id} (whatsapp_id=${whatsappMsgId ?? 'unknown'})`);

  return { ok: true, messageId: inserted.id, whatsappMsgId };
}

async function isDuplicate(action: OutboundAction): Promise<boolean> {
  const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", action.conversationId)
    .eq("role", "assistant")
    .eq("sent_by_ai", true)
    .eq("content", action.text)
    .gte("created_at", cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function checkRateLimit(
  conversationId: string
): Promise<{ sent: number; cap: number } | null> {
  // Get the cap from ai_settings (defaults to 3)
  const { data: settings } = await supabase
    .from("ai_settings")
    .select("max_followups_per_week")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  const cap = settings?.max_followups_per_week ?? 3;

  // Count AI-sent messages in the last 7 days
  const cutoff = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("sent_by_ai", true)
    .gte("created_at", cutoff);
  const sent = count ?? 0;

  return sent >= cap ? { sent, cap } : null;
}

async function audit(
  decision: "executed" | "denied" | "failed",
  action: OutboundAction,
  correlationId: string | null,
  blockCode?: GatewayBlockCode,
  reason?: string
): Promise<void> {
  try {
    await supabase.from("ai_actions").insert({
      kind: action.kind,
      conversation_id: action.conversationId,
      correlation_id: correlationId,
      decision,
      decided_by: action.decidedBy ?? "system",
      mode_at_time: action.modeAtTime ?? null,
      confidence: action.confidence ?? null,
      payload: {
        text_preview: action.text.slice(0, 200),
        text_length: action.text.length,
        block_code: blockCode ?? null,
        source_id: action.sourceId ?? null,
      },
      error: decision === "failed" ? reason ?? null : null,
      result: decision === "executed" ? { sent: true, reason: reason ?? null } : null,
      executed_at: decision === "executed" ? new Date().toISOString() : null,
    });
  } catch (err) {
    console.error("[gateway] audit write failed:", err);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
