import { supabase } from "@/lib/supabase";

export type ConversationState =
  | "active"
  | "awaiting_us"
  | "awaiting_them"
  | "stalled"
  | "dormant"
  | "closed";

export type StateInputs = {
  lastActivityAt: Date | null;
  openTasksOwnedByUs: number;
  openTasksOwnedByThem: number;
  manuallyClosed?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
};

const ACTIVE_WINDOW_MS = 24 * 3600_000;        // 24h
const DORMANT_WINDOW_MS = 30 * 24 * 3600_000;  // 30 days

// Pure function — same inputs always produce same state.
// Both processor (writes) and dashboard (reads) call this.
export function computeState(input: StateInputs): ConversationState {
  if (input.manuallyClosed) return "closed";
  if (!input.lastActivityAt) return "dormant";

  const now = (input.now ?? new Date()).getTime();
  const lastMs = input.lastActivityAt.getTime();
  const ageMs = now - lastMs;

  if (ageMs > DORMANT_WINDOW_MS) return "dormant";

  // Awaiting US dominates: we have unresolved work to do
  if (input.openTasksOwnedByUs > 0 && ageMs <= ACTIVE_WINDOW_MS) return "awaiting_us";
  // Then awaiting THEM
  if (input.openTasksOwnedByThem > 0 && ageMs <= ACTIVE_WINDOW_MS) return "awaiting_them";

  // Activity is recent but no open items
  if (ageMs <= ACTIVE_WINDOW_MS) return "active";

  // Older than 24h, less than 30 days → stalled if any open items, else active-quiet
  if (input.openTasksOwnedByUs > 0 || input.openTasksOwnedByThem > 0) return "stalled";
  return "active";
}

// Refresh the rollup row for a conversation. Called by the processor after
// every message. Idempotent — uses upsert by primary key.
export async function updateConversationState(conversationId: string): Promise<void> {
  // 1. Last activity = latest message created_at
  const { data: lastMsg } = await supabase
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastActivityAt = lastMsg?.created_at ?? null;

  // 2. Count open tasks by owner
  const { data: openTasks } = await supabase
    .from("ai_tasks")
    .select("owner")
    .eq("conversation_id", conversationId)
    .in("status", ["open", "overdue"]);

  const ownedByUs = openTasks?.filter((t) => t.owner === "us").length ?? 0;
  const ownedByThem = openTasks?.filter((t) => t.owner === "them").length ?? 0;

  const state = computeState({
    lastActivityAt: lastActivityAt ? new Date(lastActivityAt) : null,
    openTasksOwnedByUs: ownedByUs,
    openTasksOwnedByThem: ownedByThem,
  });

  // Persist rollup. State is stored inside `notes` as JSON for now —
  // adding a dedicated column can wait until dashboards prove the schema.
  const notes = JSON.stringify({ state, ownedByUs, ownedByThem, computedAt: new Date().toISOString() });

  const { error } = await supabase
    .from("ai_relationship_state")
    .upsert(
      {
        conversation_id: conversationId,
        last_activity_at: lastActivityAt,
        notes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "conversation_id" }
    );
  if (error) console.error("[state-machine] upsert failed:", error.message);
}

// Helper for dashboards: parse the JSON-encoded state out of notes.
export function parseStateFromNotes(notes: string | null): {
  state: ConversationState | null;
  ownedByUs: number;
  ownedByThem: number;
} {
  if (!notes) return { state: null, ownedByUs: 0, ownedByThem: 0 };
  try {
    const j = JSON.parse(notes);
    return {
      state: (j.state as ConversationState) ?? null,
      ownedByUs: Number(j.ownedByUs ?? 0),
      ownedByThem: Number(j.ownedByThem ?? 0),
    };
  } catch {
    return { state: null, ownedByUs: 0, ownedByThem: 0 };
  }
}
