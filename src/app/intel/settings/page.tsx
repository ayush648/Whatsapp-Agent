import { supabase } from "@/lib/supabase";
import { saveSettings } from "./actions";

export const dynamic = "force-dynamic";

type ConvoRow = { id: string; phone: string; name: string | null };
type SettingsRow = {
  conversation_id: string;
  mode: string;
  follow_up_enabled: boolean;
  cooldown_hours: number | null;
  max_followups_per_week: number | null;
  timezone: string | null;
  business_hours: unknown;
  quiet_hours: unknown;
};

const DEFAULTS = {
  mode: "observe" as const,
  follow_up_enabled: false,
  cooldown_hours: 12,
  max_followups_per_week: 3,
  timezone: "Asia/Kolkata",
};

async function loadAll() {
  const [{ data: convos }, { data: settings }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, phone, name")
      .order("updated_at", { ascending: false })
      .limit(100),
    supabase.from("ai_settings").select("*"),
  ]);

  const sMap = new Map(
    (settings ?? []).map((s) => [s.conversation_id, s as SettingsRow])
  );

  return (convos ?? []).map((c) => {
    const s = sMap.get(c.id);
    return {
      ...(c as ConvoRow),
      mode: s?.mode ?? DEFAULTS.mode,
      follow_up_enabled: s?.follow_up_enabled ?? DEFAULTS.follow_up_enabled,
      cooldown_hours: s?.cooldown_hours ?? DEFAULTS.cooldown_hours,
      max_followups_per_week: s?.max_followups_per_week ?? DEFAULTS.max_followups_per_week,
      timezone: s?.timezone ?? DEFAULTS.timezone,
      business_hours_json: s?.business_hours ? JSON.stringify(s.business_hours, null, 0) : "",
      quiet_hours_json: s?.quiet_hours ? JSON.stringify(s.quiet_hours, null, 0) : "",
    };
  });
}

const MODES = ["observe", "suggest", "assisted", "autonomous"] as const;

export default async function SettingsPage() {
  const rows = await loadAll();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Settings</h2>
        <p className="text-sm text-zinc-500">
          Per-conversation config. Mode controls who acts: observe (AI watches only), suggest
          (human approves drafts), assisted (auto-send if confident), autonomous (full auto).
        </p>
        <p className="text-xs text-zinc-400 mt-1">
          Business hours JSON example:{" "}
          <code className="px-1 bg-zinc-100 rounded">
            {`{"mon":{"start":"09:00","end":"19:00"},"tue":{"start":"09:00","end":"19:00"}}`}
          </code>
          . Quiet hours:{" "}
          <code className="px-1 bg-zinc-100 rounded">{`{"start":"21:00","end":"08:00"}`}</code>.
        </p>
      </div>

      <div className="space-y-3">
        {rows.map((r) => (
          <form
            key={r.id}
            action={async (formData: FormData) => {
              "use server";
              await saveSettings({
                conversationId: r.id,
                mode: formData.get("mode") as SaveModeValue,
                follow_up_enabled: formData.get("follow_up_enabled") === "on",
                cooldown_hours: Number(formData.get("cooldown_hours")),
                max_followups_per_week: Number(formData.get("max_followups_per_week")),
                timezone: String(formData.get("timezone") ?? "Asia/Kolkata"),
                business_hours_json: String(formData.get("business_hours_json") ?? ""),
                quiet_hours_json: String(formData.get("quiet_hours_json") ?? ""),
              });
            }}
            className="bg-white border border-zinc-200 rounded-lg p-4"
          >
            <div className="flex items-baseline justify-between gap-4 mb-3">
              <div>
                <div className="font-medium text-zinc-900">{r.name || r.phone}</div>
                <div className="text-xs text-zinc-400 font-mono">{r.phone}</div>
              </div>
              <button
                type="submit"
                className="px-3 py-1.5 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800"
              >
                Save
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <Field label="Mode">
                <select
                  name="mode"
                  defaultValue={r.mode}
                  className="w-full px-2 py-1 border border-zinc-300 rounded text-sm"
                >
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Follow-up enabled">
                <input
                  type="checkbox"
                  name="follow_up_enabled"
                  defaultChecked={r.follow_up_enabled}
                  className="mr-2"
                />
              </Field>

              <Field label="Cooldown (hours)">
                <input
                  type="number"
                  name="cooldown_hours"
                  defaultValue={r.cooldown_hours}
                  min={0}
                  className="w-full px-2 py-1 border border-zinc-300 rounded text-sm font-mono"
                />
              </Field>

              <Field label="Max follow-ups / week">
                <input
                  type="number"
                  name="max_followups_per_week"
                  defaultValue={r.max_followups_per_week}
                  min={0}
                  className="w-full px-2 py-1 border border-zinc-300 rounded text-sm font-mono"
                />
              </Field>

              <Field label="Timezone">
                <input
                  type="text"
                  name="timezone"
                  defaultValue={r.timezone}
                  className="w-full px-2 py-1 border border-zinc-300 rounded text-sm font-mono"
                />
              </Field>

              <div />

              <Field label="Business hours (JSON)" wide>
                <input
                  type="text"
                  name="business_hours_json"
                  defaultValue={r.business_hours_json}
                  placeholder='{"mon":{"start":"09:00","end":"19:00"}}'
                  className="w-full px-2 py-1 border border-zinc-300 rounded text-xs font-mono"
                />
              </Field>

              <Field label="Quiet hours (JSON)" wide>
                <input
                  type="text"
                  name="quiet_hours_json"
                  defaultValue={r.quiet_hours_json}
                  placeholder='{"start":"21:00","end":"08:00"}'
                  className="w-full px-2 py-1 border border-zinc-300 rounded text-xs font-mono"
                />
              </Field>
            </div>
          </form>
        ))}
      </div>
    </div>
  );
}

type SaveModeValue = "observe" | "suggest" | "assisted" | "autonomous";

function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "md:col-span-2" : ""}`}>
      <span className="text-xs text-zinc-500">{label}</span>
      {children}
    </label>
  );
}
