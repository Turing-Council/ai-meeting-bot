# Developing

Notes for working on the bot: where the project stands, how it's set up, and what comes next.
The product spec is in [`REQUIREMENTS.md`](REQUIREMENTS.md). Setup and deploy steps for users
are in the [README](../README.md).

## Timeline

Milestones follow the plan in `REQUIREMENTS.md`. They're tracked as tasks on the
*Discord Transcript Bot* page in Notion (Projects → Tasks Tracker).

| # | Milestone | Scope | Status |
|---|---|---|---|
| M0 | Setup | Repo, Docker, Dokploy, bot token | 🟡 Code done (2026-10-13). Waiting on Discord app/token and first Dokploy deploy |
| M1 | Record | Join, record, save audio | 🟡 Code done (2026-10-13). Waiting on a manual test on a real server |
| M2 | Transcribe & Summarize | STT + LLM, job pipeline | ⚪ Not started |
| M3 | Notion | Databases, meeting page, action items | ⚪ Not started |
| M4 | Polish | Auto-record, permissions, cleanup | ⚪ Not started (permissions already done in M1) |

A milestone counts as **done** only after it works against a real Discord server, not just in
tests.

## Current scope (M0 + M1)

**In:**
- Slash commands `/meeting start [title] [type]`, `stop`, `note <text>`, `status`
- A control panel message with Pause/Resume, Bookmark (modal) and Stop buttons
- Per-speaker recording, time-aligned, as Ogg Opus; ffmpeg mixdown to `mixed.ogg` on stop
- Auto-leave when the voice channel is empty (default 2 min)
- 🔴 nickname prefix while recording
- Optional recorder role (`RECORDER_ROLE_ID`)
- Crash recovery: interrupted sessions get finished and mixed on the next start
- Graceful shutdown on `SIGTERM` (Dokploy redeploys)

**Out (later milestones):**
- Transcription and summaries (M2)
- Anything in Notion (M3)
- Collecting files/links from chat (M3)
- Auto-record on channel join (M4)
- Deleting old audio (M4)

**Constraints found while building:**
- **One recording per server.** A bot can be in only one voice channel per server.
- Bots can't receive video or screen share.
- Discord doesn't officially support receiving voice. Keep `@discordjs/voice` up to date: it
  handles DAVE (end-to-end voice encryption) through `@snazzah/davey`.

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js ≥ 22.12 (Docker uses Node 24, `.node-version` = 24) |
| Language | TypeScript (strict, `nodenext` ESM: imports use `.js` extensions) |
| Discord | `discord.js` 14 + `@discordjs/voice` 0.19 (DAVE via `@snazzah/davey`, AES-GCM via Node crypto) |
| Config | Environment variables validated with `zod` (`src/config.ts`) |
| Audio | Raw Opus packets → our own Ogg writer; ffmpeg only for the mixdown |
| Storage | Files on disk: one directory per session with a JSON manifest (no database yet) |
| Tests | `vitest` |
| Deploy | Dockerfile → Dokploy, persistent volume at `/app/data` |

No Opus encoder/decoder library is installed (`@discordjs/opus`, `opusscript`): the bot never
decodes audio. If a future feature needs to play audio into a channel, add one then.

## Architecture

```
Discord voice ──per-user Opus packets──▶ MeetingRecorder ──▶ TimelineTrack ──▶ OggOpusWriter ──▶ tracks/<userId>.ogg
                                               ▲                (fills gaps        (pages to disk)
SessionManager ── start/pause/stop ────────────┘                 with silence)
     │                                                                   stop ──▶ ffmpeg amix ──▶ mixed.ogg
     ├── manifest.json (SessionStore, atomic writes)
     ├── control panel (bot/panel.ts)
     └── crash recovery on boot
```

### Modules

| Path | What it does |
|---|---|
| `src/index.ts` | Entry point: Discord client, event wiring, graceful shutdown |
| `src/config.ts` · `src/logger.ts` | Env parsing; JSON-lines logger |
| `src/recorder/opus.ts` | Opus TOC parsing (samples per packet), the 20 ms silence frame |
| `src/recorder/ogg.ts` | Streaming Ogg Opus muxer (RFC 7845), Ogg CRC |
| `src/recorder/track.ts` | Keeps one speaker's track aligned to the meeting clock |
| `src/recorder/recorder.ts` | Subscribes to each speaker on the voice receiver, writes files, flushes every 2 s |
| `src/recorder/mixdown.ts` | ffmpeg `amix` command + runner |
| `src/sessions/manifest.ts` | Session schema (zod), status lifecycle, session IDs |
| `src/sessions/store.ts` | One directory per session, atomic manifest writes |
| `src/sessions/manager.ts` | Session lifecycle: join/leave, pause, bookmarks, empty timeout, nickname, panel, recovery |
| `src/bot/` | Slash command definitions, interaction router, panel builder, permissions, formatting |
| `src/scripts/register-commands.ts` | Registers slash commands and prints the invite link |
| `src/test-utils/` | Independent Ogg parser used by the tests (not built into `dist`) |

