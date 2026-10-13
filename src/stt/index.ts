import type { SttConfig } from '../config.js';
import { MockSttProvider } from './mock.js';
import { OpenAiCompatibleSttProvider } from './openai-compatible.js';
import type { SttProvider } from './types.js';

export type { SttProvider, SttSegment, TranscribeRequest } from './types.js';

/** The configured speech-to-text provider, or undefined when transcription is off. */
export function createSttProvider(config: SttConfig): SttProvider | undefined {
  switch (config.provider) {
    case 'none':
      return undefined;
    case 'mock':
      return new MockSttProvider();
    case 'openai-compatible':
      return new OpenAiCompatibleSttProvider(config);
  }
}
