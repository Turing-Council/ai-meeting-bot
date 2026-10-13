/** Actions behind the control panel's buttons (incl. retrying failed processing) and the bookmark modal. */
export const PANEL_ACTIONS = ['pause', 'resume', 'bookmark', 'stop', 'bookmark-modal', 'retry'] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

const PREFIX = 'meeting';

/** Custom IDs carry the session ID so stale buttons from old meetings can be detected. */
export function panelCustomId(action: PanelAction, sessionId: string): string {
  return `${PREFIX}:${action}:${sessionId}`;
}

export function parsePanelCustomId(customId: string): { action: PanelAction; sessionId: string } | undefined {
  const [prefix, action, sessionId, ...rest] = customId.split(':');
  if (prefix !== PREFIX || !sessionId || rest.length > 0) return undefined;
  if (!(PANEL_ACTIONS as readonly string[]).includes(action ?? '')) return undefined;
  return { action: action as PanelAction, sessionId };
}

export const BOOKMARK_TEXT_INPUT_ID = 'text';
