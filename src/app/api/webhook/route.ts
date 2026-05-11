import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  sendWhatsAppMessage,
  sendTypingIndicator,
  getMediaInfo,
  downloadMedia,
} from "@/lib/whatsapp";
import { uploadMedia } from "@/lib/storage";
import { transcribeAudio } from "@/lib/transcribe";
import { extractPdfText } from "@/lib/pdf";
import { getAIResponse, type AIMessage } from "@/lib/ai";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

type IncomingMedia = {
  media_url: string | null;
  media_type: "image" | "audio" | "video" | "document" | "sticker" | null;
  media_mime_type: string | null;
  caption: string | null;
  transcript: string | null;
  extracted_text: string | null;
  filename: string | null;
};

const NO_MEDIA: IncomingMedia = {
  media_url: null,
  media_type: null,
  media_mime_type: null,
  caption: null,
  transcript: null,
  extracted_text: null,
  filename: null,
};

async function persistInboundMedia(
  message: Record<string, unknown>
): Promise<IncomingMedia> {
  const type = message.type as string;
  const mediaTypeMap: Record<string, IncomingMedia["media_type"]> = {
    image: "image",
    audio: "audio",
    voice: "audio",
    video: "video",
    document: "document",
    sticker: "sticker",
  };
  const normalizedType = mediaTypeMap[type];
  if (!normalizedType) return NO_MEDIA;

  const payloadKey = type === "voice" ? "audio" : type;
  const mediaObj = message[payloadKey] as
    | { id?: string; caption?: string; mime_type?: string; filename?: string }
    | undefined;
  if (!mediaObj?.id) return NO_MEDIA;

  const { url, mime_type } = await getMediaInfo(mediaObj.id);
  const buffer = await downloadMedia(url);
  const publicUrl = await uploadMedia(buffer, mime_type);

  let transcript: string | null = null;
  let extracted_text: string | null = null;

  if (normalizedType === "audio") {
    try {
      transcript = await transcribeAudio(buffer, mime_type);
    } catch (err) {
      console.error("Transcription failed:", err);
    }
  } else if (normalizedType === "document" && mime_type === "application/pdf") {
    try {
      extracted_text = await extractPdfText(buffer);
    } catch (err) {
      console.error("PDF extraction failed:", err);
    }
  }

  return {
    media_url: publicUrl,
    media_type: normalizedType,
    media_mime_type: mime_type,
    caption: mediaObj.caption ?? null,
    transcript,
    extracted_text,
    filename: mediaObj.filename ?? null,
  };
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.object !== "whatsapp_business_account") {
    return Response.json({ status: "ignored" });
  }

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  // Delivery status updates (sent/delivered/read/failed) for outbound messages
  const statuses = value?.statuses as
    | Array<{ id: string; status: string; timestamp: string }>
    | undefined;
  if (statuses?.length) {
    await Promise.all(
      statuses.map(async (s) => {
        if (!["sent", "delivered", "read", "failed"].includes(s.status)) return;
        const ts = new Date(parseInt(s.timestamp) * 1000).toISOString();
        await supabase
          .from("messages")
          .update({ status: s.status, status_updated_at: ts })
          .eq("whatsapp_msg_id", s.id);
      })
    );
    return Response.json({ status: "status_updated", count: statuses.length });
  }

  if (!value?.messages?.[0]) {
    return Response.json({ status: "no_message" });
  }

  const message = value.messages[0];
  const contact = value.contacts?.[0];

  const supportedTypes = ["text", "image", "audio", "voice", "document"];
  if (!supportedTypes.includes(message.type)) {
    return Response.json({ status: "unsupported_type", type: message.type });
  }

  const phone = message.from;
  const name = contact?.profile?.name || null;
  const whatsappMsgId = message.id;

  try {
    let { data: conversation } = await supabase
      .from("conversations")
      .select("*")
      .eq("phone", phone)
      .single();

    if (!conversation) {
      const { data: newConvo } = await supabase
        .from("conversations")
        .insert({ phone, name })
        .select()
        .single();
      conversation = newConvo;
    } else if (name && name !== conversation.name) {
      await supabase
        .from("conversations")
        .update({ name })
        .eq("id", conversation.id);
    }

    if (!conversation) {
      return Response.json(
        { error: "Failed to create conversation" },
        { status: 500 }
      );
    }

    let userText: string | null = null;
    let media: IncomingMedia = NO_MEDIA;

    if (message.type === "text") {
      userText = message.text.body;
    } else {
      media = await persistInboundMedia(message);
      if (media.media_type === "audio" && media.transcript) {
        userText = media.transcript;
      } else if (media.media_type === "document" && media.extracted_text) {
        const header = media.filename ? `[Document: ${media.filename}]\n` : "";
        userText = header + media.extracted_text;
      } else {
        userText = media.caption;
      }
    }

    const { error: insertError } = await supabase.from("messages").insert({
      conversation_id: conversation.id,
      role: "user",
      content: userText,
      whatsapp_msg_id: whatsappMsgId,
      media_url: media.media_url,
      media_type: media.media_type,
      media_mime_type: media.media_mime_type,
      media_caption: media.caption,
      transcript: media.transcript,
    });

    if (insertError?.code === "23505") {
      return Response.json({ status: "duplicate" });
    }

    await supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    if (conversation.mode === "human") {
      return Response.json({ status: "stored_for_human" });
    }

    // Show "typing..." in WhatsApp while AI generates (lasts up to 25s)
    sendTypingIndicator(whatsappMsgId).catch((err) =>
      console.error("typing indicator error", err)
    );

    const { data: history } = await supabase
      .from("messages")
      .select("role, content, media_url, media_type, created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(10);

    const aiMessages: AIMessage[] = (history || [])
      .slice()
      .reverse()
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        media_url: m.media_url,
        media_type: m.media_type,
      }));

    const aiResponse = await getAIResponse(aiMessages, {
      conversationId: conversation.id,
    });

    const sendResult = await sendWhatsAppMessage(phone, aiResponse);
    const outboundMsgId: string | null = sendResult?.messages?.[0]?.id ?? null;

    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: aiResponse,
      whatsapp_msg_id: outboundMsgId,
      status: outboundMsgId ? "sent" : null,
      sent_by_ai: true,
    });

    await supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    return Response.json({ status: "replied" });
  } catch (error) {
    console.error("Webhook error:", error);
    return Response.json({ status: "error" }, { status: 500 });
  }
}
