import type { Message, SendableChannels } from 'discord.js';
import type { Logger } from '../logger.js';
import { transcriptLines, type TranscriptSegment } from '../transcript/transcript.js';

/** Discord allows 2000 characters per message. */
const MAX_CHARS = 1_900;
const NO_MENTIONS = { parse: [] as never[] };

/**
 * One chat message that shows the latest transcript lines while a meeting runs. Edits are
 * batched (Discord rate-limits edits) and never throw into the recording.
 */
export class LiveMessage {
  private readonly lines: string[] = [];
  private message: Message | undefined;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly logger: Logger,
    private readonly debounceMs = 3_000,
  ) {}

  add(segment: TranscriptSegment): void {
    this.lines.push(...transcriptLines([segment]));
    if (this.message && !this.timer) this.timer = setTimeout(() => this.flush(false), this.debounceMs);
  }

  /** Posts the message; lines added before this are included. */
  async attach(channel: SendableChannels): Promise<void> {
    try {
      this.message = await channel.send({ content: this.render(false), allowedMentions: NO_MENTIONS });
    } catch (error) {
      this.logger.warn('Could not post the live transcript', { error });
    }
  }

  /** Final edit, now. */
  async finish(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush(true);
  }

  private flush(ended: boolean): Promise<void> {
    this.timer = undefined;
    const message = this.message;
    if (!message) return this.chain;
    this.chain = this.chain.then(() =>
      message.edit({ content: this.render(ended), allowedMentions: NO_MENTIONS }).then(
        () => undefined,
        (error: unknown) => this.logger.debug('Could not edit the live transcript', { error }),
      ),
    );
    return this.chain;
  }

  private render(ended: boolean): string {
    const header = ended ? '📝 **Live transcript ended.** The full transcript follows once processing is done.' : '🎙️ **Live transcript**';
    const shown: string[] = [];
    let length = header.length;
    for (const line of this.lines.toReversed()) {
      if (length + line.length + 1 > MAX_CHARS) break;
      shown.unshift(line);
      length += line.length + 1;
    }
    return shown.length > 0 ? `${header}\n${shown.join('\n')}` : `${header}\n_Waiting for speech…_`;
  }
}
