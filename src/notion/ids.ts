/**
 * The page (or database) ID in a Notion link or raw ID, dashed. Accepts links like
 * `https://www.notion.so/workspace/Meetings-3f843a403969805e815cc08d0386c410?pvs=4`.
 */
export function parseNotionId(input: string): string | undefined {
  const trimmed = input.trim();
  let candidate = trimmed;
  try {
    candidate = new URL(trimmed).pathname.split('/').at(-1) ?? '';
  } catch {
    // not a URL: a raw ID
  }
  const hex = /([0-9a-f]{32})$/i.exec(candidate.replace(/-/g, ''))?.[1]?.toLowerCase();
  if (!hex) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
