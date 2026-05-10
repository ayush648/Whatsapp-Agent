import { embed } from "@/lib/intelligence/ai/embed";
import { supabase } from "@/lib/supabase";

export type MemoryMatch = {
  id: string;
  conversation_id: string;
  kind: string;
  text: string;
  salience: number;
  similarity: number;
};

export type RetrieveOptions = {
  query: string;
  conversationId?: string;
  k?: number;
  threshold?: number;
};

export async function retrieveMemory(opts: RetrieveOptions): Promise<MemoryMatch[]> {
  let queryVec: number[];
  try {
    queryVec = await embed(opts.query);
  } catch (err) {
    console.error("[memory.retriever] embed failed:", err);
    return [];
  }

  // pgvector wire format is `[1,2,3]`. PostgREST will JSON-encode our number[]
  // as `[1, 2, 3]` and the function's `vector` cast handles it.
  const { data, error } = await supabase.rpc("match_memory_chunks", {
    query_embedding: queryVec,
    match_threshold: opts.threshold ?? 0.6,
    match_count: opts.k ?? 5,
    filter_conversation_id: opts.conversationId ?? null,
  });

  if (error) {
    console.error("[memory.retriever] rpc failed:", error.message);
    return [];
  }
  return (data ?? []) as MemoryMatch[];
}
