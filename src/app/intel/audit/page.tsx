import Link from "next/link";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type AuditFilter = {
  kind?: string;
  decision?: string;
};

type PageProps = {
  searchParams: Promise<AuditFilter>;
};

async function loadAudit(filter: AuditFilter) {
  let q = supabase
    .from("ai_actions")
    .select(
      "id, kind, conversation_id, model, decision, prompt_hash, latency_ms, cost_usd, payload, result, error, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (filter.kind) q = q.eq("kind", filter.kind);
  if (filter.decision) q = q.eq("decision", filter.decision);

  const { data } = await q;
  return data ?? [];
}

async function loadKinds(): Promise<string[]> {
  const { data } = await supabase
    .from("ai_actions")
    .select("kind")
    .order("created_at", { ascending: false })
    .limit(500);
  return Array.from(new Set((data ?? []).map((r) => r.kind))).sort();
}

const DECISION_BADGE: Record<string, string> = {
  executed: "bg-green-100 text-green-800 border-green-300",
  failed: "bg-red-100 text-red-800 border-red-300",
  proposed: "bg-blue-100 text-blue-800 border-blue-300",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-300",
  denied: "bg-zinc-100 text-zinc-600 border-zinc-300",
  skipped: "bg-zinc-100 text-zinc-500 border-zinc-300",
};

export default async function AuditPage(props: PageProps) {
  const filter = (await props.searchParams) ?? {};
  const [rows, kinds] = await Promise.all([loadAudit(filter), loadKinds()]);

  const setFilter = (k: keyof AuditFilter, v: string | undefined) => {
    const p = new URLSearchParams();
    const merged = { ...filter, [k]: v };
    for (const [key, val] of Object.entries(merged)) {
      if (val) p.set(key, String(val));
    }
    const q = p.toString();
    return q ? `/intel/audit?${q}` : "/intel/audit";
  };

  const totalCost = rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  const totalLatency = rows.reduce((sum, r) => sum + (r.latency_ms ?? 0), 0);
  const failureCount = rows.filter((r) => r.decision === "failed").length;

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-zinc-900">Audit</h2>
        <p className="text-sm text-zinc-500">
          Every AI call logged: {rows.length} shown, cost ${totalCost.toFixed(4)}, avg{" "}
          {rows.length > 0 ? Math.round(totalLatency / rows.length) : 0}ms,{" "}
          <span className={failureCount > 0 ? "text-red-700" : ""}>{failureCount} failures</span>.
        </p>
      </div>

      <div className="flex gap-4 mb-4 text-sm flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-zinc-500">Decision:</span>
          {[undefined, "executed", "failed"].map((opt) => (
            <Link
              key={opt ?? "all"}
              href={setFilter("decision", opt)}
              className={`text-xs px-2 py-1 rounded border ${
                filter.decision === opt
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-700 border-zinc-300 hover:border-zinc-500"
              }`}
            >
              {opt ?? "all"}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase text-zinc-500">Kind:</span>
          <Link
            href={setFilter("kind", undefined)}
            className={`text-xs px-2 py-1 rounded border ${
              !filter.kind
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-zinc-700 border-zinc-300 hover:border-zinc-500"
            }`}
          >
            all
          </Link>
          {kinds.map((k) => (
            <Link
              key={k}
              href={setFilter("kind", k)}
              className={`text-xs px-2 py-1 rounded border ${
                filter.kind === k
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-700 border-zinc-300 hover:border-zinc-500"
              }`}
            >
              {k}
            </Link>
          ))}
        </div>
      </div>

      {rows.length === 0 && (
        <div className="text-zinc-500 text-sm py-12 text-center">No audit entries match.</div>
      )}

      <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-zinc-50 border-b border-zinc-200">
            <tr className="text-left text-xs uppercase text-zinc-500">
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Decision</th>
              <th className="px-3 py-2 font-medium text-right">Latency</th>
              <th className="px-3 py-2 font-medium text-right">Cost</th>
              <th className="px-3 py-2 font-medium">Hash</th>
              <th className="px-3 py-2 font-medium">Preview / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-zinc-50">
                <td className="px-3 py-2 text-zinc-500 font-mono">
                  {formatTime(r.created_at)}
                </td>
                <td className="px-3 py-2 text-zinc-800 font-mono">{r.kind}</td>
                <td className="px-3 py-2 text-zinc-600">{r.model ?? "—"}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block text-xs px-2 py-0.5 rounded border ${
                      DECISION_BADGE[r.decision ?? ""] ?? "bg-zinc-100 text-zinc-600 border-zinc-300"
                    }`}
                  >
                    {r.decision ?? "—"}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-zinc-600 font-mono">
                  {r.latency_ms != null ? `${r.latency_ms}ms` : "—"}
                </td>
                <td className="px-3 py-2 text-right text-zinc-600 font-mono">
                  {r.cost_usd != null ? `$${Number(r.cost_usd).toFixed(6)}` : "—"}
                </td>
                <td className="px-3 py-2 text-zinc-400 font-mono">
                  {r.prompt_hash?.slice(0, 8) ?? "—"}
                </td>
                <td className="px-3 py-2 text-zinc-700 max-w-md truncate">
                  {r.error ? (
                    <span className="text-red-700">{r.error.slice(0, 120)}</span>
                  ) : (
                    <span className="text-zinc-500">{previewResult(r.result)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function previewResult(result: unknown): string {
  if (!result || typeof result !== "object") return "—";
  const obj = result as { data?: unknown };
  if (obj.data) return JSON.stringify(obj.data).slice(0, 120);
  return JSON.stringify(result).slice(0, 120);
}
