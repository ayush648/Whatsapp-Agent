import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { parseStateFromNotes, type ConversationState } from "@/intelligence/state-machine";

export const dynamic = "force-dynamic";

type ConversationRow = {
  id: string;
  phone: string;
  name: string | null;
  mode: string;
  updated_at: string;
};

type RelationshipRow = {
  conversation_id: string;
  last_activity_at: string | null;
  notes: string | null;
};

type LastMessageRow = {
  conversation_id: string;
  content: string | null;
  role: string;
  created_at: string;
  ai_priority: number | null;
};

async function loadInbox() {
  const { data: convos } = await supabase
    .from("conversations")
    .select("id, phone, name, mode, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (!convos || convos.length === 0) return [];

  const ids = convos.map((c) => c.id);

  const { data: rels } = await supabase
    .from("ai_relationship_state")
    .select("conversation_id, last_activity_at, notes")
    .in("conversation_id", ids);
  const relMap = new Map((rels ?? []).map((r) => [r.conversation_id, r as RelationshipRow]));

  // For each conversation, fetch latest message in one shot (limit-per-group is
  // unwieldy in SQL; we fetch enough and group client-side).
  const { data: msgs } = await supabase
    .from("messages")
    .select("conversation_id, content, role, created_at, ai_priority")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .limit(500);
  const latestByConv = new Map<string, LastMessageRow>();
  for (const m of msgs ?? []) {
    if (!latestByConv.has(m.conversation_id)) {
      latestByConv.set(m.conversation_id, m as LastMessageRow);
    }
  }

  type Row = ConversationRow & {
    state: ConversationState | null;
    ownedByUs: number;
    ownedByThem: number;
    lastContent: string | null;
    lastRole: string | null;
    priority: number;
  };

  const rows: Row[] = convos.map((c) => {
    const rel = relMap.get(c.id);
    const s = parseStateFromNotes(rel?.notes ?? null);
    const last = latestByConv.get(c.id);
    return {
      ...(c as ConversationRow),
      state: s.state,
      ownedByUs: s.ownedByUs,
      ownedByThem: s.ownedByThem,
      lastContent: last?.content ?? null,
      lastRole: last?.role ?? null,
      priority: last?.ai_priority ?? 0,
    };
  });

  // Sort: awaiting_us first, then by priority, then by recency
  rows.sort((a, b) => {
    const rank: Record<string, number> = {
      awaiting_us: 0,
      awaiting_them: 1,
      stalled: 2,
      active: 3,
      dormant: 4,
      closed: 5,
    };
    const ra = rank[a.state ?? "active"] ?? 3;
    const rb = rank[b.state ?? "active"] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  return rows;
}

const STATE_BADGE: Record<string, string> = {
  awaiting_us: "bg-orange-100 text-orange-800 border-orange-300",
  awaiting_them: "bg-blue-100 text-blue-800 border-blue-300",
  stalled: "bg-zinc-100 text-zinc-700 border-zinc-300",
  active: "bg-green-100 text-green-800 border-green-300",
  dormant: "bg-zinc-50 text-zinc-500 border-zinc-200",
  closed: "bg-zinc-100 text-zinc-500 border-zinc-300",
};

export default async function InboxPage() {
  const rows = await loadInbox();

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-zinc-900">Inbox</h2>
        <p className="text-sm text-zinc-500">
          Sorted by what needs your attention. {rows.length} conversations.
        </p>
      </div>

      {rows.length === 0 && (
        <div className="text-zinc-500 text-sm py-12 text-center">No conversations yet.</div>
      )}

      <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 border-b border-zinc-200">
            <tr className="text-left text-xs uppercase text-zinc-500">
              <th className="px-3 py-2 font-medium">Contact</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Open</th>
              <th className="px-3 py-2 font-medium">Last message</th>
              <th className="px-3 py-2 font-medium text-right">Priority</th>
              <th className="px-3 py-2 font-medium">Activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-zinc-50">
                <td className="px-3 py-2">
                  <Link
                    href={`/`}
                    className="text-zinc-900 hover:underline font-medium"
                    title={r.phone}
                  >
                    {r.name || r.phone}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block text-xs px-2 py-0.5 rounded border ${
                      STATE_BADGE[r.state ?? ""] ?? "bg-zinc-100 text-zinc-600 border-zinc-300"
                    }`}
                  >
                    {r.state ?? "—"}
                  </span>
                </td>
                <td className="px-3 py-2 text-zinc-600 text-xs">
                  {r.ownedByUs > 0 && <span className="text-orange-700">us:{r.ownedByUs} </span>}
                  {r.ownedByThem > 0 && <span className="text-blue-700">them:{r.ownedByThem}</span>}
                  {r.ownedByUs === 0 && r.ownedByThem === 0 && <span className="text-zinc-400">—</span>}
                </td>
                <td className="px-3 py-2 text-zinc-700 max-w-md truncate">
                  <span className="text-zinc-400 mr-1">{r.lastRole === "assistant" ? "↪" : "·"}</span>
                  {r.lastContent ?? <span className="text-zinc-400 italic">—</span>}
                </td>
                <td className="px-3 py-2 text-right text-zinc-700 font-mono text-xs">
                  {r.priority || 0}
                </td>
                <td className="px-3 py-2 text-zinc-500 text-xs">
                  {timeAgo(r.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
