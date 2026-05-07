import { supabase } from "./supabase";

export const MEDIA_BUCKET = "whatsapp-media";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime] || mime.split("/")[1] || "bin";
}

export async function uploadMedia(
  buffer: ArrayBuffer,
  mimeType: string
): Promise<string> {
  const ext = extFromMime(mimeType);
  const filename = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(filename, buffer, { contentType: mimeType, upsert: false });
  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }
  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}
