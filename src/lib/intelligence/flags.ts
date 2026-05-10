import { supabase } from "@/lib/supabase";

export type FlagScope = {
  conversationId?: string;
  userId?: string;
  tenantId?: string;
};

type ScopeKind = "conversation" | "user" | "tenant" | "global";

type FlagRow = {
  scope: ScopeKind;
  scope_id: string | null;
  enabled: boolean;
  value: unknown;
  rollout_percent: number | null;
};

type ResolvedFlag = {
  enabled: boolean;
  value: unknown;
  rolloutPercent: number;
  resolvedFrom: ScopeKind | "default";
};

const CACHE_TTL_MS = 15_000;
const SCOPE_PRIORITY: ReadonlyArray<ScopeKind> = [
  "conversation",
  "user",
  "tenant",
  "global",
];

const DEFAULT_FLAG: ResolvedFlag = {
  enabled: false,
  value: null,
  rolloutPercent: 100,
  resolvedFrom: "default",
};

type CacheEntry = {
  expiresAt: number;
  resolved: ResolvedFlag;
};

class Flags {
  private cache = new Map<string, CacheEntry>();

  async isEnabled(key: string, scope: FlagScope = {}): Promise<boolean> {
    const resolved = await this.resolve(key, scope);
    if (!resolved.enabled) return false;
    return passesRollout(key, scope, resolved.rolloutPercent);
  }

  async getValue<T = unknown>(key: string, scope: FlagScope = {}): Promise<T | null> {
    const resolved = await this.resolve(key, scope);
    if (!resolved.enabled) return null;
    return (resolved.value as T) ?? null;
  }

  async resolve(key: string, scope: FlagScope = {}): Promise<ResolvedFlag> {
    const cacheKey = this.cacheKey(key, scope);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.resolved;

    const resolved = await this.fetchAndResolve(key, scope);
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      resolved,
    });
    return resolved;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async fetchAndResolve(key: string, scope: FlagScope): Promise<ResolvedFlag> {
    try {
      const { data, error } = await supabase
        .from("feature_flags")
        .select("scope, scope_id, enabled, value, rollout_percent")
        .eq("flag_key", key);

      if (error) {
        console.error("[flags] DB error:", error.message);
        return DEFAULT_FLAG;
      }
      if (!data || data.length === 0) return DEFAULT_FLAG;

      const rows = data as FlagRow[];

      for (const priority of SCOPE_PRIORITY) {
        let row: FlagRow | undefined;
        if (priority === "global") {
          row = rows.find((r) => r.scope === "global" && r.scope_id === null);
        } else {
          const target = scopeIdFor(priority, scope);
          if (!target) continue;
          row = rows.find((r) => r.scope === priority && r.scope_id === target);
        }
        if (row) {
          return {
            enabled: row.enabled,
            value: row.value,
            rolloutPercent: row.rollout_percent ?? 100,
            resolvedFrom: priority,
          };
        }
      }
      return DEFAULT_FLAG;
    } catch (err) {
      console.error("[flags] unexpected error:", err);
      return DEFAULT_FLAG;
    }
  }

  private cacheKey(key: string, scope: FlagScope): string {
    return [
      key,
      scope.conversationId ?? "",
      scope.userId ?? "",
      scope.tenantId ?? "",
    ].join("|");
  }
}

function scopeIdFor(priority: ScopeKind, scope: FlagScope): string | undefined {
  switch (priority) {
    case "conversation": return scope.conversationId;
    case "user":         return scope.userId;
    case "tenant":       return scope.tenantId;
    case "global":       return undefined;
  }
}

function passesRollout(key: string, scope: FlagScope, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const stableInput =
    scope.conversationId ?? scope.userId ?? scope.tenantId ?? key;
  const bucket = stableHash(`${key}:${stableInput}`) % 100;
  return bucket < percent;
}

// FNV-1a 32-bit. Deterministic across processes — same input always buckets the same.
function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const flags = new Flags();
