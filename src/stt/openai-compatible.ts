import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { authHeaders, joinUrl, postJson, ProviderError } from '../http.js';
import type { SttProvider, SttSegment, TranscribeRequest } from './types.js';

export interface OpenAiCompatibleSttOptions {
  /** e.g. `https://api.example.com/v1` or `http://whisper:8000/v1` */
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  language: string;
  /** `verbose_json` gives per-segment timestamps; some models only support `json`. */
  responseFormat: 'verbose_json' | 'json';
  timeoutMs?: number;
  backoffMs?: number;
}

const TranscriptionResponse = z.object({
  text: z.string().default(''),
  segments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
        no_speech_prob: z.number().optional(),
        avg_logprob: z.number().optional(),
      }),
    )
    .optional(),
});

/**
 * Whisper-style `POST /audio/transcriptions` (multipart). This is the de facto standard API:
 * hosted services and self-hosted servers (faster-whisper, whisper.cpp, LocalAI…) speak it.
 */
export class OpenAiCompatibleSttProvider implements SttProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly options: OpenAiCompatibleSttOptions) {}

  async transcribe(request: TranscribeRequest): Promise<SttSegment[]> {
    const { baseUrl, apiKey, model, language, responseFormat } = this.options;
    const audio = await openAsBlob(request.file, { type: 'audio/ogg' });

    const raw = await postJson(joinUrl(baseUrl, 'audio/transcriptions'), {
      headers: authHeaders(apiKey),
      timeoutMs: this.options.timeoutMs,
      backoffMs: this.options.backoffMs,
      body: () => {
        const form = new FormData();
        form.set('file', audio, path.basename(request.file));
        form.set('model', model);
        form.set('language', language);
        form.set('response_format', responseFormat);
        form.set('temperature', '0');
        if (responseFormat === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
        if (request.prompt) form.set('prompt', request.prompt);
        return form;
      },
    });

    const parsed = TranscriptionResponse.safeParse(raw);
    if (!parsed.success) throw new ProviderError(`Unexpected transcription response: ${parsed.error.message}`);
    return toSegments(parsed.data, request.durationMs);
  }
}

/** Uses per-segment timestamps when present, else the whole text as one segment. Drops likely hallucinations. */
export function toSegments(response: z.infer<typeof TranscriptionResponse>, durationMs: number): SttSegment[] {
  const clamp = (ms: number) => Math.min(Math.max(Math.round(ms), 0), durationMs);

  if (!response.segments) {
    const text = response.text.trim();
    return text ? [{ startMs: 0, endMs: durationMs, text }] : [];
  }
  return response.segments
    .filter((s) => !isLikelyHallucination(s))
    .map((s) => ({ startMs: clamp(s.start * 1000), endMs: clamp(s.end * 1000), text: s.text.trim() }))
    .filter((s) => s.text.length > 0);
}

/** Whisper's own heuristic: probably no speech and low confidence → made-up text ("Thank you."). */
function isLikelyHallucination(segment: { no_speech_prob?: number | undefined; avg_logprob?: number | undefined }): boolean {
  return (segment.no_speech_prob ?? 0) > 0.6 && (segment.avg_logprob ?? 0) < -1;
}
