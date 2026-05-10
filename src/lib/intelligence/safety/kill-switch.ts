import { supabase } from "@/lib/supabase";

export type KillScope = {
  conversationId?: string;
  tenantId?: string;
};

export class KillSwitchTripped extends Error {
  constructor(
    public readonly trippedAt: string,
    public readonly reason: string | null
  ) {
    super(
      `Kill switch tripped at scope='${trippedAt}'` +
        (reason ? `: ${reason}` : "")
    );
    this.name = "KillSwitchTripped";
  }
}

type Resolution = {
  killed: boolean;
  trippedAt: string; // 'global' | 'tenant' | 'conversation' | 'fail-closed' | 'none'
  reason: string | null;
};

type CacheEntry = {
  expiresAt: number;
  resolution: Resolution;
};

// Faster TTL than feature flags — kill switch gates EVERY outbound action,
// so we want admin flips to take effect within seconds, not 15s.
const CACHE_TTL_MS = 5_000;

const RUNNING: Resolution = { killed: false, trippedAt: "none", reason: null };

class KillSwitch {
  private cache = new Map<string, CacheEntry>();

  async isKilled(scope: KillScope = {}): Promise<boolean> {
    return (await this.resolve(scope)).killed;
  }

  async assertNotKilled(scope: KillScope = {}): Promise<void> {
    const r = await this.resolve(scope);
    if (r.killed) throw new KillSwitchTripped(r.trippedAt, r.reason);
  }

  async resolve(scope: KillScope = {}): Promise<Resolution> {
    const cacheKey = `${scope.tenantId ?? ""}|${scope.conversationId ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.resolution;

    const resolution = await this.fetch(scope);
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      resolution,
    });
    return resolution;
  }

  clearCache(): void {
    this.cache.clear();
  }

  // Resolution rule: if ANY applicable row has enabled=false, the system is
  // killed at that scope. enabled=true rows are no-ops (they document the
  // running state but don't affect resolution).
  //
  // Three separate queries instead of one OR-filter so caller-supplied
  // scope_ids never go into a query string un-parameterized.
  private async fetch(scope: KillScope): Promise<Resolution> {
    try {
      // 1. Global
      const { data: g, error: gErr } = await supabase
        .from("ai_kill_switch")
        .select("enabled, reason")
        .eq("scope", "global")
        .is("scope_id", null)
        .maybeSingle();
      if (gErr) return failClosed(gErr.message);
      if (g && g.enabled === false) {
        return { killed: true, trippedAt: "global", reason: g.reason ?? null };
      }

      // 2. Tenant (if scoped)
      if (scope.tenantId) {
        const { data: t, error: tErr } = await supabase
          .from("ai_kill_switch")
          .select("enabled, reason")
          .eq("scope", "tenant")
          .eq("scope_id", scope.tenantId)
          .maybeSingle();
        if (tErr) return failClosed(tErr.message);
        if (t && t.enabled === false) {
          return { killed: true, trippedAt: "tenant", reason: t.reason ?? null };
        }
      }

      // 3. Conversation (if scoped)
      if (scope.conversationId) {
        const { data: c, error: cErr } = await supabase
          .from("ai_kill_switch")
          .select("enabled, reason")
          .eq("scope", "conversation")
          .eq("scope_id", scope.conversationId)
          .maybeSingle();
        if (cErr) return failClosed(cErr.message);
        if (c && c.enabled === false) {
          return { killed: true, trippedAt: "conversation", reason: c.reason ?? null };
        }
      }

      return RUNNING;
    } catch (err) {
      return failClosed(String(err));
    }
  }
}

// Fail closed: if we can't read the kill switch, ASSUME killed. Better to
// briefly block actions than to spam customers during an outage. Bounded by
// CACHE_TTL_MS — once the DB recovers, the next read clears the closed state.
function failClosed(message: string): Resolution {
  console.error("[kill-switch] failing CLOSED due to read error:", message);
  return { killed: true, trippedAt: "fail-closed", reason: message };
}

export const killSwitch = new KillSwitch();
