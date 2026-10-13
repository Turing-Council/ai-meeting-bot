/**
 * Pulls the JSON object out of a model reply. Models sometimes wrap it in ```json fences
 * or add a sentence before or after, even when asked not to.
 */
export function extractJsonObject(reply: string): unknown {
  const trimmed = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The reply contains no JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}
