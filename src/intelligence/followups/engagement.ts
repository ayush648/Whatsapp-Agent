import { supabase } from "@/lib/supabase";

export type Engagement = "pending" | "engaged" | "ignored";

const PENDING_WINDOW_MS = 24 * 3600_000; // 24h cutoff before "ignored"

// Given a sent follow-up, did the counterparty reply since?
//
// pending  → less than 24h since send, no reply yet
// engaged  → counterparty replied after the send
// ignored  → 24h+ passed with no reply
//
// Computed on read — no scheduled job needed for v1. Sprint 3+ may add a
// scheduled engagement-check that escalates after N hours of silence.
export async function computeEngagement(
  conversationId: string,
  sentAt: string | null,
  now = new Date()
): Promise<Engagement> {
  if (!sentAt) return "pending";

  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .gt("created_at", sentAt);

  if ((count ?? 0) > 0) return "engaged";

  const age = now.getTime() - new Date(sentAt).getTime();
  return age > PENDING_WINDOW_MS ? "ignored" : "pending";
}

// Batch version — given N sent follow-ups, fetch all replies in one query
// and compute engagement per-row. Used by dashboard.
export async function computeEngagementBatch(
  rows: Array<{ conversation_id: string; sent_at: string | null }>,
  now = new Date()
): Promise<Engagement[]> {
  const indexed = rows.map((r, i) => ({ ...r, i }));
  const result: Engagement[] = new Array(rows.length).fill("pending");

  const withSent = indexed.filter((r) => r.sent_at);
  if (withSent.length === 0) return result;

  // One query to find inbound messages relevant to any of these followups.
  // For simplicity per-followup: not optimised. v1 fine; revisit at 1000+ rows.
  for (const r of withSent) {
    result[r.i] = await computeEngagement(r.conversation_id, r.sent_at, now);
  }
  return result;
}
