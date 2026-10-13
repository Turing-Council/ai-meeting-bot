import { describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { extractJsonObject } from './json.js';
import { parseSummary, Summarizer, splitLines, type MeetingContext, type SummaryCache } from './summarizer.js';
import { Summary } from './summary.js';
import type { ChatMessage, ChatModel } from './types.js';

const context: MeetingContext = {
  title: 'Weekly sync',
  startedAt: '2026-10-13T14:00:00.000Z',
  participants: ['Alice', 'Bob'],
  bookmarks: ['[05:00] Decision: ship v1 (by Alice)'],
};

const summaryJson = (tldr: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ tldr, keyPoints: [], decisions: [], actionItems: [], openQuestions: [], ...extra });

/** A ChatModel that answers from a script and records what it was asked. */
function scriptedModel(answer: (messages: ChatMessage[], call: number) => string) {
  const calls: ChatMessage[][] = [];
  const model: ChatModel = {
    name: 'scripted',
    complete: async (messages) => {
      calls.push(messages);
      return answer(messages, calls.length - 1);
    },
  };
  return { model, calls };
}

const lastUserMessage = (messages: ChatMessage[]) => messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';

describe('Summarizer', () => {
  it('summarizes a short meeting in one call, with context and bookmarks', async () => {
    const { model, calls } = scriptedModel(() =>
      summaryJson('Shipping v1.', { actionItems: [{ task: 'Write notes', owner: 'Bob', due: '2026-10-16' }] }),
    );
    const summary = await new Summarizer({ model, chunkChars: 10_000, logger: silentLogger }).summarize(context, [
      '[00:01] Alice: Let us ship v1.',
      '[00:05] Bob: I will write the notes by Friday.',
    ]);

    expect(summary.tldr).toBe('Shipping v1.');
    expect(summary.actionItems).toEqual([{ task: 'Write notes', owner: 'Bob', due: '2026-10-16' }]);
    expect(calls).toHaveLength(1);
    const prompt = lastUserMessage(calls[0]!);
    expect(prompt).toContain('Meeting: Weekly sync');
    expect(prompt).toContain('Date: 2026-10-13');
    expect(prompt).toContain('Participants: Alice, Bob');
    expect(prompt).toContain('- [05:00] Decision: ship v1 (by Alice)');
    expect(prompt).toContain('[00:05] Bob: I will write the notes by Friday.');
    expect(calls[0]![0]!.role).toBe('system');
  });

  it('does not call the model when nothing was transcribed', async () => {
    const { model, calls } = scriptedModel(() => '');
    const summary = await new Summarizer({ model, chunkChars: 10_000, logger: silentLogger }).summarize(context, []);
    expect(summary.tldr).toMatch(/Nothing was said/);
    expect(calls).toHaveLength(0);
  });

  it('summarizes long meetings in parts, then combines them', async () => {
    const { model, calls } = scriptedModel((messages) => {
      const prompt = lastUserMessage(messages);
      if (prompt.includes('Combine them')) return summaryJson('Whole meeting.');
      const part = /part (\d) of/.exec(prompt)?.[1];
      return summaryJson(`Part ${part}.`, { decisions: [`Decision ${part}`] });
    });
    const lines = Array.from({ length: 6 }, (_, i) => `[00:0${i}] Alice: ${'word '.repeat(10)}`);
    // 65-character lines, so two fit in each part.
    const summary = await new Summarizer({ model, chunkChars: 140, logger: silentLogger }).summarize(context, lines);

    expect(summary.tldr).toBe('Whole meeting.');
    expect(calls).toHaveLength(4); // 3 parts + combine
    const combine = lastUserMessage(calls[3]!);
    expect(combine).toContain('"Decision 1"');
    expect(combine).toContain('"Decision 3"');
  });

  it('asks once more when the reply is not valid JSON', async () => {
    const { model, calls } = scriptedModel((_, call) => (call === 0 ? 'Sure! Here is the summary: tldr = shipped' : summaryJson('Fixed.')));
    const summary = await new Summarizer({ model, chunkChars: 10_000, logger: silentLogger }).summarize(context, ['[00:01] Alice: hi']);
    expect(summary.tldr).toBe('Fixed.');
    expect(calls[1]!.at(-2)).toEqual({ role: 'assistant', content: 'Sure! Here is the summary: tldr = shipped' });
    expect(lastUserMessage(calls[1]!)).toMatch(/not usable \(The reply contains no JSON object\)/);
  });

  it('gives up after the repair attempt fails too', async () => {
    const { model } = scriptedModel(() => '{"tldr": ""}');
    await expect(
      new Summarizer({ model, chunkChars: 10_000, logger: silentLogger }).summarize(context, ['[00:01] Alice: hi']),
    ).rejects.toThrow(/did not return a valid summary: tldr is empty/);
  });

  it('reuses cached results for unchanged prompts', async () => {
    const store = new Map<string, Summary>();
    const cache: SummaryCache = { get: async (key) => store.get(key), set: async (key, value) => void store.set(key, value) };
    const { model, calls } = scriptedModel(() => summaryJson('Once.'));
    const summarizer = new Summarizer({ model, chunkChars: 10_000, logger: silentLogger });

    await summarizer.summarize(context, ['[00:01] Alice: hi'], cache);
    await summarizer.summarize(context, ['[00:01] Alice: hi'], cache);
    expect(calls).toHaveLength(1);
    await summarizer.summarize(context, ['[00:01] Alice: something else'], cache);
    expect(calls).toHaveLength(2);
  });
});

describe('Summary parsing', () => {
  it('extracts JSON from fences and chatter', () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go: {"a": {"b": 2}} Hope it helps!')).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject('no json')).toThrow(/no JSON object/);
  });

  it('is lenient: fills missing lists, drops bad action items, keeps non-ISO due dates in the task', () => {
    const result = parseSummary(
      JSON.stringify({
        tldr: ' Done. ',
        decisions: 'not a list',
        actionItems: [
          { task: 'Book room', owner: ' ', due: 'next sprint' },
          { owner: 'Bob' },
          { task: 'Send recap', owner: 'Alice', due: '2026-10-20' },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      summary: {
        tldr: 'Done.',
        keyPoints: [],
        decisions: [],
        actionItems: [
          { task: 'Book room (due: next sprint)', owner: null, due: null },
          { task: 'Send recap', owner: 'Alice', due: '2026-10-20' },
        ],
        openQuestions: [],
      },
    });
    // Parsing a stored summary again gives the same result.
    if (result.ok) expect(Summary.parse(result.summary)).toEqual(result.summary);
  });

  it('splits lines into parts under the size limit', () => {
    expect(splitLines(['aaaa', 'bbbb', 'cccc'], 10)).toEqual([['aaaa', 'bbbb'], ['cccc']]);
    expect(splitLines(['x'.repeat(50), 'y'], 10)).toEqual([['x'.repeat(50)], ['y']]);
    expect(splitLines([], 10)).toEqual([]);
  });
});
