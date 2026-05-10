import Link from "next/link";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type TaskFilter = {
  status?: string;
  owner?: string;
  direction?: string;
};

type Awaited<T> = T extends PromiseLike<infer U> ? U : T;
type PageProps = {
  searchParams: Promise<TaskFilter>;
};

async function loadTasks(filter: TaskFilter) {
  let q = supabase
    .from("ai_tasks")
    .select(
      "id, conversation_id, source_message_id, direction, description, owner, status, due_at, detected_at, fulfilled_at, confidence, evidence_span"
    )
    .order("detected_at", { ascending: false })
    .limit(200);

  if (filter.status) q = q.eq("status", filter.status);
  if (filter.owner) q = q.eq("owner", filter.owner);
  if (filter.direction) q = q.eq("direction", filter.direction);

  const { data: tasks } = await q;
  if (!tasks || tasks.length === 0) return { tasks: [], convoMap: new Map<string, { phone: string; name: string | null }>() };

  const convIds = Array.from(new Set(tasks.map((t) => t.conversation_id)));
  const { data: convos } = await supabase
    .from("conversations")
    .select("id, phone, name")
    .in("id", convIds);
  const convoMap = new Map(
    (convos ?? []).map((c) => [c.id, { phone: c.phone, name: c.name }])
  );

  return { tasks, convoMap };
}

const STATUS_BADGE: Record<string, string> = {
  open: "bg-blue-100 text-blue-800 border-blue-300",
  overdue: "bg-red-100 text-red-800 border-red-300",
  fulfilled: "bg-green-100 text-green-800 border-green-300",
  cancelled: "bg-zinc-100 text-zinc-500 border-zinc-300",
  escalated: "bg-purple-100 text-purple-800 border-purple-300",
  needs_review: "bg-amber-100 text-amber-800 border-amber-300",
};

export default async function TasksPage(props: PageProps) {
  const filter = (await props.searchParams) ?? {};
  const { tasks, convoMap } = await loadTasks(filter);

  const setFilter = (k: keyof TaskFilter, v: string | undefined) => {
    const p = new URLSearchParams();
    const merged = { ...filter, [k]: v };
    for (const [key, val] of Object.entries(merged)) {
      if (val) p.set(key, String(val));
    }
    const q = p.toString();
    return q ? `/intel/tasks?${q}` : "/intel/tasks";
  };

  return (
    <div>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Tasks</h2>
          <p className="text-sm text-zinc-500">
            All detected promises and pending items across conversations. {tasks.length} shown.
          </p>
        </div>
      </div>

      <div className="flex gap-4 mb-4 text-sm">
        <FilterGroup label="Status" current={filter.status} field="status" link={setFilter}
          options={[undefined, "open", "overdue", "fulfilled", "cancelled", "needs_review"]} />
        <FilterGroup label="Owner" current={filter.owner} field="owner" link={setFilter}
          options={[undefined, "us", "them"]} />
        <FilterGroup label="Direction" current={filter.direction} field="direction" link={setFilter}
          options={[undefined, "inbound_promise", "outbound_promise", "question_to_us", "question_to_them"]} />
      </div>

      {tasks.length === 0 && (
        <div className="text-zinc-500 text-sm py-12 text-center">No tasks match these filters.</div>
      )}

      <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 border-b border-zinc-200">
            <tr className="text-left text-xs uppercase text-zinc-500">
              <th className="px-3 py-2 font-medium">Contact</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Due</th>
              <th className="px-3 py-2 font-medium text-right">Conf.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {tasks.map((t) => {
              const c = convoMap.get(t.conversation_id);
              return (
                <tr key={t.id} className="hover:bg-zinc-50">
                  <td className="px-3 py-2 text-zinc-900">{c?.name || c?.phone || "—"}</td>
                  <td className="px-3 py-2 text-zinc-700 max-w-md">{t.description}</td>
                  <td className="px-3 py-2 text-zinc-600 text-xs font-mono">{t.owner}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block text-xs px-2 py-0.5 rounded border ${
                        STATUS_BADGE[t.status] ?? "bg-zinc-100 text-zinc-600 border-zinc-300"
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-zinc-500 text-xs">
                    {t.due_at ? formatDue(t.due_at) : <span className="text-zinc-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-600">
                    {t.confidence != null ? Number(t.confidence).toFixed(2) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterGroup({
  label, current, field, link, options,
}: {
  label: string;
  current: string | undefined;
  field: keyof TaskFilter;
  link: (k: keyof TaskFilter, v: string | undefined) => string;
  options: Array<string | undefined>;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase text-zinc-500">{label}:</span>
      <div className="flex gap-1">
        {options.map((opt) => (
          <Link
            key={opt ?? "all"}
            href={link(field, opt)}
            className={`text-xs px-2 py-1 rounded border ${
              current === opt
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-zinc-700 border-zinc-300 hover:border-zinc-500"
            }`}
          >
            {opt ?? "all"}
          </Link>
        ))}
      </div>
    </div>
  );
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const ms = d.getTime() - now;
  const abs = Math.abs(ms);
  const day = 86400_000;
  const hr = 3600_000;
  if (abs < hr) return ms < 0 ? "overdue (min)" : "<1h";
  if (abs < day) {
    const h = Math.floor(abs / hr);
    return ms < 0 ? `${h}h overdue` : `in ${h}h`;
  }
  const dDays = Math.floor(abs / day);
  return ms < 0 ? `${dDays}d overdue` : `in ${dDays}d`;
}
