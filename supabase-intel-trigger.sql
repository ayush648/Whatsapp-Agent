-- ─────────────────────────────────────────────────────────────────────────────
-- pg_notify trigger on `messages` insert  (Sprint 0, Step 0.2)
--
-- Run this in Supabase SQL Editor AFTER `supabase-intel-layer.sql`.
--
-- Fires AFTER INSERT on `messages`. Emits a small JSON payload on the
-- 'ai_events' channel. The intelligence worker (Step 0.4) LISTENs on this
-- channel and dispatches per-role processing.
--
-- Sacred webhook contract:
--   • The trigger runs AFTER INSERT — never blocks or alters the insert.
--   • If the trigger function itself errors, the insert STILL succeeds
--     (we trap exceptions to be safe).
--   • If no worker is connected, notifications are dropped — but the
--     worker's watermark replay (queries `messages WHERE id > watermark`
--     on startup) ensures events are never permanently lost.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function notify_ai_event()
returns trigger
language plpgsql
as $$
begin
  begin
    perform pg_notify(
      'ai_events',
      json_build_object(
        'message_id',      NEW.id,
        'conversation_id', NEW.conversation_id,
        'role',            NEW.role,
        'sent_by_ai',      coalesce(NEW.sent_by_ai, false),
        'created_at',      NEW.created_at
      )::text
    );
  exception when others then
    -- Never let a notify failure break the insert.
    -- The worker's replay path will pick this message up via watermark.
    null;
  end;
  return NEW;
end;
$$;

-- Replace any prior version safely
drop trigger if exists ai_event_on_message_insert on messages;

create trigger ai_event_on_message_insert
  after insert on messages
  for each row
  execute function notify_ai_event();
