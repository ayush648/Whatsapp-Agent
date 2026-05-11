import { supabase } from "@/lib/supabase";
import { queue } from "@/lib/intelligence/queue";
import { gateFollowup } from "./gate";
import { draftFollowup } from "./drafter";
import type { ConsiderFollowupJob } from "./scanner";

const CONSIDER_JOB = "consider-followup";

// For each overdue task, decide whether to propose a follow-up. If gate
// approves, draft and insert ai_followups (state='proposed'). Human approves
// via dashboard. Nothing is sent here — that happens through Plane C after
// approval.
async function considerFollowup(taskId: string): Promise<void> {
  const { data: task, error } = await supabase
    .from("ai_tasks")
    .select(
      "id, conversation_id, description, owner, status, due_at, detected_at, source_message_id, confidence"
    )
    .eq("id", taskId)
    .maybeSingle();
  if (error || !task) {
    console.log(`[followup] task ${taskId} not found — skipping`);
    return;
  }

  // Sanity: task might have been fulfilled or cancelled between scan and now
  if (task.status !== "overdue") {
    console.log(`[followup] task ${taskId} no longer overdue (now '${task.status}') — skipping`);
    return;
  }
  if (task.owner !== "them") return;

  // 1. Gate
  const gate = await gateFollowup({
    conversationId: task.conversation_id,
    taskId: task.id,
    taskDetectedAt: new Date(task.detected_at),
  });
  if (!gate.proceed) {
    console.log(`[followup] task ${taskId} gate blocked: ${gate.reason}`);
    return;
  }

  // 2. Pull the original source message text for context (best-effort)
  let sourceText: string | null = null;
  if (task.source_message_id) {
    const { data: sourceMsg } = await supabase
      .from("messages")
      .select("content")
      .eq("id", task.source_message_id)
      .maybeSingle();
    sourceText = sourceMsg?.content ?? null;
  }

  // 3. Draft (LLM call)
  let draft;
  try {
    draft = await draftFollowup({
      conversationId: task.conversation_id,
      taskId: task.id,
      taskDescription: task.description,
      sourceMessageText: sourceText,
      attemptNumber: gate.attempt,
    });
  } catch (err) {
    console.error(`[followup] draft failed for task ${taskId}:`, err);
    return;
  }

  // 4. Insert as proposed. Human approves via /intel/approvals.
  // scheduled_for=now means "ready immediately"; Sprint 3 reminders can set future times.
  const { error: insertErr } = await supabase.from("ai_followups").insert({
    conversation_id: task.conversation_id,
    task_id: task.id,
    scheduled_for: new Date().toISOString(),
    state: "proposed",
    draft_text: draft.text,
    language_hint: draft.language,
    attempt: gate.attempt,
  });
  if (insertErr) {
    console.error(`[followup] insert ai_followups failed:`, insertErr.message);
  } else {
    console.log(
      `[followup] proposed follow-up for task ${taskId} (attempt ${gate.attempt}, conf ${draft.confidence}): "${draft.text.slice(0, 80)}"`
    );
  }
}

export async function registerFollowupHandler(): Promise<void> {
  await queue.register<ConsiderFollowupJob>(CONSIDER_JOB, async (job) => {
    await considerFollowup(job.data.taskId);
  });
}
