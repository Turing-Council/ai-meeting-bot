import { describe, expect, it } from 'vitest';
import { startFakeServer } from '../test-utils/http-server.js';
import { OpenAiCompatibleChatModel } from './openai-compatible.js';

const reply = (content: string | null) => ({ body: { choices: [{ message: { role: 'assistant', content } }] } });

describe('OpenAiCompatibleChatModel', () => {
  it('posts chat messages and returns the reply text', async () => {
    const server = await startFakeServer(() => reply('{"tldr":"x"}'));
    try {
      const model = new OpenAiCompatibleChatModel({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm', jsonMode: 'json_object', temperature: 0.2 });
      const messages = [
        { role: 'system' as const, content: 'sys' },
        { role: 'user' as const, content: 'hi' },
      ];
      expect(await model.complete(messages, { json: true })).toBe('{"tldr":"x"}');

      const request = server.requests[0]!;
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBe('Bearer k');
      expect(JSON.parse(request.body.toString())).toEqual({
        model: 'm',
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });
    } finally {
      await server.close();
    }
  });

  it('leaves out optional parameters the server may not support', async () => {
    const server = await startFakeServer(() => reply('text'));
    try {
      const model = new OpenAiCompatibleChatModel({ baseUrl: server.baseUrl, apiKey: undefined, model: 'm', jsonMode: 'none' });
      await model.complete([{ role: 'user', content: 'hi' }], { json: true });
      const body = JSON.parse(server.requests[0]!.body.toString()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['messages', 'model']);
    } finally {
      await server.close();
    }
  });

  it('rejects empty or malformed replies', async () => {
    const server = await startFakeServer((_, i) => (i === 0 ? reply(null) : { body: { nope: true } }));
    try {
      const model = new OpenAiCompatibleChatModel({ baseUrl: server.baseUrl, apiKey: undefined, model: 'm', jsonMode: 'none' });
      await expect(model.complete([{ role: 'user', content: 'hi' }], { json: false })).rejects.toThrow(/empty reply/);
      await expect(model.complete([{ role: 'user', content: 'hi' }], { json: false })).rejects.toThrow(/Unexpected chat completion/);
    } finally {
      await server.close();
    }
  });
});
