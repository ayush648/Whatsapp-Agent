export type LLMRole = "system" | "user" | "assistant";

export type LLMMessage = {
  role: LLMRole;
  content: string;
};

export type LLMCallParams = {
  model: string;
  messages: LLMMessage[];
  responseFormat?: "json" | "text";
  temperature?: number;
  maxTokens?: number;
};

export type LLMCallResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string;
};

export interface LLMProvider {
  readonly name: string;
  call(params: LLMCallParams): Promise<LLMCallResult>;
}
