import { createHash } from "node:crypto";
import { type ZodType } from "zod";
import { supabase } from "@/lib/supabase";
import { killSwitch } from "@/lib/intelligence/safety/kill-switch";
import { openrouter } from "./providers/openrouter";
import type { LLMMessage, LLMProvider } from "./providers/types";

export type AiCallScope = {
  conversationId?: string;
  tenantId?: string;
};

export type AiCallParams<T> = {
  /** Logical name of the call. Used as `kind` in `ai_actions` and as cache namespace. */
  name: string;
  /** Model slug (e.g. 'openai/gpt-4o-mini'). */
  model: string;
  messages: LLMMessage[];
  /** Zod schema. The LLM output is JSON-parsed and then validated. */
  schema: ZodType<T>;
  /** Optional cache key. If a prior `executed` audit row exists with this key, it's reused. */
  cacheKey?: string;
  /** For kill-switch enforcement and audit attribution. */
  scope?: AiCallScope;
  /** Threading id, propagates across related calls. */
  correlationId?: string;
  /** Default 0.2. */
  temperature?: number;
  maxTokens?: number;
  /** Inject a different provider (test). Defaults to OpenRouter. */
  provider?: LLMProvider;
  /** 'system' (default) or a user id. */
  decidedBy?: string;
  /** Recorded in `ai_actions.mode_at_time`. */
  modeAtTime?: string;
};

export type AiCallResult<T> = {
  data: T;
  fromCache: boolean;
  latencyMs: number;
  costUsd: number;
  modelUsed: string;
  promptHash: string;
};

export class AiCallError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AiCallError";
  }
}

// Rough OpenRouter pass-through pricing per 1M tokens (USD). Update as needed.
// Unknown models cost 0 in the audit (not blocking — just unattributed).
const COST_PER_1M_TOKENS: Record<string, { in: number; out: number }> = {
  "openai/gpt-4o-mini":            { in: 0.15,  out: 0.60 },
  "openai/gpt-4o":                 { in: 2.5,   out: 10.0 },
  "anthropic/claude-haiku-4.5":    { in: 0.25,  out: 1.25 },
  "anthropic/claude-sonnet-4.6":   { in: 3.0,   out: 15.0 },
  "anthropic/claude-3.5-haiku":    { in: 0.80,  out: 4.0 },
  "anthropic/claude-3.5-sonnet":   { in: 3.0,   out: 15.0 },
};

