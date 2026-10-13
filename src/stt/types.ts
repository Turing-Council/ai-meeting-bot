/** A piece of recognized speech, in ms relative to the start of the audio file that was sent. */
export interface SttSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscribeRequest {
  /** Path of a short audio file (one speaker, one stretch of speech). */
  file: string;
  durationMs: number;
  /** Vocabulary hint, e.g. the meeting title and participant names. */
  prompt?: string | undefined;
}

/** Speech-to-text, behind one small interface so any provider (cloud or self-hosted) can be plugged in. */
export interface SttProvider {
  readonly name: string;
  transcribe(request: TranscribeRequest): Promise<SttSegment[]>;
}
