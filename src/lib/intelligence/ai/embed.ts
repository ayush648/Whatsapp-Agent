import OpenAI from "openai";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for embeddings (text-embedding-3-small). " +
        "Set it in .env.local — OpenRouter doesn't proxy OpenAI's embeddings API."
    );
  }
  client = new OpenAI({ apiKey });
  return client;
}

const MODEL = "text-embedding-3-small";
const DIM = 1536; // matches ai_memory_chunks.embedding vector(1536)

export async function embed(text: string): Promise<number[]> {
  const r = await getClient().embeddings.create({
    model: MODEL,
    input: text,
  });
  const vec = r.data[0]?.embedding;
  if (!vec || vec.length !== DIM) {
    throw new Error(`embedding returned ${vec?.length ?? 0} dims, expected ${DIM}`);
  }
  return vec;
}

export const EMBEDDING_MODEL = MODEL;
export const EMBEDDING_DIM = DIM;
