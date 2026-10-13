export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  /** Ask the model for a JSON object (when the provider supports it). */
  json: boolean;
}

/** A chat-style LLM, behind one small interface so any provider (cloud or self-hosted) can be plugged in. */
export interface ChatModel {
  readonly name: string;
  complete(messages: ChatMessage[], options: CompleteOptions): Promise<string>;
}
