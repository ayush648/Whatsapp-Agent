import { supabase } from "@/lib/supabase";
import { approveFollowup, denyFollowup } from "./actions";

export const dynamic = "force-dynamic";

type FollowupRow = {
  id: string;
  conversation_id: string;
  task_id: string | null;
  draft_text: string | null;
  language_hint: string | null;
  state: string;
  attempt: number | null;
  created_at: string;
};

type TaskRow = {
  id: string;
  description: string;
  due_at: string | null;
  confidence: number | null;
};

type ConvoRow = { id: string; phone: string; name: string | null };

async function loadApprovals() {
  const { data: followups } = await supabase
    .from("ai_followups")
    .select("id, conversation_id, task_id, draft_text, language_hint, state, attempt, created_at")
    .eq("state", "proposed")
    .order("created_at", { ascending: true })
    .limit(50);
  const rows = (followups ?? []) as FollowupRow[];
  if (rows.length === 0) return { rows: [], tasks: new Map(), convos: new Map(), recentSends: [] };

  const taskIds = rows.map((r) => r.task_id).filter(Boolean) as string[];
  const convIds = Array.from(new Set(rows.map((r) => r.conversation_id)));

  const [{ data: tasks }, { data: convos }, recentSends] = await Promise.all([
    supabase
      .from("ai_tasks")
      .select("id, description, due_at, confidence")
      .in("id", taskIds.length > 0 ? taskIds : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from("conversations").select("id, phone, name").in("id", convIds),
    loadRecentSends(),
  ]);

  return {
    rows,
    tasks: new Map((tasks ?? []).map((t) => [t.id, t as TaskRow])),
    convos: new Map((convos ?? []).map((c) => [c.id, c as ConvoRow])),
    recentSends,
  };
}

async function loadRecentSends() {
  const { data } = await supabase
    .from("ai_followups")
    .select("id, conversation_id, draft_text, language_hint, sent_at, state")
    .in("state", ["sent", "failed", "cancelled"])
    .order("updated_at", { ascending: false })
    .limit(20);
  if (!data) return [];
  const convIds = Array.from(new Set(data.map((d) => d.conversation_id)));
  const { data: convos } = await supabase
    .from("conversations")
    .select("id, phone, name")
    .in("id", convIds);
  const cmap = new Map((convos ?? []).map((c) => [c.id, c as ConvoRow]));
  return data.map((d) => ({
    ...d,
    contact: cmap.get(d.conversation_id)?.name ?? cmap.get(d.conversation_id)?.phone ?? "—",
  }));
}

export default async function ApprovalsPage() {
  const { rows, tasks, convos, recentSends } = await loadApprovals();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Pending approvals</h2>
        <p className="text-sm text-zinc-500">
          AI-drafted follow-ups awaiting your approval. Nothing sends without your click.
        </p>
      </div>

      {rows.length === 0 && (
        <div className="text-zinc-500 text-sm py-12 text-center border border-dashed border-zinc-300 rounded-lg">
          No follow-ups awaiting approval. (Worker proposes these for overdue tasks — make sure
          <code className="mx-1 px-1 bg-zinc-100 rounded">intel.followup_proposal</code> is enabled
          and at least one conversation has <code className="mx-1 px-1 bg-zinc-100 rounded">ai_settings.follow_up_enabled=true</code>.)
        </div>
      )}

      <div className="space-y-3">
        {rows.map((f) => {
          const t = f.task_id ? tasks.get(f.task_id) : null;
          const c = convos.get(f.conversation_id);
          return (
            <div key={f.id} className="bg-white border border-zinc-200 rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-zinc-900">{c?.name || c?.phone || "—"}</span>
                    <span className="text-zinc-400">·</span>
                    <span className="text-zinc-500 text-xs">
                      attempt {f.attempt ?? 1}
                    </span>
                    {f.language_hint && (
                      <>
                        <span className="text-zinc-400">·</span>
                        <span className="text-zinc-500 text-xs uppercase font-mono">{f.language_hint}</span>
                      </>
                    )}
                  </div>
                  {t && (
                    <div className="mt-1 text-xs text-zinc-500">
                      Re: <span className="text-zinc-700">{t.description}</span>
                      {t.due_at && (
                        <span className="ml-2 text-zinc-400">(was due {new Date(t.due_at).toLocaleDateString("en-IN")})</span>
                      )}
                    </div>
                  )}
                  <div className="mt-3 bg-zinc-50 border border-zinc-200 rounded-md p-3 text-sm text-zinc-900 whitespace-pre-wrap">
                    {f.draft_text}
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <form action={async () => { "use server"; await approveFollowup(f.id); }}>
                    <button
                      type="submit"
                      className="w-full px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700"
                    >
                      Approve & send
                    </button>
                  </form>
                  <form action={async () => { "use server"; await denyFollowup(f.id); }}>
                    <button
                      type="submit"
                      className="w-full px-3 py-1.5 text-sm bg-white border border-zinc-300 text-zinc-700 rounded-md hover:bg-zinc-50"
                    >
                      Deny
                    </button>
                  </form>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {recentSends.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 mb-2">Recent decisions</h3>
          <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-zinc-50 border-b border-zinc-200">
                <tr className="text-left text-xs uppercase text-zinc-500">
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2 font-medium">Text</th>
                  <th className="px-3 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {recentSends.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-50">
                    <td className="px-3 py-2 text-zinc-800">{r.contact}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block text-xs px-2 py-0.5 rounded border ${
                          r.state === "sent"
                            ? "bg-green-100 text-green-800 border-green-300"
                            : r.state === "failed"
                              ? "bg-red-100 text-red-800 border-red-300"
                              : "bg-zinc-100 text-zinc-500 border-zinc-300"
                        }`}
                      >
                        {r.state}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-zinc-700 max-w-md truncate">{r.draft_text}</td>
                    <td className="px-3 py-2 text-zinc-500">
                      {r.sent_at ? new Date(r.sent_at).toLocaleString("en-IN") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
