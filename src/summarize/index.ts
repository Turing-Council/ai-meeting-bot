import type { LlmConfig } from '../config.js';
import { MockChatModel } from './mock.js';
import { OpenAiCompatibleChatModel } from './openai-compatible.js';
import type { ChatModel } from './types.js';

export type { ChatMessage, ChatModel } from './types.js';

/** The configured LLM, or undefined when summaries are off. */
export function createChatModel(config: LlmConfig): ChatModel | undefined {
  switch (config.provider) {
    case 'none':
      return undefined;
    case 'mock':
      return new MockChatModel();
    case 'openai-compatible':
      return new OpenAiCompatibleChatModel(config);
  }
}
