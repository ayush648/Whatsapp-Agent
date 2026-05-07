export interface Conversation {
  id: string;
  phone: string;
  name: string | null;
  mode: "agent" | "human";
  updated_at: string;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string | null;
  whatsapp_msg_id: string | null;
  created_at: string;
  media_url: string | null;
  media_type: "image" | "audio" | "video" | "document" | "sticker" | null;
  media_mime_type: string | null;
  transcript: string | null;
}

export interface ConversationWithLastMessage extends Conversation {
  last_message: string | null;
}
