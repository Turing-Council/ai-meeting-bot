import { describe, expect, it } from 'vitest';
import { buildMixdownArgs } from './mixdown.js';

describe('buildMixdownArgs', () => {
  it('re-encodes a single track without a filter graph', () => {
    const args = buildMixdownArgs(['a.ogg'], 'out.ogg');
    expect(args).toEqual([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', 'a.ogg',
      '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-application', 'voip',
      'out.ogg',
    ]);
  });

  it('mixes several tracks with amix and a limiter', () => {
    const args = buildMixdownArgs(['a.ogg', 'b.ogg', 'c.ogg'], 'out.ogg', 96);
    expect(args.filter((a) => a === '-i')).toHaveLength(3);
    expect(args).toContain('amix=inputs=3:duration=longest:normalize=0,alimiter=limit=0.95');
    expect(args).toContain('96k');
    expect(args.at(-1)).toBe('out.ogg');
  });

  it('refuses to build a command with no inputs', () => {
    expect(() => buildMixdownArgs([], 'out.ogg')).toThrow();
  });
});
