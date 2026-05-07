import OpenAI from "openai";

let _client: OpenAI | null = null;
function client() {
  if (!_client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

const MIME_TO_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
};

export async function transcribeAudio(
  buffer: ArrayBuffer,
  mimeType: string
): Promise<string> {
  const ext = MIME_TO_EXT[mimeType] || "ogg";
  const file = new File([buffer], `audio.${ext}`, { type: mimeType });
  const result = await client().audio.transcriptions.create({
    file,
    model: "whisper-1",
  });
  return result.text;
}
