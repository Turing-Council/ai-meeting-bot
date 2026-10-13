import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseForm, startFakeServer } from '../test-utils/http-server.js';
import { OpenAiCompatibleSttProvider, toSegments } from './openai-compatible.js';

describe('OpenAiCompatibleSttProvider', () => {
  let dir: string;
  let audio: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tvb-stt-'));
    audio = path.join(dir, 'u1-0-5000.ogg');
    await writeFile(audio, Buffer.from('OggS fake audio'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const options = { apiKey: 'secret', model: 'whisper-large', language: 'en', responseFormat: 'verbose_json' as const, backoffMs: 1 };

  it('uploads the chunk as multipart and maps segment timestamps to ms', async () => {
    const server = await startFakeServer(() => ({
      body: {
        text: 'Hello there. Next item.',
        segments: [
          { start: 0.5, end: 1.5, text: ' Hello there.', no_speech_prob: 0.01, avg_logprob: -0.2 },
          { start: 2, end: 9, text: ' Next item.', no_speech_prob: 0.02, avg_logprob: -0.3 },
        ],
      },
    }));
    try {
      const stt = new OpenAiCompatibleSttProvider({ ...options, baseUrl: `${server.baseUrl}/` });
      const segments = await stt.transcribe({ file: audio, durationMs: 5000, prompt: 'Meeting: Sync.' });

      expect(segments).toEqual([
        { startMs: 500, endMs: 1500, text: 'Hello there.' },
        { startMs: 2000, endMs: 5000, text: 'Next item.' }, // clamped to the chunk
      ]);
      const [request] = server.requests;
      expect(request?.url).toBe('/v1/audio/transcriptions');
      expect(request?.headers.authorization).toBe('Bearer secret');
      const form = await parseForm(request!);
      expect(form.get('model')).toBe('whisper-large');
      expect(form.get('language')).toBe('en');
      expect(form.get('response_format')).toBe('verbose_json');
      expect(form.getAll('timestamp_granularities[]')).toEqual(['segment']);
      expect(form.get('prompt')).toBe('Meeting: Sync.');
      const file = form.get('file') as File;
      expect(file.name).toBe('u1-0-5000.ogg');
      expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('OggS fake audio');
    } finally {
      await server.close();
    }
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const server = await startFakeServer((_, i) =>
      i === 0
        ? { status: 429, headers: { 'Retry-After': '0' }, body: { error: 'slow down' } }
        : i === 1
          ? { status: 503, body: 'unavailable' }
          : { body: { text: 'ok' } },
    );
    try {
      const stt = new OpenAiCompatibleSttProvider({ ...options, baseUrl: server.baseUrl, responseFormat: 'json' });
      expect(await stt.transcribe({ file: audio, durationMs: 5000 })).toEqual([{ startMs: 0, endMs: 5000, text: 'ok' }]);
      expect(server.requests).toHaveLength(3);
      const form = await parseForm(server.requests[2]!);
      expect(form.has('timestamp_granularities[]')).toBe(false);
      expect(server.requests[2]?.headers.authorization).toBe('Bearer secret');
    } finally {
      await server.close();
    }
  });

  it('fails fast on errors a retry will not fix', async () => {
    const server = await startFakeServer(() => ({ status: 401, body: { error: { message: 'Invalid API key' } } }));
    try {
      const stt = new OpenAiCompatibleSttProvider({ ...options, baseUrl: server.baseUrl, apiKey: undefined });
      await expect(stt.transcribe({ file: audio, durationMs: 5000 })).rejects.toThrow(/401.*Invalid API key/);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.headers.authorization).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('toSegments', () => {
  it('drops likely hallucinations and empty text', () => {
    expect(
      toSegments(
        {
          text: '',
          segments: [
            { start: 0, end: 2, text: ' Thank you.', no_speech_prob: 0.9, avg_logprob: -1.4 },
            { start: 2, end: 3, text: '  ' },
            { start: 3, end: 4, text: ' Real words', no_speech_prob: 0.9, avg_logprob: -0.3 },
          ],
        },
        5000,
      ),
    ).toEqual([{ startMs: 3000, endMs: 4000, text: 'Real words' }]);
  });

  it('uses the whole text when there are no segments', () => {
    expect(toSegments({ text: '  ' }, 5000)).toEqual([]);
    expect(toSegments({ text: 'Hi' }, 5000)).toEqual([{ startMs: 0, endMs: 5000, text: 'Hi' }]);
  });
});
