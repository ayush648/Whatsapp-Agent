-- Run this in Supabase SQL Editor to set up the database

create table conversations (
  id uuid default gen_random_uuid() primary key,
  phone text unique not null,
  name text,
  mode text not null default 'agent' check (mode in ('agent', 'human')),
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

create table messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references conversations(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  whatsapp_msg_id text unique,
  created_at timestamp with time zone default now()
);

create index idx_messages_conversation on messages(conversation_id);
create index idx_conversations_updated on conversations(updated_at desc);

-- Enable Realtime for the dashboard
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversations;

-- ─────────────────────────────────────────────────────────────
-- Migration: delivery status + read tracking (run on existing DB)
-- ─────────────────────────────────────────────────────────────

alter table messages
  add column if not exists status text
    check (status in ('sent', 'delivered', 'read', 'failed')),
  add column if not exists status_updated_at timestamptz;

alter table conversations
  add column if not exists last_read_at timestamptz default now();

create index if not exists idx_messages_whatsapp_msg_id on messages(whatsapp_msg_id);
create index if not exists idx_messages_convo_created on messages(conversation_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Migration: distinguish AI-generated outbound from human-sent
-- ─────────────────────────────────────────────────────────────

alter table messages
  add column if not exists sent_by_ai boolean not null default false;
