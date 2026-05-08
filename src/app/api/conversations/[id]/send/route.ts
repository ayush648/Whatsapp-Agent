import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppMessage } from "@/lib/whatsapp";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { message } = body;

  if (!message?.trim()) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  // Get conversation to find phone number
  const { data: conversation, error: convoError } = await supabase
    .from("conversations")
    .select("phone")
    .eq("id", id)
    .single();

  if (convoError || !conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  // Send via WhatsApp
  const sendResult = await sendWhatsAppMessage(conversation.phone, message);
  const outboundMsgId: string | null = sendResult?.messages?.[0]?.id ?? null;

  // Store in DB
  const { data: msg, error: msgError } = await supabase
    .from("messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: message,
      whatsapp_msg_id: outboundMsgId,
      status: outboundMsgId ? "sent" : null,
    })
    .select()
    .single();

  if (msgError) {
    return Response.json({ error: msgError.message }, { status: 500 });
  }

  // Update conversation timestamp
  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return Response.json(msg);
}
