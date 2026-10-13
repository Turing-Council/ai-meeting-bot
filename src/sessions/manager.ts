import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client, Guild, SendableChannels, VoiceBasedChannel, VoiceState } from 'discord.js';
import { buildPanel } from '../bot/panel.js';
import { truncate } from '../bot/format.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { mixdown } from '../recorder/mixdown.js';
import { MeetingRecorder } from '../recorder/recorder.js';
import { createSessionId, UNFINISHED_STATUSES, type Person, type SessionManifest } from './manifest.js';
import type { SessionStore } from './store.js';

/** An error whose message is safe and useful to show to the Discord user. */
export class UserError extends Error {}

const CONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_GRACE_MS = 5_000;
const PANEL_REFRESH_DEBOUNCE_MS = 3_000;
const RECORDING_NICK_PREFIX = '🔴 ';
const MIXED_FILE = 'mixed.ogg';

interface ActiveSession {
  manifest: SessionManifest;
  guild: Guild;
  connection: VoiceConnection;
  recorder: MeetingRecorder;
  startMs: number;
  emptyTimer?: NodeJS.Timeout;
  panelTimer?: NodeJS.Timeout;
  saveChain: Promise<void>;
  stopping?: Promise<SessionManifest>;
}

export interface StartOptions {
  guild: Guild;
  voiceChannel: VoiceBasedChannel;
  startedBy: Person;
  trigger: 'manual' | 'auto';
  title?: string | undefined;
  type?: string | undefined;
  /** Where to post the control panel if the voice channel's own chat is not usable. */
  fallbackPanelChannel?: SendableChannels | undefined;
}

export interface SessionManagerDeps {
  client: Client;
  store: SessionStore;
  config: Config;
  logger: Logger;
  now?: () => number;
}

/**
 * Owns the recording sessions: joining/leaving voice, the recorder, the control panel,
 * the empty-channel timeout and crash recovery.
 *
 * A Discord bot can be in only one voice channel per server, so there is at most one
 * active session per guild.
 */
export class SessionManager {
  private readonly client: Client;
  private readonly store: SessionStore;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly now: () => number;

  private readonly active = new Map<string, ActiveSession>();
  private readonly starting = new Set<string>();
  private readonly savedNicknames = new Map<string, string | null>();

