import type { ChatMessage, ChatModel } from './types.js';

/** Offline model for development: a fixed, valid summary that says how much text it was given. */
export class MockChatModel implements ChatModel {
  readonly name = 'mock';

  async complete(messages: ChatMessage[]): Promise<string> {
    const input = messages.at(-1)?.content ?? '';
    const lines = input.split('\n').filter((line) => /^\[[\d:]+\] /.test(line)).length;
    return JSON.stringify({
      tldr: `Mock summary of ${lines} transcript line(s).`,
      keyPoints: ['This summary was produced by the mock LLM provider.'],
      decisions: [],
      actionItems: [{ task: 'Configure a real LLM provider', owner: null, due: null }],
      openQuestions: [],
    });
  }
}
