import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { VoiceReceiver } from '@discordjs/voice';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { parseOggPages } from '../test-utils/ogg-reader.js';
import { OPUS_SILENCE_FRAME } from './opus.js';
import { MeetingRecorder } from './recorder.js';

const voice = (marker: number) => Buffer.from([0xfc, marker, marker]);
const isSilence = (p: Buffer) => p.equals(OPUS_SILENCE_FRAME);

/** Stand-in for @discordjs/voice's VoiceReceiver: a speaking emitter plus per-user packet streams. */
function fakeReceiver() {
  const speaking = Object.assign(new EventEmitter(), { users: new Map<string, number>() });
  const subscriptions = new Map<string, PassThrough>();
  let subscribeCalls = 0;
  const receiver = {
    speaking,
    subscribe(userId: string) {
      subscribeCalls++;
      const existing = subscriptions.get(userId);
      if (existing) return existing;
      const stream = new PassThrough({ objectMode: true });
      stream.once('close', () => subscriptions.delete(userId));
      subscriptions.set(userId, stream);
      return stream;
    },
  };
  return {
    receiver: receiver as unknown as VoiceReceiver,
    speak: (userId: string) => speaking.emit('start', userId),
    send: (userId: string, packet: Buffer) => subscriptions.get(userId)!.write(packet),
    stream: (userId: string) => subscriptions.get(userId),
    subscribeCalls: () => subscribeCalls,
  };
}

// Let PassThrough deliver queued 'data' events.
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('MeetingRecorder', () => {
  let dir: string;
  let clock: number;
  const START = 1_000_000;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tvb-rec-'));
    await mkdir(path.join(dir, 'tracks'));
    clock = START;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const readTrack = async (userId: string) =>
    parseOggPages(await readFile(path.join(dir, 'tracks', `${userId}.ogg`)))
      .slice(2)
      .flatMap((p) => p.packets);

  function create(fake: ReturnType<typeof fakeReceiver>, extra: Partial<ConstructorParameters<typeof MeetingRecorder>[0]> = {}) {
    const speakers: string[] = [];
    const recorder = new MeetingRecorder({
      receiver: fake.receiver,
      sessionDir: dir,
      sessionStartMs: START,
      logger: silentLogger,
      now: () => clock,
      onNewSpeaker: (userId, file) => speakers.push(`${userId}:${file}`),
      ...extra,
    });
    return { recorder, speakers };
  }

  it('hands every received packet to onPacket, except while paused', async () => {
    const fake = fakeReceiver();
    const seen: string[] = [];
    const { recorder } = create(fake, { onPacket: (userId, packet, atMs) => seen.push(`${userId}:${packet[1]}@${atMs}`) });
    recorder.start();

    clock = START + 1000;
    fake.speak('alice');
    fake.send('alice', voice(1));
    await tick();
    recorder.setPaused(true);
    fake.send('alice', voice(2));
    await tick();
    recorder.setPaused(false);
    clock = START + 2000;
    fake.send('alice', voice(3));
    await tick();
    await recorder.stop(START + 3000);

    expect(seen).toEqual([`alice:1@${START + 1000}`, `alice:3@${START + 2000}`]);
  });

  it('writes one aligned Ogg file per speaker', async () => {
    const fake = fakeReceiver();
    const { recorder, speakers } = create(fake);
    recorder.start();

    clock = START + 1000;
    fake.speak('alice');
    fake.send('alice', voice(1));
    clock = START + 2000;
    fake.speak('bob');
    fake.send('bob', voice(2));
    await tick();
    await recorder.stop(START + 3000);

    expect(speakers).toEqual(['alice:tracks/alice.ogg', 'bob:tracks/bob.ogg']);
    const alice = await readTrack('alice');
    const bob = await readTrack('bob');
    expect(alice).toHaveLength(150); // padded to 3 s
    expect(bob).toHaveLength(150);
    expect(alice.findIndex((p) => !isSilence(p))).toBe(49);
    expect(bob.findIndex((p) => !isSilence(p))).toBe(99);
  });

  it('drops audio while paused (it becomes silence)', async () => {
    const fake = fakeReceiver();
    const { recorder } = create(fake);
    recorder.start();
    fake.speak('alice');

    clock = START + 20;
    fake.send('alice', voice(1));
    await tick();
    recorder.setPaused(true);
    clock = START + 40;
    fake.send('alice', voice(2));
    await tick();
    recorder.setPaused(false);
    clock = START + 60;
    fake.send('alice', voice(3));
    await tick();
    await recorder.stop(START + 60);

    const packets = await readTrack('alice');
    expect(packets.filter((p) => !isSilence(p))).toEqual([voice(1), voice(3)]);
  });

  it('resubscribes when a stream breaks, keeping the same track file', async () => {
    const fake = fakeReceiver();
    const { recorder, speakers } = create(fake);
    recorder.start();
    fake.speak('alice');
    clock = START + 20;
    fake.send('alice', voice(1));
    await tick();

    fake.stream('alice')!.destroy(new Error('decrypt failed'));
    await tick();
    fake.speak('alice');
    expect(fake.subscribeCalls()).toBe(2);
    clock = START + 40;
    fake.send('alice', voice(2));
    await tick();
    await recorder.stop(START + 40);

    expect(speakers).toHaveLength(1);
    expect(await readTrack('alice')).toEqual([voice(1), voice(2)]);
  });

  it('skips users rejected by shouldRecord and picks up people already talking', async () => {
    const fake = fakeReceiver();
    (fake.receiver.speaking.users as Map<string, number>).set('alice', START);
    const { recorder, speakers } = create(fake, { shouldRecord: (id) => id !== 'musicbot' });
    recorder.start();
    fake.speak('musicbot');
    expect(fake.stream('musicbot')).toBeUndefined();
    expect(fake.stream('alice')).toBeDefined();
    await recorder.stop(START);
    expect(speakers).toEqual(['alice:tracks/alice.ogg']);
  });

  it('ignores speaking events after stop and stop is idempotent', async () => {
    const fake = fakeReceiver();
    const { recorder } = create(fake);
    recorder.start();
    await recorder.stop(START);
    await recorder.stop(START);
    fake.speak('alice');
    expect(fake.subscribeCalls()).toBe(0);
  });
});
