import { z } from "zod";
import { aiCall } from "@/lib/intelligence/ai/call";
import { ENTITY_PROMPT } from "@/lib/intelligence/ai/prompts";
import { supabase } from "@/lib/supabase";
import type { MessageRow } from "../processor";

const ENTITY_TYPES = [
  "person",
  "org",
  "product",
  "amount",
  "date",
  "location",
  "sku",
  "phone",
  "email",
  "other",
] as const;

const EntitySchema = z.object({
  type: z.enum(ENTITY_TYPES),
  value: z.string().min(1),
  normalized: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const EntitiesSchema = z.object({
  entities: z.array(EntitySchema),
});

const MODEL = process.env.AI_MODEL ?? "openai/gpt-4o-mini";

export async function extractEntities(message: MessageRow, text: string): Promise<void> {
  const result = await aiCall({
    name: "extract_entities",
    model: MODEL,
    messages: [
      { role: "system", content: ENTITY_PROMPT },
      { role: "user", content: text },
    ],
    schema: EntitiesSchema,
    cacheKey: `${message.id}:entities`,
    scope: { conversationId: message.conversation_id },
  });

  if (result.data.entities.length === 0) return;

  const rows = result.data.entities.map((e) => ({
    conversation_id: message.conversation_id,
    type: e.type,
    value: e.value.slice(0, 500),
    normalized: e.normalized ?? null,
    source_message_id: message.id,
    confidence: e.confidence ?? null,
  }));

  const { error } = await supabase.from("ai_entities").insert(rows);
  if (error) console.error("[entities] insert failed:", error.message);
}
