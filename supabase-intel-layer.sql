-- ─────────────────────────────────────────────────────────────────────────────
-- Intelligence Layer schema  (Sprint 0, Step 0.1)
--
-- Run this in Supabase SQL Editor AFTER the base supabase-schema.sql.
--
-- This migration is ADDITIVE ONLY:
--   • does NOT modify any existing column or row
--   • only adds nullable columns to `messages`
--   • only creates new tables prefixed `ai_*` (plus `feature_flags`)
--
-- Rollback: see commented section at the bottom of this file.
--
-- Decisions locked in IMPLEMENTATION_PROGRESS.md:
--   • Embeddings: vector(1536) — OpenAI text-embedding-3-small
--   • LLM provider: OpenAI (existing dep)
--   • Voice briefings: deferred — `ai_summaries` has no voice columns in v1
--   • RLS: enabled on all ai_* tables WITHOUT policies. Server-side worker
--     uses service_role key which bypasses RLS, so worker works fine.
--     Anon/authenticated keys have no access until Sprint 6 adds policies.
-- ─────────────────────────────────────────────────────────────────────────────

-- pgvector for semantic memory
create extension if not exists vector;


-- ─────────────────────────────────────────────────────────────────────────────
-- Additive columns on existing `messages`
-- ─────────────────────────────────────────────────────────────────────────────

alter table messages
  add column if not exists ai_processed_at timestamptz,
  add column if not exists ai_intent text,
  add column if not exists ai_priority int;

create index if not exists idx_messages_ai_unprocessed
  on messages (id) where ai_processed_at is null;


