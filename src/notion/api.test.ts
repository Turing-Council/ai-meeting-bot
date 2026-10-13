import { describe, expect, it } from 'vitest';
import { PART_BYTES, partRanges } from './api.js';
import { parseNotionId } from './ids.js';

describe('partRanges', () => {
  it('splits a file into 10 MB parts with a shorter last part', () => {
    const size = 2 * PART_BYTES + 123;
    expect(partRanges(size)).toEqual([
      { start: 0, end: PART_BYTES },
      { start: PART_BYTES, end: 2 * PART_BYTES },
      { start: 2 * PART_BYTES, end: size },
    ]);
    expect(partRanges(2 * PART_BYTES)).toHaveLength(2);
  });
});

describe('parseNotionId', () => {
  const id = '3f843a40-3969-805e-815c-c08d0386c410';
  it('reads the ID from links and raw IDs', () => {
    expect(parseNotionId('https://www.notion.so/team/Meetings-3f843a403969805e815cc08d0386c410?pvs=4')).toBe(id);
    expect(parseNotionId('https://app.notion.com/p/3f843a403969805e815cc08d0386c410')).toBe(id);
    expect(parseNotionId('3F843A403969805E815CC08D0386C410')).toBe(id);
    expect(parseNotionId(id)).toBe(id);
  });
  it('rejects anything without an ID', () => {
    expect(parseNotionId('https://www.notion.so/team/Meetings')).toBeUndefined();
    expect(parseNotionId('hello')).toBeUndefined();
  });
});
