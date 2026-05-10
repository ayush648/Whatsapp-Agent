import OpenAI from "openai";
import type { LLMProvider, LLMCallParams, LLMCallResult } from "./types";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Add it to .env.local for the intel layer LLM calls."
    );
  }
  client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
  return client;
}

export const openrouter: LLMProvider = {
  name: "openrouter",
  async call(params: LLMCallParams): Promise<LLMCallResult> {
    const c = getClient();
    const resp = await c.chat.completions.create({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.2,
      max_tokens: params.maxTokens,
      response_format:
        params.responseFormat === "text" ? undefined : { type: "json_object" },
    });
    const choice = resp.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
      modelUsed: resp.model ?? params.model,
    };
  },
};
