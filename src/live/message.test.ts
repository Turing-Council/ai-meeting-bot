import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendableChannels } from 'discord.js';
import { silentLogger } from '../logger.js';
import { LiveMessage } from './message.js';

const line = (startMs: number, text: string) => ({ speakerId: 'a', speaker: 'Alice', startMs, endMs: startMs + 1000, text });

describe('LiveMessage', () => {
  let posted: string[];
  let edits: string[];
  const channel = {
    send: async (options: { content: string; allowedMentions: unknown }) => {
      posted.push(options.content);
      expect(options.allowedMentions).toEqual({ parse: [] });
      return { edit: async (o: { content: string }) => void edits.push(o.content) };
    },
  } as unknown as SendableChannels;

  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    edits = [];
  });
  afterEach(() => vi.useRealTimers());

  it('posts once, then edits at most every few seconds with the newest lines', async () => {
    const message = new LiveMessage(silentLogger, 3_000);
    await message.attach(channel);
    expect(posted).toHaveLength(1);

    message.add(line(1_000, 'Hello'));
    message.add(line(5_000, 'World'));
    expect(edits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('[00:01] Alice: Hello');
    expect(edits[0]).toContain('[00:05] Alice: World');
  });

  it('keeps lines that arrived before the message was posted', async () => {
    const message = new LiveMessage(silentLogger, 3_000);
    message.add(line(1_000, 'Early'));
    await message.attach(channel);
    expect(posted[0]).toContain('Early');
  });

  it('shows only the newest lines that fit in a Discord message', async () => {
    const message = new LiveMessage(silentLogger, 3_000);
    await message.attach(channel);
    for (let i = 0; i < 100; i++) message.add(line(i * 1_000, `sentence number ${i} `.repeat(3)));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(edits[0]!.length).toBeLessThanOrEqual(2_000);
    expect(edits[0]).toContain('sentence number 99');
    expect(edits[0]).not.toContain('sentence number 0 ');
  });

  it('finish() flushes right away and marks the transcript as ended', async () => {
    const message = new LiveMessage(silentLogger, 3_000);
    await message.attach(channel);
    message.add(line(1_000, 'Bye'));
    await message.finish();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('Bye');
    expect(edits[0]).toMatch(/ended/i);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(edits).toHaveLength(1);
  });

  it('never throws when Discord refuses', async () => {
    const message = new LiveMessage(silentLogger, 3_000);
    await message.attach({ send: async () => Promise.reject(new Error('Missing Permissions')) } as unknown as SendableChannels);
    message.add(line(0, 'x'));
    await vi.advanceTimersByTimeAsync(3_000);
    await message.finish();
  });
});
