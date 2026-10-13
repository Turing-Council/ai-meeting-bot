import type { SttProvider, SttSegment, TranscribeRequest } from './types.js';

/** Offline provider for development: one placeholder segment per chunk, no network. */
export class MockSttProvider implements SttProvider {
  readonly name = 'mock';

  async transcribe(request: TranscribeRequest): Promise<SttSegment[]> {
    const seconds = (request.durationMs / 1000).toFixed(1);
    return [{ startMs: 0, endMs: request.durationMs, text: `(mock transcript of ${seconds} s of speech)` }];
  }
}
