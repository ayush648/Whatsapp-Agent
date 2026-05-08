import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { markAsRead } from "@/lib/whatsapp";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { data: latestInbound } = await supabase
    .from("messages")
    .select("whatsapp_msg_id")
    .eq("conversation_id", id)
    .eq("role", "user")
    .not("whatsapp_msg_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestInbound?.whatsapp_msg_id) {
    markAsRead(latestInbound.whatsapp_msg_id).catch((err) =>
      console.error("markAsRead failed", err)
    );
  }

  const { error } = await supabase
    .from("conversations")
    .update({ last_read_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ status: "ok" });
}