  constructor(deps: SessionManagerDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.config = deps.config;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  getActive(guildId: string): SessionManifest | undefined {
    return this.active.get(guildId)?.manifest;
  }

  getActiveBySessionId(sessionId: string): SessionManifest | undefined {
    for (const session of this.active.values()) {
      if (session.manifest.id === sessionId) return session.manifest;
    }
    return undefined;
  }

  /** Milliseconds since the session started (used for bookmarks). */
  elapsedMs(sessionId: string): number | undefined {
    const session = this.findBySessionId(sessionId);
    return session ? this.now() - session.startMs : undefined;
  }

  async start(options: StartOptions): Promise<SessionManifest> {
    const { guild, voiceChannel } = options;
    const existing = this.active.get(guild.id);
    if (existing) {
      throw new UserError(`I'm already recording in <#${existing.manifest.voiceChannelId}>. Stop that meeting first.`);
    }
    if (this.starting.has(guild.id)) throw new UserError('A recording is already starting in this server.');

    this.starting.add(guild.id);
    try {
      return await this.startUnlocked(options);
    } finally {
      this.starting.delete(guild.id);
    }
  }

  private async startUnlocked(options: StartOptions): Promise<SessionManifest> {
    const { guild, voiceChannel } = options;
    const startMs = this.now();
    const startedAt = new Date(startMs);
    const id = createSessionId(startedAt);
    const log = this.logger.child({ sessionId: id, guildId: guild.id });

    const manifest: SessionManifest = {
      version: 1,
      id,
      title: options.title?.trim() || defaultTitle(voiceChannel.name, startedAt),
      ...(options.type?.trim() ? { type: options.type.trim() } : {}),
      trigger: options.trigger,
      status: 'recording',
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      voiceChannelName: voiceChannel.name,
      startedBy: options.startedBy,
      startedAt: startedAt.toISOString(),
      participants: voiceChannel.members
        .filter((member) => !member.user.bot)
        .map((member) => ({ id: member.id, name: member.displayName })),
      tracks: [],
      pauses: [],
      bookmarks: [],
    };
    await this.store.create(manifest);

    const connection = joinVoiceChannel({
      guildId: guild.id,
      channelId: voiceChannel.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // must be undeafened to receive audio
      selfMute: true,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch (error) {
      log.error('Could not connect to voice', { error });
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      await this.store.save({ ...manifest, status: 'failed', error: 'Could not connect to the voice channel' });
      throw new UserError(
        `I couldn't connect to <#${voiceChannel.id}>. Check that I have the Connect permission there and try again.`,
      );
    }

    const session: ActiveSession = {
      manifest,
      guild,
      connection,
      startMs,
      saveChain: Promise.resolve(),
      recorder: new MeetingRecorder({
        receiver: connection.receiver,
        sessionDir: this.store.sessionDir(id),
        sessionStartMs: startMs,
        logger: log,
        now: this.now,
        shouldRecord: (userId) => !this.client.users.cache.get(userId)?.bot,
        onNewSpeaker: (userId, file) => {
          manifest.tracks.push({ userId, file });
          void this.ensureParticipant(session, userId).then(() => this.persist(session));
        },
      }),
    };
    this.active.set(guild.id, session);
    session.recorder.start();
    this.watchConnection(session);

    await this.postPanel(session, options.fallbackPanelChannel);
    await this.persist(session);
    await this.setRecordingNickname(guild, true);
    this.updateEmptyTimer(session);

    log.info('Recording started', { channel: voiceChannel.name, trigger: options.trigger });
    return manifest;
  }

  async pause(sessionId: string): Promise<SessionManifest> {
    const session = this.requireBySessionId(sessionId);
    if (session.manifest.status !== 'recording') throw new UserError('The recording is not running.');
    session.recorder.setPaused(true);
    session.manifest.pauses.push({ startMs: this.now() - session.startMs });
    session.manifest.status = 'paused';
    await this.persist(session);
    return session.manifest;
  }

  async resume(sessionId: string): Promise<SessionManifest> {
    const session = this.requireBySessionId(sessionId);
    if (session.manifest.status !== 'paused') throw new UserError('The recording is not paused.');
    session.recorder.setPaused(false);
    const open = session.manifest.pauses.at(-1);
    if (open && open.endMs === undefined) open.endMs = this.now() - session.startMs;
    session.manifest.status = 'recording';
    await this.persist(session);
    return session.manifest;
  }

  async addBookmark(sessionId: string, text: string, by: Person): Promise<{ manifest: SessionManifest; atMs: number }> {
    const session = this.requireBySessionId(sessionId);
    const atMs = this.now() - session.startMs;
    session.manifest.bookmarks.push({ atMs, text: truncate(text.trim(), 500), by });
    await this.persist(session);
    this.schedulePanelRefresh(session);
    return { manifest: session.manifest, atMs };
  }

  /** Stops the guild's session: closes tracks, leaves voice, mixes the audio. Idempotent. */
  async stop(guildId: string, reason: string): Promise<SessionManifest> {
    const session = this.active.get(guildId);
    if (!session) throw new UserError("I'm not recording anything in this server.");
    session.stopping ??= this.finalize(session, reason);
    return session.stopping;
  }

  /** Re-renders the panel message right away (after pause/resume the button handler does this itself). */
  async refreshPanelNow(sessionId: string): Promise<void> {
    const session = this.findBySessionId(sessionId);
    if (session) await this.refreshPanel(session.manifest);
  }

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const session = this.active.get(newState.guild.id);
    if (!session || session.stopping) return;
    const channelId = session.manifest.voiceChannelId;
    if (oldState.channelId !== channelId && newState.channelId !== channelId) return;

    const member = newState.member;
    if (member && !member.user.bot && newState.channelId === channelId) {
      const known = session.manifest.participants.some((p) => p.id === member.id);
      if (!known) {
        session.manifest.participants.push({ id: member.id, name: member.displayName });
        void this.persist(session);
        this.schedulePanelRefresh(session);
      }
    }
    this.updateEmptyTimer(session);
  }

  /**
   * Finishes sessions that were cut short by a crash or restart: picks up any track files,
   * mixes them and marks the session recorded. Call once the client is ready.
   */
  async recoverInterrupted(): Promise<void> {
    const sessions = await this.store.list();
    for (const manifest of sessions) {
      if (!UNFINISHED_STATUSES.includes(manifest.status)) continue;
      if (this.getActiveBySessionId(manifest.id)) continue;
      const log = this.logger.child({ sessionId: manifest.id });
      log.warn('Recovering interrupted session', { status: manifest.status });
      try {
        await this.recoverOne(manifest);
        log.info('Recovered session', { status: manifest.status });
      } catch (error) {
        log.error('Failed to recover session', { error });
      }
    }
  }

  /** Removes a 🔴 nickname left behind by a crash in servers with no active recording. */
  async resetStaleNicknames(): Promise<void> {
    for (const guild of this.client.guilds.cache.values()) {
      const me = guild.members.me;
      if (!me?.nickname?.startsWith(RECORDING_NICK_PREFIX) || this.active.has(guild.id)) continue;
      const original = me.nickname.slice(RECORDING_NICK_PREFIX.length);
      await me.setNickname(original === me.user.username ? null : original).catch((error: unknown) => {
        this.logger.debug('Could not reset nickname', { guildId: guild.id, error });
      });
    }
  }

  /**
   * On process shutdown: close all tracks and leave voice quickly, without mixing.
   * The sessions are left as `finalizing` and get mixed by recoverInterrupted() on next boot.
   */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.active.values()].map(async (session) => {
        if (session.stopping) {
          await session.stopping.catch(() => undefined);
          return;
        }
        const endMs = this.now();
        // Deregister first so the connection's Destroyed event doesn't trigger a full stop + mixdown.
        this.active.delete(session.guild.id);
        this.clearTimers(session);
        this.closeOpenPause(session, endMs);
        Object.assign(session.manifest, {
          status: 'finalizing',
          endedAt: new Date(endMs).toISOString(),
          endReason: 'bot shutting down',
          durationMs: endMs - session.startMs,
        } satisfies Partial<SessionManifest>);
        await session.recorder.stop(endMs);
        this.destroyConnection(session);
        await this.persist(session);
        await this.setRecordingNickname(session.guild, false);
      }),
    );
    this.active.clear();
  }

  // --- internals -----------------------------------------------------------------------------

  private async finalize(session: ActiveSession, reason: string): Promise<SessionManifest> {
    const { manifest } = session;
    const log = this.logger.child({ sessionId: manifest.id });
    const endMs = this.now();

    this.clearTimers(session);
    this.closeOpenPause(session, endMs);
    Object.assign(manifest, {
      status: 'finalizing',
      endedAt: new Date(endMs).toISOString(),
      endReason: reason,
      durationMs: endMs - session.startMs,
    } satisfies Partial<SessionManifest>);
    await this.persist(session);
    void this.refreshPanel(manifest);

    try {
      await session.recorder.stop(endMs);
    } finally {
      this.destroyConnection(session);
      this.active.delete(session.guild.id);
      await this.setRecordingNickname(session.guild, false);
    }

    await session.saveChain;
    await this.mixAndComplete(manifest);
    await this.refreshPanel(manifest);
    log.info('Recording stopped', { reason, status: manifest.status, durationMs: manifest.durationMs });
    return manifest;
  }

  private async recoverOne(manifest: SessionManifest): Promise<void> {
    // Pick up track files that were created but not yet recorded in the manifest.
    const tracksDir = this.store.resolve(manifest.id, 'tracks');
    const files = await readdir(tracksDir).catch(() => [] as string[]);
    let lastWriteMs = Date.parse(manifest.startedAt);
    for (const file of files.filter((f) => f.endsWith('.ogg'))) {
      const relative = path.posix.join('tracks', file);
      const info = await stat(path.join(tracksDir, file));
      if (info.size === 0) continue;
      lastWriteMs = Math.max(lastWriteMs, info.mtimeMs);
      if (!manifest.tracks.some((t) => t.file === relative)) {
        manifest.tracks.push({ userId: path.basename(file, '.ogg'), file: relative });
      }
    }

    const endMs = manifest.endedAt ? Date.parse(manifest.endedAt) : lastWriteMs;
    const startMs = Date.parse(manifest.startedAt);
    const open = manifest.pauses.at(-1);
    if (open && open.endMs === undefined) open.endMs = endMs - startMs;

    if (!manifest.endedAt) manifest.interrupted = true;
    manifest.endedAt ??= new Date(endMs).toISOString();
    manifest.endReason ??= 'interrupted (bot restarted or crashed)';
    manifest.durationMs ??= endMs - startMs;
    manifest.status = 'finalizing';
    await this.store.save(manifest);

    await this.mixAndComplete(manifest);
    await this.refreshPanel(manifest);
  }

  private async mixAndComplete(manifest: SessionManifest): Promise<void> {
    if (manifest.tracks.length === 0) {
      manifest.status = 'recorded';
      await this.store.save(manifest);
      return;
    }
    try {
      await mixdown(
        this.config.ffmpegPath,
        manifest.tracks.map((t) => this.store.resolve(manifest.id, t.file)),
        this.store.resolve(manifest.id, MIXED_FILE),
      );
      manifest.mixedFile = MIXED_FILE;
      manifest.status = 'recorded';
      delete manifest.error;
    } catch (error) {
      // The per-speaker tracks are still on disk; only the mixed file is missing.
      manifest.status = 'failed';
      manifest.error = error instanceof Error ? error.message : String(error);
      this.logger.error('Mixdown failed', { sessionId: manifest.id, error });
    }
    await this.store.save(manifest);
  }

  private watchConnection(session: ActiveSession): void {
    const { connection } = session;
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Either Discord is moving us (it reconnects by itself) or we were kicked.
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
      ]).catch(() => {
        if (this.active.get(session.guild.id) === session) {
          void this.stop(session.guild.id, 'disconnected from voice').catch((error: unknown) =>
            this.logger.error('Failed to stop after disconnect', { error }),
          );
        }
      });
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.active.get(session.guild.id) === session && !session.stopping) {
        void this.stop(session.guild.id, 'voice connection closed').catch((error: unknown) =>
          this.logger.error('Failed to stop after connection closed', { error }),
        );
      }
    });
    connection.on('error', (error) => this.logger.warn('Voice connection error', { sessionId: session.manifest.id, error }));
  }

  private updateEmptyTimer(session: ActiveSession): void {
    const channel = session.guild.channels.cache.get(session.manifest.voiceChannelId);
    const humans = channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;

    if (humans > 0) {
      if (session.emptyTimer) {
        clearTimeout(session.emptyTimer);
        delete session.emptyTimer;
      }
      return;
    }
    if (session.emptyTimer) return;

    this.logger.info('Voice channel is empty; will stop if nobody returns', {
      sessionId: session.manifest.id,
      timeoutMs: this.config.emptyChannelTimeoutMs,
    });
    session.emptyTimer = setTimeout(() => {
      void this.stop(session.guild.id, 'voice channel empty').catch((error: unknown) =>
        this.logger.error('Failed to stop empty session', { error }),
      );
    }, this.config.emptyChannelTimeoutMs);
  }

  private async postPanel(session: ActiveSession, fallback: SendableChannels | undefined): Promise<void> {
    const voiceChannel = session.guild.channels.cache.get(session.manifest.voiceChannelId);
    const candidates = [voiceChannel?.isSendable() ? voiceChannel : undefined, fallback].filter(
      (c): c is SendableChannels => c !== undefined,
    );
    for (const channel of candidates) {
      try {
        const message = await channel.send(buildPanel(session.manifest));
        session.manifest.panelChannelId = channel.id;
        session.manifest.panelMessageId = message.id;
        return;
      } catch (error) {
        this.logger.warn('Could not post control panel', { channelId: channel.id, error });
      }
    }
  }

  private schedulePanelRefresh(session: ActiveSession): void {
    if (session.panelTimer) return;
    session.panelTimer = setTimeout(() => {
      delete session.panelTimer;
      void this.refreshPanel(session.manifest);
    }, PANEL_REFRESH_DEBOUNCE_MS);
  }

  private async refreshPanel(manifest: SessionManifest): Promise<void> {
    if (!manifest.panelChannelId || !manifest.panelMessageId) return;
    try {
      const channel = await this.client.channels.fetch(manifest.panelChannelId);
      if (!channel?.isTextBased()) return;
      const message = await channel.messages.fetch(manifest.panelMessageId);
      await message.edit(buildPanel(manifest));
    } catch (error) {
      this.logger.debug('Could not update control panel', { sessionId: manifest.id, error });
    }
  }

  private async setRecordingNickname(guild: Guild, recording: boolean): Promise<void> {
    const me = guild.members.me;
    if (!me) return;
    try {
      if (recording) {
        if (!this.savedNicknames.has(guild.id)) this.savedNicknames.set(guild.id, me.nickname);
        const base = me.nickname ?? me.user.username;
        await me.setNickname(truncate(`${RECORDING_NICK_PREFIX}${base}`, 32));
      } else if (this.savedNicknames.has(guild.id)) {
        await me.setNickname(this.savedNicknames.get(guild.id) ?? null);
        this.savedNicknames.delete(guild.id);
      }
    } catch (error) {
      // Missing "Change Nickname" permission is not fatal; the panel still shows the status.
      this.logger.debug('Could not change nickname', { guildId: guild.id, error });
    }
  }

  private async ensureParticipant(session: ActiveSession, userId: string): Promise<void> {
    if (session.manifest.participants.some((p) => p.id === userId)) return;
    const member =
      session.guild.members.cache.get(userId) ?? (await session.guild.members.fetch(userId).catch(() => undefined));
    session.manifest.participants.push({ id: userId, name: member?.displayName ?? userId });
  }

  /** Saves the manifest; writes are chained so they land in order. */
  private persist(session: ActiveSession): Promise<void> {
    session.saveChain = session.saveChain
      .then(() => this.store.save(structuredClone(session.manifest)))
      .catch((error: unknown) => this.logger.error('Failed to save session', { sessionId: session.manifest.id, error }));
    return session.saveChain;
  }

  private closeOpenPause(session: ActiveSession, endMs: number): void {
    const open = session.manifest.pauses.at(-1);
    if (open && open.endMs === undefined) open.endMs = endMs - session.startMs;
  }

  private clearTimers(session: ActiveSession): void {
    if (session.emptyTimer) clearTimeout(session.emptyTimer);
    if (session.panelTimer) clearTimeout(session.panelTimer);
    delete session.emptyTimer;
    delete session.panelTimer;
  }

  private destroyConnection(session: ActiveSession): void {
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
  }

  private findBySessionId(sessionId: string): ActiveSession | undefined {
    for (const session of this.active.values()) {
      if (session.manifest.id === sessionId) return session;
    }
    return undefined;
  }

  private requireBySessionId(sessionId: string): ActiveSession {
    const session = this.findBySessionId(sessionId);
    if (!session || session.stopping) throw new UserError('This meeting is no longer being recorded.');
    return session;
  }
}

function defaultTitle(channelName: string, at: Date): string {
  const when = at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return `${channelName} — ${when}`;
}
