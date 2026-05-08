import { supabase } from "@/lib/supabase";

export async function GET() {
  // Get all conversations with their latest message
  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Fetch last message + unread count for each conversation
  const withLastMessage = await Promise.all(
    (conversations || []).map(async (convo) => {
      const [{ data: messages }, { count: unreadCount }] = await Promise.all([
        supabase
          .from("messages")
          .select("content, role, created_at, media_type")
          .eq("conversation_id", convo.id)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", convo.id)
          .eq("role", "user")
          .gt("created_at", convo.last_read_at ?? "1970-01-01"),
      ]);

      const last = messages?.[0];
      const preview =
        last?.content ||
        (last?.media_type ? `[${last.media_type}]` : null);

      return {
        ...convo,
        last_message: preview,
        unread_count: unreadCount ?? 0,
      };
    })
  );

  return Response.json(withLastMessage);
}
