export async function getMediaInfo(mediaId: string): Promise<{
  url: string;
  mime_type: string;
}> {
  const res = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("WhatsApp getMediaInfo failed", res.status, data);
    throw new Error(
      `WhatsApp media lookup ${res.status}: ${data?.error?.message ?? "unknown error"}`
    );
  }
  return { url: data.url, mime_type: data.mime_type };
}

export async function downloadMedia(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`WhatsApp media download failed: ${res.status}`);
  }
  return res.arrayBuffer();
}

export async function sendTypingIndicator(messageId: string) {
  const res = await fetch(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error("WhatsApp typing indicator failed", res.status, data);
  }
}

export async function markAsRead(messageId: string) {
  const res = await fetch(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error("WhatsApp markAsRead failed", res.status, data);
  }
}

type WhatsAppMediaKind = "image" | "audio" | "video" | "document";

export async function sendWhatsAppMedia(
  to: string,
  kind: WhatsAppMediaKind,
  link: string,
  opts?: { caption?: string; filename?: string }
) {
  const mediaPayload: Record<string, string> = { link };
  if (opts?.caption && (kind === "image" || kind === "video" || kind === "document")) {
    mediaPayload.caption = opts.caption;
  }
  if (opts?.filename && kind === "document") {
    mediaPayload.filename = opts.filename;
  }
  const res = await fetch(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: kind,
        [kind]: mediaPayload,
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error("WhatsApp media send failed", res.status, data);
    throw new Error(
      `WhatsApp media ${res.status}: ${data?.error?.message ?? "unknown error"}`
    );
  }
  return data;
}

export async function sendWhatsAppMessage(to: string, body: string) {
  const res = await fetch(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error("WhatsApp send failed", res.status, data);
    throw new Error(
      `WhatsApp API ${res.status}: ${data?.error?.message ?? "unknown error"}`
    );
  }
  return data;
}
