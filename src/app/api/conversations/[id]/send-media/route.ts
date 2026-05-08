import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppMedia } from "@/lib/whatsapp";
import { uploadMedia } from "@/lib/storage";

function kindFromMime(
  mime: string
): "image" | "audio" | "video" | "document" | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "document";
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const formData = await request.formData();
  const file = formData.get("file");
  const caption = (formData.get("caption") as string | null)?.trim() || null;

  if (!(file instanceof File)) {
    return Response.json({ error: "file is required" }, { status: 400 });
  }

  const mime = file.type || "application/octet-stream";
  const kind = kindFromMime(mime);
  if (!kind) {
    return Response.json(
      { error: `Unsupported file type: ${mime}` },
      { status: 400 }
    );
  }

  const { data: conversation, error: convoError } = await supabase
    .from("conversations")
    .select("phone")
    .eq("id", id)
    .single();

  if (convoError || !conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const buffer = await file.arrayBuffer();
  const publicUrl = await uploadMedia(buffer, mime);

  const sendResult = await sendWhatsAppMedia(conversation.phone, kind, publicUrl, {
    caption: caption || undefined,
    filename: kind === "document" ? file.name : undefined,
  });
  const outboundMsgId: string | null = sendResult?.messages?.[0]?.id ?? null;

  const { data: msg, error: msgError } = await supabase
    .from("messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: caption,
      media_url: publicUrl,
      media_type: kind,
      media_mime_type: mime,
      media_caption: caption,
      whatsapp_msg_id: outboundMsgId,
      status: outboundMsgId ? "sent" : null,
    })
    .select()
    .single();

  if (msgError) {
    return Response.json({ error: msgError.message }, { status: 500 });
  }

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return Response.json(msg);
}
