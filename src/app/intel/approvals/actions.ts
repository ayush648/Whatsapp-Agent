"use server";

import { revalidatePath } from "next/cache";
import { supabase } from "@/lib/supabase";
import { sendThroughGateway } from "@/lib/intelligence/safety/gateway";

export type ActionResult =
  | { ok: true; messageId?: string }
  | { ok: false; reason: string; code?: string };

/**
 * Approve a proposed follow-up and send it through Plane C.
 * Called from the approvals page as a server action.
 */
export async function approveFollowup(followupId: string): Promise<ActionResult> {
  // 1. Load the proposal
  const { data: followup, error } = await supabase
    .from("ai_followups")
    .select("id, conversation_id, task_id, draft_text, state, attempt")
    .eq("id", followupId)
    .maybeSingle();
  if (error || !followup) {
    return { ok: false, reason: "follow-up not found" };
  }
  if (followup.state !== "proposed") {
    return { ok: false, reason: `follow-up already ${followup.state}` };
  }
  if (!followup.draft_text) {
    return { ok: false, reason: "no draft text" };
  }

  // 2. Mark approved (audit-friendly)
  const approvedAt = new Date().toISOString();
  await supabase
    .from("ai_followups")
    .update({ state: "approved", approved_at: approvedAt, approved_by: "dashboard", updated_at: approvedAt })
    .eq("id", followupId);

  // 3. Send through Plane C — only chokepoint for outbound
  const result = await sendThroughGateway({
    conversationId: followup.conversation_id,
    kind: "followup_send",
    text: followup.draft_text,
    sourceId: followup.id,
    decidedBy: "dashboard",
    modeAtTime: "suggest",
    confidence: 1.0, // human approved
  });

  if (!result.ok) {
    // Roll back state — back to proposed so user can retry or deny
    await supabase
      .from("ai_followups")
      .update({
        state: "failed",
        failure_reason: result.reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", followupId);
    revalidatePath("/intel/approvals");
    return { ok: false, reason: result.reason, code: result.code };
  }

  // 4. Mark sent
  await supabase
    .from("ai_followups")
    .update({
      state: "sent",
      sent_at: new Date().toISOString(),
      sent_message_id: result.messageId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", followupId);

  revalidatePath("/intel/approvals");
  return { ok: true, messageId: result.messageId };
}

/** Deny a proposed follow-up — never sends. */
export async function denyFollowup(followupId: string): Promise<ActionResult> {
  const { error } = await supabase
    .from("ai_followups")
    .update({
      state: "cancelled",
      approved_by: "dashboard",
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", followupId)
    .eq("state", "proposed");
  if (error) return { ok: false, reason: error.message };
  revalidatePath("/intel/approvals");
  return { ok: true };
}