export async function aiCall<T>(params: AiCallParams<T>): Promise<AiCallResult<T>> {
  const provider = params.provider ?? openrouter;
  const promptHash = hashPrompt(params.messages, params.model);
  const startedAt = Date.now();

  // Plane C contract: kill switch is checked before every AI call.
  await killSwitch.assertNotKilled(params.scope ?? {});

  // 1. Cache hit?
  if (params.cacheKey) {
    const cached = await loadCached<T>(params.name, params.cacheKey);
    if (cached !== null) {
      const validated = params.schema.safeParse(cached.data);
      if (validated.success) {
        const latencyMs = Date.now() - startedAt;
        await writeAudit({
          name: params.name,
          decision: "executed",
          decided_by: params.decidedBy ?? "system",
          mode_at_time: params.modeAtTime ?? "cached",
          model: cached.model,
          prompt_hash: promptHash,
          latency_ms: latencyMs,
          cost_usd: 0,
          payload: {
            cache_key: params.cacheKey,
            cache_hit: true,
            messages_redacted: redact(params.messages),
          },
          result: { data: validated.data },
          conversation_id: params.scope?.conversationId ?? null,
          correlation_id: params.correlationId ?? null,
        });
        return {
          data: validated.data,
          fromCache: true,
          latencyMs,
          costUsd: 0,
          modelUsed: cached.model ?? "cache",
          promptHash,
        };
      }
      // Stale cache failed schema (schema changed) — fall through and re-call.
    }
  }

  // 2. Call the LLM
  const auditBase = {
    name: params.name,
    decided_by: params.decidedBy ?? "system",
    mode_at_time: params.modeAtTime ?? null,
    model: params.model,
    prompt_hash: promptHash,
    conversation_id: params.scope?.conversationId ?? null,
    correlation_id: params.correlationId ?? null,
    payload: {
      cache_key: params.cacheKey ?? null,
      messages_redacted: redact(params.messages),
    },
  };

  let llmResult;
  try {
    llmResult = await provider.call({
      model: params.model,
      messages: params.messages,
      responseFormat: "json",
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    await writeAudit({
      ...auditBase,
      decision: "failed",
      latency_ms: latencyMs,
      cost_usd: 0,
      error: errorMessage(err),
    });
    throw new AiCallError(`LLM call '${params.name}' failed`, err);
  }

  const latencyMs = Date.now() - startedAt;
  const costUsd = estimateCost(params.model, llmResult.inputTokens, llmResult.outputTokens);

  // 3. Parse + validate
  let parsed: unknown;
  try {
    parsed = JSON.parse(llmResult.text);
  } catch (err) {
    await writeAudit({
      ...auditBase,
      model: llmResult.modelUsed,
      decision: "failed",
      latency_ms: latencyMs,
      cost_usd: costUsd,
      result: { raw_text: llmResult.text.slice(0, 2000) },
      error: `JSON parse failed: ${errorMessage(err)}`,
    });
    throw new AiCallError(
      `LLM '${params.name}' returned invalid JSON: ${llmResult.text.slice(0, 200)}`,
      err
    );
  }

  const validated = params.schema.safeParse(parsed);
  if (!validated.success) {
    await writeAudit({
      ...auditBase,
      model: llmResult.modelUsed,
      decision: "failed",
      latency_ms: latencyMs,
      cost_usd: costUsd,
      result: { raw_parsed: parsed },
      error: `schema validation failed: ${validated.error.message}`,
    });
    throw new AiCallError(
      `LLM '${params.name}' output failed schema validation: ${validated.error.message}`
    );
  }

  // 4. Audit success
  await writeAudit({
    ...auditBase,
    model: llmResult.modelUsed,
    decision: "executed",
    latency_ms: latencyMs,
    cost_usd: costUsd,
    payload: {
      ...auditBase.payload,
      input_tokens: llmResult.inputTokens,
      output_tokens: llmResult.outputTokens,
    },
    result: { data: validated.data },
  });

  return {
    data: validated.data,
    fromCache: false,
    latencyMs,
    costUsd,
    modelUsed: llmResult.modelUsed,
    promptHash,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

type AuditRow = {
  name: string;
  decision: "executed" | "failed";
  decided_by: string;
  mode_at_time: string | null;
  model: string | null;
  prompt_hash: string;
  latency_ms: number;
  cost_usd: number;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  conversation_id: string | null;
  correlation_id: string | null;
};

async function writeAudit(row: AuditRow): Promise<void> {
  try {
    const { error } = await supabase.from("ai_actions").insert({
      kind: row.name,
      conversation_id: row.conversation_id,
      correlation_id: row.correlation_id,
      payload: row.payload,
      mode_at_time: row.mode_at_time,
      decision: row.decision,
      decided_by: row.decided_by,
      model: row.model,
      prompt_hash: row.prompt_hash,
      latency_ms: row.latency_ms,
      cost_usd: row.cost_usd,
      result: row.result ?? null,
      error: row.error ?? null,
      executed_at: row.decision === "executed" ? new Date().toISOString() : null,
    });
    if (error) console.error("[ai_call] audit write failed:", error.message);
  } catch (err) {
    console.error("[ai_call] audit write threw:", err);
  }
}

async function loadCached<T>(
  name: string,
  cacheKey: string
): Promise<{ data: T; model: string | null } | null> {
  const { data, error } = await supabase
    .from("ai_actions")
    .select("result, model")
    .eq("kind", name)
    .eq("decision", "executed")
    .eq("payload->>cache_key", cacheKey)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  const row = data[0] as { result: { data: T } | null; model: string | null };
  if (!row.result || row.result.data === undefined) return null;
  return { data: row.result.data, model: row.model };
}

function hashPrompt(messages: LLMMessage[], model: string): string {
  const h = createHash("sha256");
  h.update(model);
  for (const m of messages) h.update(`\n${m.role}:${m.content}`);
  return h.digest("hex").slice(0, 16);
}

// Audit-friendly redaction. Stores role + length + first-100-char preview.
// Full content lives in the source `messages` row already; no need to duplicate.
function redact(messages: LLMMessage[]): unknown {
  return messages.map((m) => ({
    role: m.role,
    content_length: m.content.length,
    content_preview: m.content.slice(0, 100),
  }));
}

function estimateCost(model: string, inTokens: number, outTokens: number): number {
  const c = COST_PER_1M_TOKENS[model];
  if (!c) return 0;
  return (inTokens * c.in + outTokens * c.out) / 1_000_000;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
