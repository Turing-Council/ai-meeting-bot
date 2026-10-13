import { describe, expect, it } from 'vitest';
import type { SessionManifest } from '../sessions/manifest.js';
import { mergeSegments, renderTranscriptMarkdown, transcriptLines, type TranscriptSegment } from './transcript.js';

const alice = (startMs: number, endMs: number, text: string): TranscriptSegment => ({ speakerId: 'u1', speaker: 'Alice', startMs, endMs, text });
const bob = (startMs: number, endMs: number, text: string): TranscriptSegment => ({ speakerId: 'u2', speaker: 'Bob', startMs, endMs, text });

describe('mergeSegments', () => {
  it('interleaves speakers by time and joins consecutive lines into turns', () => {
    const turns = mergeSegments([
      bob(6_000, 8_000, 'Sounds good.'),
      alice(0, 2_000, 'Hi all.'),
      alice(3_000, 5_000, ' Let us start. '),
      alice(20_000, 22_000, 'Next topic.'), // > 3 s after her last line: new turn
      bob(9_000, 9_500, '   '),
    ]);
    expect(turns).toEqual([
      alice(0, 5_000, 'Hi all. Let us start.'),
      bob(6_000, 8_000, 'Sounds good.'),
      alice(20_000, 22_000, 'Next topic.'),
    ]);
    expect(transcriptLines(turns)).toEqual(['[00:00] Alice: Hi all. Let us start.', '[00:06] Bob: Sounds good.', '[00:20] Alice: Next topic.']);
  });

  it('starts a new turn when one would run too long', () => {
    const lines = Array.from({ length: 70 }, (_, i) => alice(i * 2_000, i * 2_000 + 1_900, `line ${i}`));
    expect(mergeSegments(lines).length).toBeGreaterThan(1);
  });
});

describe('renderTranscriptMarkdown', () => {
  it('adds a header and one paragraph per turn', () => {
    const manifest = {
      title: 'Weekly sync',
      startedAt: '2026-10-13T14:00:00.000Z',
      voiceChannelName: 'General',
      participants: [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
      ],
    } as SessionManifest;
    const md = renderTranscriptMarkdown(manifest, [alice(0, 2_000, 'Hi.'), bob(3_723_000, 3_724_000, 'Bye.')]);
    expect(md).toContain('# Weekly sync');
    expect(md).toContain('- **Date:** 2026-10-13 14:00 UTC');
    expect(md).toContain('- **Participants:** Alice, Bob');
    expect(md).toContain('**[00:00] Alice:** Hi.\n');
    expect(md).toContain('**[01:02:03] Bob:** Bye.\n');
    expect(renderTranscriptMarkdown(manifest, [])).toContain('_No speech was transcribed._');
  });
});
