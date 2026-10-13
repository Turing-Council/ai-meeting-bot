import { z } from 'zod';

/**
 * Lifecycle of a recording session on disk:
 *   recording ⇄ paused → finalizing → recorded (ready for processing) | failed
 * A session left in recording/paused/finalizing at boot was interrupted and gets recovered.
 */
export const SessionStatus = z.enum(['recording', 'paused', 'finalizing', 'recorded', 'failed']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ACTIVE_STATUSES: readonly SessionStatus[] = ['recording', 'paused'];
export const UNFINISHED_STATUSES: readonly SessionStatus[] = ['recording', 'paused', 'finalizing'];

const Person = z.object({ id: z.string(), name: z.string() });

/** Processing steps that run after a session is `recorded`, in order. */
export const PIPELINE_STEPS = ['transcribe', 'summarize'] as const;
export type StepName = (typeof PIPELINE_STEPS)[number];

export const StepStatus = z.enum(['pending', 'running', 'done', 'failed']);
export type StepStatus = z.infer<typeof StepStatus>;

const StepState = z.object({
  status: StepStatus,
  attempts: z.number(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});
export type StepState = z.infer<typeof StepState>;

export const SessionManifest = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  type: z.string().optional(),
  trigger: z.enum(['manual', 'auto']),
  status: SessionStatus,

  guildId: z.string(),
  voiceChannelId: z.string(),
  voiceChannelName: z.string(),
  /** Channel holding the control panel message. */
  panelChannelId: z.string().optional(),
  panelMessageId: z.string().optional(),

  startedBy: Person,
  /** ISO timestamps. Track sample 0 corresponds to `startedAt`. */
  startedAt: z.string(),
  endedAt: z.string().optional(),
  endReason: z.string().optional(),
  /** True when the session was recovered after a crash or restart. */
  interrupted: z.boolean().optional(),

  /** Everyone (non-bot) who was in the voice channel during the session. */
  participants: z.array(Person),
  /** Per-speaker audio, relative to the session directory. Only users who actually spoke. */
  tracks: z.array(z.object({ userId: z.string(), file: z.string() })),
  /** Pause intervals, in ms from start. `endMs` is missing while paused. */
  pauses: z.array(z.object({ startMs: z.number(), endMs: z.number().optional() })),
  bookmarks: z.array(z.object({ atMs: z.number(), text: z.string(), by: Person })),

  /** Mixed recording of all tracks, relative to the session directory. */
  mixedFile: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),

  /**
   * State of each processing step (only the steps that are configured). Missing when
   * processing is off or the session predates it.
   */
  processing: z.object({ transcribe: StepState.optional(), summarize: StepState.optional() }).optional(),
  /** Outputs of the processing steps, relative to the session directory. */
  transcriptFile: z.string().optional(),
  transcriptDataFile: z.string().optional(),
  summaryFile: z.string().optional(),
});
export type SessionManifest = z.infer<typeof SessionManifest>;
export type Person = z.infer<typeof Person>;

/** Session IDs sort chronologically and are safe as directory names, e.g. `20261013-140312-k3f9`. */
export function createSessionId(at: Date = new Date(), random: () => number = Math.random): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${stamp}-${suffix}`;
}
