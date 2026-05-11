-- ─────────────────────────────────────────────────────────────────────────────
-- Sprint 3 schema additions — reminders + scheduling
--
-- Run this in Supabase SQL Editor AFTER `supabase-intel-layer.sql`.
-- Additive only: creates one new table.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_reminders (
  id                uuid default gen_random_uuid() primary key,
  conversation_id   uuid references conversations(id) on delete cascade not null,
  tenant_id         uuid,
  text              text not null,
  scheduled_for     timestamptz not null,
  recurring_cron    text,                                                  -- e.g. '0 10 * * 1' (every Mon 10am)
  condition         jsonb,                                                 -- {type:'no_inbound_since', since_iso:'...'} or null
  state             text not null default 'pending'
                      check (state in ('pending','fired','cancelled','failed','condition_failed')),
  created_by        text default 'system',
  source            jsonb,                                                 -- {voice_command_text, parse_confidence, ...}
  fired_at          timestamptz,
  fired_message_id  uuid references messages(id) on delete set null,
  failure_reason    text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists idx_ai_reminders_due
  on ai_reminders (state, scheduled_for) where state = 'pending';
create index if not exists idx_ai_reminders_conv
  on ai_reminders (conversation_id, scheduled_for desc);

alter table ai_reminders enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'ai_reminders'
  ) then
    alter publication supabase_realtime add table ai_reminders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (commented; uncomment to remove the Sprint 3 addition)
-- ─────────────────────────────────────────────────────────────────────────────

-- drop table if exists ai_reminders cascade;
