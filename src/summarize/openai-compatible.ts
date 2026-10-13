import { z } from 'zod';
import { authHeaders, joinUrl, postJson, ProviderError } from '../http.js';
import type { ChatMessage, ChatModel, CompleteOptions } from './types.js';

export interface OpenAiCompatibleChatOptions {
  /** e.g. `https://api.example.com/v1` or `http://ollama:11434/v1` */
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** `json_object` sets `response_format`; use `none` for servers that reject it. */
  jsonMode: 'json_object' | 'none';
  temperature?: number | undefined;
  timeoutMs?: number;
  backoffMs?: number;
}

const ChatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

/**
 * `POST /chat/completions`, the de facto standard chat API: most hosted LLM services,
 * routers and self-hosted servers (Ollama, vLLM, LM Studio, llama.cpp…) speak it.
 */
export class OpenAiCompatibleChatModel implements ChatModel {
  readonly name = 'openai-compatible';

  constructor(private readonly options: OpenAiCompatibleChatOptions) {}

  async complete(messages: ChatMessage[], { json }: CompleteOptions): Promise<string> {
    const { baseUrl, apiKey, model, jsonMode, temperature } = this.options;
    const body = {
      model,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(json && jsonMode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
    };
    const raw = await postJson(joinUrl(baseUrl, 'chat/completions'), {
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      timeoutMs: this.options.timeoutMs,
      backoffMs: this.options.backoffMs,
      body: () => JSON.stringify(body),
    });
    const parsed = ChatResponse.safeParse(raw);
    if (!parsed.success) throw new ProviderError(`Unexpected chat completion response: ${parsed.error.message}`);
    const content = parsed.data.choices[0]?.message.content;
    if (!content) throw new ProviderError('The model returned an empty reply');
    return content;
  }
}