### Key design decisions

- **Time alignment without decoding.** Discord only sends packets while someone talks. Each
  track starts at the meeting start, and gaps are filled with 3-byte Opus silence frames (about
  1 MB per hour of silence). Gaps under 100 ms are treated as network jitter and not filled.
  Aligned tracks mean M2 can transcribe each speaker separately and still get correct
  meeting-relative timestamps.
- **Session status:** `recording ⇄ paused → finalizing → recorded | failed`. Anything still in
  `recording/paused/finalizing` at boot was interrupted and gets recovered. `failed` means only
  the mixdown failed; the per-speaker tracks are always kept.
- **Crash safety.** Ogg pages are written as they fill (at most 1 s of audio) and flushed every
  2 s. A file cut off mid-page still decodes. Recovery also picks up track files that were
  created but not yet listed in the manifest.
- **Shutdown doesn't mix.** On `SIGTERM` the bot closes files, leaves voice and marks sessions
  `finalizing`, so a redeploy isn't held up by ffmpeg. The next start does the mixdown.
- **Subscriptions are long-lived.** One receive stream per user for the whole meeting
  (`EndBehaviorType.Manual`). If a stream breaks (e.g. a decryption error during a DAVE key
  change), the bot resubscribes the next time that user speaks and keeps writing to the same file.
- **Panel edits go through the channel**, not the interaction token, because interaction tokens
  expire after 15 minutes.
- **Provider-agnostic AI (from M2 on).** Speech-to-text and summarization each sit behind their
  own interface, configured with `STT_*` / `LLM_*` variables. No single vendor is baked in.

## Data layout

```
$DATA_DIR/sessions/<YYYYMMDD-HHMMSS-xxxx>/
  manifest.json
  tracks/<discordUserId>.ogg
  mixed.ogg
```

`manifest.json` holds:
- title, type and trigger
- status and timestamps (`startedAt`, `endedAt`, `durationMs`, `endReason`, `interrupted`)
- `participants` (everyone present) and `tracks` (only people who spoke)
- `pauses` and `bookmarks`, as ms offsets from the start
- the panel message location

Paths inside the manifest are relative to the session directory.

## Workflow

```bash
npm install
cp .env.example .env     # DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID (for instant command updates)
npm run register         # after changing commands
npm run dev              # tsx watch with .env
npm test                 # unit tests; ffmpeg tests skip if ffmpeg is missing
npm run typecheck
npm run build            # → dist/
docker build --target test .      # all tests incl. real-ffmpeg integration
docker build --target runtime -t turing-voice-bot .
```

npm 11 only runs dependency install scripts you've approved. `esbuild` (used by `tsx`) is
approved in `package.json` under `allowScripts`. If an update to it fails, run
`npm install-scripts approve esbuild`.

### Testing approach

- Unit-test the pure parts thoroughly: Ogg/Opus, timeline alignment, manifest store, panel,
  custom IDs, config, permissions.
- `MeetingRecorder` is tested against a fake voice receiver: speaking events and packet streams.
- Crash recovery is tested with `true`/`false` standing in for ffmpeg.
- `ffmpeg.integration.test.ts` encodes a real Opus tone and checks decoding, timeline placement
  (`silencedetect`), the mixdown, and a truncated "crashed" file. It only runs where ffmpeg is
  installed, which includes the Docker `test` stage.
- Live Discord behavior is covered by the manual checklist in the README.

## Next up (M2)

1. Speech-to-text interface: `transcribe(track) → segments[{ startMs, endMs, text }]`, plus a mock
   provider, plus a first real adapter chosen through `STT_PROVIDER`.
2. LLM interface: `summarize(transcript, bookmarks) → { tldr, keyPoints, decisions, actionItems, openQuestions }`,
   validated with zod, chunked for long meetings, with a mock and a first real adapter
   (`LLM_PROVIDER`).
3. Job pipeline after `recorded`: transcribe → summarize. Each step can be re-run safely and
   resumes after a restart. This is where SQLite (or step status kept in the manifest) comes in.
4. Speaker-labelled transcript output (`[00:12:31] Alice: …`) saved next to the audio.
