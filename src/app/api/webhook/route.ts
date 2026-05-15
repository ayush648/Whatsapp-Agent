import { NextRequest, after } from "next/server";
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

// Don't auto-reply to messages older than this. Meta re-delivers a backlog of
// queued messages after an outage/retry; replying to all of them looks like
// the bot is sending messages on its own.
const STALE_REPLY_CUTOFF_MS = 10 * 60_000;

type IncomingMessage = Record<string, unknown> & {
  from: string;
  id: string;
  type: string;
  timestamp?: string;
  text?: { body: string };
};

type Contact = { profile?: { name?: string } } | undefined;

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
    after(async () => {
      await Promise.all(
        statuses.map(async (s) => {
          if (!["sent", "delivered", "read", "failed"].includes(s.status))
            return;
          const ts = new Date(parseInt(s.timestamp) * 1000).toISOString();
          await supabase
            .from("messages")
            .update({ status: s.status, status_updated_at: ts })
            .eq("whatsapp_msg_id", s.id);
        })
      );
    });
    return Response.json({ status: "status_accepted" });
  }

  const messages = value?.messages as IncomingMessage[] | undefined;
  if (!messages?.length) {
    return Response.json({ status: "no_message" });
  }

  const contact = value.contacts?.[0] as Contact;

  // Respond 200 to Meta NOW, then process every message in the batch after the
  // response is sent. Processing inline delays the 200 past Meta's webhook
  // timeout, which makes Meta retry and re-deliver a backlog of stale messages.
  after(async () => {
    for (const message of messages) {
      try {
        await handleInboundMessage(message, contact);
      } catch (err) {
        console.error("Webhook processing error:", err);
      }
    }
  });

  return Response.json({ status: "accepted", count: messages.length });
}

async function handleInboundMessage(
  message: IncomingMessage,
  contact: Contact
): Promise<void> {
  const supportedTypes = ["text", "image", "audio", "voice", "document"];
  if (!supportedTypes.includes(message.type)) {
    console.log(`[webhook] unsupported type '${message.type}' — skipping`);
    return;
  }

  const phone = message.from;
  const name = contact?.profile?.name || null;
  const whatsappMsgId = message.id;

  // The real time the customer sent the message — not when we process it.
  const sentAt = message.timestamp
    ? new Date(parseInt(message.timestamp) * 1000)
    : new Date();

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
    console.error("[webhook] failed to create conversation for", phone);
    return;
  }

  let userText: string | null = null;
  let media: IncomingMedia = NO_MEDIA;

  if (message.type === "text") {
    userText = message.text?.body ?? null;
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

  // Store with the real send-time so the dashboard shows correct timestamps
  // and a re-delivered backlog message sorts into the right place.
  const { error: insertError } = await supabase.from("messages").insert({
    conversation_id: conversation.id,
    role: "user",
    content: userText,
    whatsapp_msg_id: whatsappMsgId,
    created_at: sentAt.toISOString(),
    media_url: media.media_url,
    media_type: media.media_type,
    media_mime_type: media.media_mime_type,
    media_caption: media.caption,
    transcript: media.transcript,
  });

  if (insertError) {
    // 23505 = unique violation on whatsapp_msg_id → Meta re-delivered a
    // message we already stored. Any other error means the message was not
    // stored, so don't reply to it either.
    if (insertError.code === "23505") {
      console.log(`[webhook] duplicate ${whatsappMsgId} — skipping`);
    } else {
      console.error("[webhook] store failed:", insertError.message);
    }
    return;
  }

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversation.id);

  if (conversation.mode === "human") {
    return; // a human handles the reply
  }

  // Skip the AI reply for an old message re-delivered by Meta after an
  // outage/retry. It is already stored above; we just don't auto-respond.
  const ageMs = Date.now() - sentAt.getTime();
  if (ageMs > STALE_REPLY_CUTOFF_MS) {
    console.log(
      `[webhook] ${whatsappMsgId} is ${Math.round(ageMs / 60000)}min old — stored, skipping AI reply`
    );
    return;
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
}
