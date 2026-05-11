import { supabase } from "@/lib/supabase";
import { queue } from "@/lib/intelligence/queue";

const SCAN_JOB = "scan-overdue-tasks";
const CONSIDER_JOB = "consider-followup";

export type ConsiderFollowupJob = {
  taskId: string;
};

// Cron-driven scan: every 15 min, mark overdue + enqueue consider jobs.
export async function scanOverdueTasks(): Promise<{ marked: number; enqueued: number }> {
  const now = new Date().toISOString();

  // 1. Flip open → overdue for everything past due
  const { data: newlyOverdue, error: updErr } = await supabase
    .from("ai_tasks")
    .update({ status: "overdue", updated_at: now })
    .eq("status", "open")
    .not("due_at", "is", null)
    .lt("due_at", now)
    .select("id");
  if (updErr) {
    console.error("[scanner] mark-overdue update failed:", updErr.message);
  }
  const marked = newlyOverdue?.length ?? 0;

  // 2. Find all overdue tasks (newly + previously) WHERE owner=them — only their
  // promises get follow-ups. Our own pending items show up in inbox, no auto-send.
  const { data: overdue } = await supabase
    .from("ai_tasks")
    .select("id, conversation_id")
    .eq("status", "overdue")
    .eq("owner", "them")
    .order("due_at", { ascending: true })
    .limit(200);

  let enqueued = 0;
  for (const task of overdue ?? []) {
    try {
      await queue.enqueue<ConsiderFollowupJob>(CONSIDER_JOB, { taskId: task.id });
      enqueued++;
    } catch (err) {
      console.error(`[scanner] enqueue failed for task ${task.id}:`, err);
    }
  }

  console.log(`[scanner] marked ${marked} overdue, enqueued ${enqueued} consider-followup jobs`);
  return { marked, enqueued };
}

export async function registerScanner(): Promise<void> {
  // Cron: every 15 minutes
  await queue.cron(SCAN_JOB, "*/15 * * * *");
  // Register the cron handler (the cron schedule above creates the job;
  // this `register` consumes it)
  await queue.register(SCAN_JOB, async () => {
    await scanOverdueTasks();
  });
}