-- ─────────────────────────────────────────────────────────────────────────────
-- Per-conversation AI settings (operation mode, toggles, hours)
-- One row per conversation. Missing row ⇒ application falls back to defaults.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_settings (
  id                     uuid default gen_random_uuid() primary key,
  conversation_id        uuid references conversations(id) on delete cascade unique,
  tenant_id              uuid,                                          -- multi-tenant hook (unused in v1)
  mode                   text not null default 'observe'
                           check (mode in ('observe','suggest','assisted','autonomous')),
  follow_up_enabled      boolean not null default false,
  summary_enabled        boolean not null default false,
  briefing_enabled       boolean not null default false,
  auto_send_enabled      boolean not null default false,
  business_hours         jsonb,                                         -- {mon: {start:'09:00', end:'19:00'}, ...}
  quiet_hours            jsonb,                                         -- {start:'21:00', end:'08:00'}
  timezone               text default 'Asia/Kolkata',
  max_followups_per_week int default 3,
  cooldown_hours         int default 12,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Extracted entities  (people / products / amounts / dates / etc.)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_entities (
  id                uuid default gen_random_uuid() primary key,
  conversation_id   uuid references conversations(id) on delete cascade not null,
  tenant_id         uuid,
  type              text not null
                      check (type in ('person','org','product','amount','date',
                                      'location','sku','phone','email','other')),
  value             text not null,
  normalized        jsonb,
  source_message_id uuid references messages(id) on delete set null,
  confidence        numeric(4,3),
  first_seen_at     timestamptz default now(),
  last_seen_at      timestamptz default now()
);

create index if not exists idx_ai_entities_convo on ai_entities (conversation_id, type);
create index if not exists idx_ai_entities_value on ai_entities (lower(value));


-- ─────────────────────────────────────────────────────────────────────────────
-- Tasks / promises / commitments  (the "remember promises" engine)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_tasks (
  id                    uuid default gen_random_uuid() primary key,
  conversation_id       uuid references conversations(id) on delete cascade not null,
  tenant_id             uuid,
  source_message_id     uuid references messages(id) on delete set null,
  direction             text not null
                          check (direction in ('inbound_promise','outbound_promise',
                                               'question_to_us','question_to_them')),
  description           text not null,
  owner                 text not null check (owner in ('us','them')),
  status                text not null default 'open'
                          check (status in ('open','fulfilled','overdue',
                                            'cancelled','escalated','needs_review')),
  due_at                timestamptz,
  detected_at           timestamptz default now(),
  fulfilled_at          timestamptz,
  fulfilling_message_id uuid references messages(id) on delete set null,
  confidence            numeric(4,3),
  evidence_span         jsonb,                                          -- {start:int, end:int, text:str}
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create index if not exists idx_ai_tasks_open on ai_tasks (conversation_id, status, due_at);
create index if not exists idx_ai_tasks_overdue
  on ai_tasks (status, due_at) where status = 'open';


-- ─────────────────────────────────────────────────────────────────────────────
-- Follow-ups  (proposed / approved / sent reminders)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_followups (
  id               uuid default gen_random_uuid() primary key,
  conversation_id  uuid references conversations(id) on delete cascade not null,
  tenant_id        uuid,
  task_id          uuid references ai_tasks(id) on delete set null,
  scheduled_for    timestamptz not null,
  state            text not null default 'proposed'
                     check (state in ('proposed','approved','sent','skipped','failed','cancelled')),
  draft_text       text,
  language_hint    text,                                                -- 'hi','en','hinglish'
  attempt          int default 1,
  sent_message_id  uuid references messages(id) on delete set null,
  approved_by      text,
  approved_at      timestamptz,
  sent_at          timestamptz,
  failure_reason   text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists idx_ai_followups_due   on ai_followups (state, scheduled_for);
create index if not exists idx_ai_followups_convo on ai_followups (conversation_id, state);


-- ─────────────────────────────────────────────────────────────────────────────
-- Summaries  (text-only in v1; voice deferred to v2 — schema-additive when added)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_summaries (
  id              uuid default gen_random_uuid() primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  tenant_id       uuid,
  scope           text not null
                    check (scope in ('chat_rolling','daily','weekly','topic','urgent')),
  range_start     timestamptz,
  range_end       timestamptz,
  text            text not null,
  key_points      jsonb,
  generated_at    timestamptz default now(),
  model           text,
  version         int default 1
);

create index if not exists idx_ai_summaries_convo_scope
  on ai_summaries (conversation_id, scope, generated_at desc);


-- ─────────────────────────────────────────────────────────────────────────────
-- Memory chunks  (long-term semantic memory via pgvector)
-- 1536 dims = OpenAI text-embedding-3-small
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_memory_chunks (
  id              uuid default gen_random_uuid() primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  tenant_id       uuid,
  kind            text not null
                    check (kind in ('fact','preference','history','relationship','policy','outcome')),
  text            text not null,
  embedding       vector(1536),
  source          jsonb,
  salience        real default 0.5,
  last_used_at    timestamptz default now(),
  created_at      timestamptz default now()
);

create index if not exists idx_ai_memory_convo on ai_memory_chunks (conversation_id);
create index if not exists idx_ai_memory_embedding
  on ai_memory_chunks using hnsw (embedding vector_cosine_ops);


-- ─────────────────────────────────────────────────────────────────────────────
-- Action audit log  (every AI proposal / decision / execution)
-- Append-only by convention. Revoke UPDATE/DELETE in production if needed.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_actions (
  id              uuid default gen_random_uuid() primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  tenant_id       uuid,
  correlation_id  uuid,
  kind            text not null,                                        -- 'extract_intent', 'draft_followup', 'send_followup', ...
  payload         jsonb,
  mode_at_time    text,
  decision        text
                    check (decision in ('proposed','approved','denied','executed','failed','skipped')),
  decided_by      text,                                                 -- 'system' or user id
  confidence      numeric(4,3),
  model           text,
  prompt_hash     text,
  latency_ms      int,
  cost_usd        numeric(10,6),
  result          jsonb,
  error           text,
  created_at      timestamptz default now(),
  executed_at     timestamptz
);

create index if not exists idx_ai_actions_convo       on ai_actions (conversation_id, created_at desc);
create index if not exists idx_ai_actions_correlation on ai_actions (correlation_id);
create index if not exists idx_ai_actions_kind        on ai_actions (kind, created_at desc);


-- ─────────────────────────────────────────────────────────────────────────────
-- Relationship rollup  (per-contact health / sentiment / value)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_relationship_state (
  conversation_id          uuid primary key references conversations(id) on delete cascade,
  tenant_id                uuid,
  label                    text,                                        -- 'customer','vendor','lead','partner','internal','other'
  health_score             int,                                         -- 0..100
  sentiment_trend          jsonb,                                       -- last N samples
  last_activity_at         timestamptz,
  response_latency_avg_ms  bigint,
  deal_probability         real,
  value_estimate           jsonb,
  notes                    text,
  updated_at               timestamptz default now()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotency: which consumer processed which event
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_processed_events (
  consumer_name text not null,
  event_id      text not null,                                          -- 'message:{uuid}', 'task:{uuid}', ...
  processed_at  timestamptz default now(),
  primary key (consumer_name, event_id)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Feature flags  (resolution: conversation > user > tenant > global)
-- Two unique partial indexes so global rows (scope_id IS NULL) can be unique.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists feature_flags (
  id               uuid default gen_random_uuid() primary key,
  flag_key         text not null,
  scope            text not null check (scope in ('global','tenant','user','conversation')),
  scope_id         uuid,                                                -- null for global
  enabled          boolean not null default false,
  value            jsonb,
  rollout_percent  int default 100,
  updated_at       timestamptz default now()
);

create unique index if not exists feature_flags_global_unique
  on feature_flags (flag_key) where scope = 'global';
create unique index if not exists feature_flags_scoped_unique
  on feature_flags (flag_key, scope, scope_id) where scope_id is not null;
create index if not exists idx_feature_flags_lookup
  on feature_flags (flag_key, scope, scope_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- Kill switch  (single source of truth for "stop all AI side effects")
-- enabled = true  → system running
-- enabled = false → system killed (Plane C blocks all outbound)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_kill_switch (
  id          uuid default gen_random_uuid() primary key,
  scope       text not null check (scope in ('global','tenant','conversation')),
  scope_id    uuid,
  enabled     boolean not null default true,
  reason      text,
  updated_by  text,
  updated_at  timestamptz default now()
);

create unique index if not exists ai_kill_switch_global_unique
  on ai_kill_switch (scope) where scope = 'global';
create unique index if not exists ai_kill_switch_scoped_unique
  on ai_kill_switch (scope, scope_id) where scope_id is not null;

-- Seed: one global "running" row
insert into ai_kill_switch (scope, scope_id, enabled, reason)
select 'global', null, true, 'Initial seed (Sprint 0)'
where not exists (
  select 1 from ai_kill_switch where scope = 'global' and scope_id is null
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security
-- Enabled WITHOUT policies. Service role bypasses RLS (used by server worker),
-- so this is effectively "server-only" access. Anon/authenticated keys get
-- nothing until Sprint 6 adds explicit policies for dashboard reads.
-- ─────────────────────────────────────────────────────────────────────────────

alter table ai_settings           enable row level security;
alter table ai_entities           enable row level security;
alter table ai_tasks              enable row level security;
alter table ai_followups          enable row level security;
alter table ai_summaries          enable row level security;
alter table ai_memory_chunks      enable row level security;
alter table ai_actions            enable row level security;
alter table ai_relationship_state enable row level security;
alter table ai_processed_events   enable row level security;
alter table feature_flags         enable row level security;
alter table ai_kill_switch        enable row level security;


-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime publication  (so the dashboard sees AI updates live)
-- Wrapped to be re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['ai_tasks','ai_followups','ai_summaries','ai_actions']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (uncomment everything below to fully remove the intel layer)
-- ─────────────────────────────────────────────────────────────────────────────

-- drop table if exists ai_kill_switch        cascade;
-- drop table if exists feature_flags         cascade;
-- drop table if exists ai_processed_events   cascade;
-- drop table if exists ai_relationship_state cascade;
-- drop table if exists ai_actions            cascade;
-- drop table if exists ai_memory_chunks      cascade;
-- drop table if exists ai_summaries          cascade;
-- drop table if exists ai_followups          cascade;
-- drop table if exists ai_tasks              cascade;
-- drop table if exists ai_entities           cascade;
-- drop table if exists ai_settings           cascade;
-- alter table messages drop column if exists ai_priority;
-- alter table messages drop column if exists ai_intent;
-- alter table messages drop column if exists ai_processed_at;
-- drop extension if exists vector;
