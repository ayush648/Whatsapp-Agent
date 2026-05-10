-- ─────────────────────────────────────────────────────────────────────────────
-- Memory retrieval RPC  (Sprint 1, Step 1.8)
--
-- Run this in Supabase SQL Editor AFTER `supabase-intel-layer.sql`.
--
-- pgvector queries can't be expressed through PostgREST's URL filter syntax,
-- so we expose a stored function callable via `supabase.rpc(...)`.
--
-- Cosine similarity = 1 - cosine distance (the `<=>` operator).
-- Higher similarity = closer match.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function match_memory_chunks(
  query_embedding vector(1536),
  match_threshold float default 0.6,
  match_count int default 5,
  filter_conversation_id uuid default null
)
returns table (
  id uuid,
  conversation_id uuid,
  kind text,
  text text,
  salience real,
  similarity float
)
language sql
stable
as $$
  select
    c.id,
    c.conversation_id,
    c.kind,
    c.text,
    c.salience,
    1 - (c.embedding <=> query_embedding) as similarity
  from ai_memory_chunks c
  where (filter_conversation_id is null or c.conversation_id = filter_conversation_id)
    and c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
