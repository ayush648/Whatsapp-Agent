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

  // Fetch last message for each conversation
  const withLastMessage = await Promise.all(
    (conversations || []).map(async (convo) => {
      const { data: messages } = await supabase
        .from("messages")
        .select("content, role, created_at, media_type")
        .eq("conversation_id", convo.id)
        .order("created_at", { ascending: false })
        .limit(1);

      const last = messages?.[0];
      const preview =
        last?.content ||
        (last?.media_type ? `[${last.media_type}]` : null);

      return {
        ...convo,
        last_message: preview,
      };
    })
  );

  return Response.json(withLastMessage);
}
