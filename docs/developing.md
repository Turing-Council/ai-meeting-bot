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
| M2 | Transcribe & Summarize | STT + LLM, job pipeline | 🟡 Code done (2026-10-13). Waiting on choosing providers and a test with real meetings |
| M3 | Notion | Databases, meeting page, action items | ⚪ Not started |
| M4 | Polish | Auto-record, permissions, cleanup | ⚪ Not started (permissions already done in M1) |

A milestone counts as **done** only after it works against a real Discord server, not just in
tests.

## Current scope (M0–M2)

**In:**
- Slash commands `/meeting start [title] [type]`, `stop`, `note <text>`, `status`
- A control panel message with Pause/Resume, Bookmark (modal) and Stop buttons
- Per-speaker recording, time-aligned, as Ogg Opus; ffmpeg mixdown to `mixed.ogg` on stop
- Auto-leave when the voice channel is empty (default 2 min)
- 🔴 nickname prefix while recording
- Optional recorder role (`RECORDER_ROLE_ID`)
- Crash recovery: interrupted sessions get finished and mixed on the next start
- Graceful shutdown on `SIGTERM` (Dokploy redeploys)
- Processing after each recording: per-speaker transcription → speaker-labelled transcript →
  structured summary (TL;DR, key points, decisions, action items, open questions)
- Any provider through the OpenAI-compatible APIs (`STT_*`, `LLM_*`), plus `mock` providers
- Progress, TL;DR, action items and the attached `transcript.md` on the control panel; a
  Retry button when a step fails
- Jobs resume after a restart; per-chunk caches avoid paying twice
- `process-session` script to (re)process a session by hand

**Out (later milestones):**
- Anything in Notion (M3), including uploading audio/transcript and the "Notion link" on the panel
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
| AI providers | OpenAI-compatible HTTP APIs via `fetch` (no vendor SDKs): `/audio/transcriptions`, `/chat/completions` |
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
     ├── control panel (PanelUpdater)
     ├── crash recovery on boot
     └── onRecorded ──▶ Pipeline (one job at a time, state in manifest.processing)
                          1. transcribe: silencedetect → speech chunks → SttProvider → merge → transcript.json/.md
                          2. summarize:  transcript + bookmarks → Summarizer (map-reduce) → ChatModel → summary.json
                          └── progress/results ──▶ PanelUpdater (TL;DR, action items, transcript.md attached)
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
| `src/bot/` | Slash command definitions, interaction router, panel builder + updater, permissions, formatting |
| `src/pipeline/runner.ts` | Job queue and step state machine: resume after restart, stop on failure, retry |
| `src/pipeline/transcribe-step.ts` · `summarize-step.ts` | The two steps, with per-chunk caches under `work/` |
| `src/transcript/speech.ts` | ffmpeg `silencedetect` → speech regions → chunks; chunk extraction |
| `src/transcript/transcript.ts` | Merging per-speaker segments into turns; `transcript.json` schema; Markdown |
| `src/stt/` | `SttProvider` interface, `mock` and `openai-compatible` adapters |
| `src/summarize/` | `ChatModel` interface and adapters, `Summary` schema, prompt, map-reduce, JSON repair |
| `src/http.ts` | Provider HTTP calls: timeout, retries on network/408/429/5xx, `Retry-After` |
| `src/scripts/register-commands.ts` | Registers slash commands and prints the invite link |
| `src/scripts/process-session.ts` | Runs the pipeline on one session without Discord (`--list`, `--force`) |
| `src/test-utils/` | Independent Ogg parser and a fake HTTP server, used by the tests (not built into `dist`) |

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
- **Provider-agnostic AI.** Speech-to-text (`SttProvider`) and the LLM (`ChatModel`) each sit
  behind a one-method interface. The real adapter for each speaks the OpenAI-compatible HTTP API,
  which almost every hosted service and self-hosted server supports, so switching providers is a
  config change. A provider with its own API gets a new adapter file and a new `*_PROVIDER` value.
- **Transcribe per speaker, only the speech.** Discord already separates speakers, so there's no
  diarization. Each track is cut at silences of 1 s or more (`-40dB`), regions within 10 s are
  grouped into one chunk (max 10 min), padded 250 ms. Silence is never sent: providers bill per
  audio minute, and Whisper-style models invent text on silence. Segments with Whisper's
  "no speech + low confidence" signature are dropped as well.
- **Pipeline state in the manifest, not SQLite.** The spec suggested SQLite for job state; per-step
  state in `manifest.json` (`processing.transcribe/summarize`: status, attempts, error) turned out
  to be enough for one server and keeps a session self-contained in its directory. Revisit if
  M3/M4 need cross-session queries.
- **Retries at two levels.** Each HTTP call retries transient failures (network, 408, 429, 5xx;
  honouring `Retry-After`). A step that still fails stays `failed` until someone presses Retry;
  boot only resumes `pending`/`running` steps, so a bad API key doesn't loop and burn money.
- **Caching makes steps re-runnable.** Each STT chunk's result is cached by
  `<userId>-<start>-<end>`; each LLM call by a hash of its exact prompt. A crash or retry
  re-runs the step from the start but only pays for work that didn't finish.
- **Lenient summary parsing.** The model's JSON goes through a forgiving zod schema (missing
  lists → empty, malformed action items dropped, non-ISO due dates folded into the task text).
  If the reply isn't usable at all, the model gets one repair round with the error.

## Data layout

```
$DATA_DIR/sessions/<YYYYMMDD-HHMMSS-xxxx>/
  manifest.json
  tracks/<discordUserId>.ogg
  mixed.ogg
  transcript.json           # { version, sessionId, turns: [{ speakerId, speaker, startMs, endMs, text }] }
  transcript.md
  summary.json              # { tldr, keyPoints, decisions, actionItems: [{ task, owner, due }], openQuestions }
  work/stt/<userId>-<startMs>-<endMs>.json   # cached STT result per chunk
  work/llm/<label>-<hash>.json               # cached LLM result per call
```

`manifest.json` holds:
- title, type and trigger
- status and timestamps (`startedAt`, `endedAt`, `durationMs`, `endReason`, `interrupted`)
- `participants` (everyone present) and `tracks` (only people who spoke)
- `pauses` and `bookmarks`, as ms offsets from the start
- the panel message location
- `processing`: state of each configured step, plus the output file names

Paths inside the manifest are relative to the session directory.

## Workflow

```bash
npm install
cp .env.example .env     # DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID (for instant command updates)
npm run register         # after changing commands
npm run dev              # tsx watch with .env (STT_PROVIDER=mock LLM_PROVIDER=mock for a free end-to-end run)
npm run process -- --list            # sessions + processing state
npm run process -- <id> [--force]    # (re)process one session offline
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
- Provider adapters are tested against a local fake HTTP server: request shape (multipart,
  JSON body, auth header), parsing, retry and fail-fast behaviour.
- The summarizer is tested with a scripted `ChatModel`: single call, map-reduce, JSON repair,
  caching.
- `pipeline.integration.test.ts` places Opus tones on two speakers' tracks and runs the real
  pipeline (ffmpeg speech detection and chunking, fake STT, mock LLM). It checks that only
  speech is sent, that lines land at the right time with the right speaker, and that a re-run
  makes no new STT calls. Like the other ffmpeg tests, it runs in the Docker `test` stage.
- Live Discord behavior and real providers are covered by the manual checklist in the README.

## Open points for M2

- **Pick the providers.** Any OpenAI-compatible endpoint works. Main trade-off for STT:
  hosted (no GPU, pay per minute) vs. a self-hosted Whisper server on the VPS (free, but needs
  CPU/GPU headroom; CPU-only is slow for long meetings).
- **Tune on real meetings:** silence threshold (`-40dB`), chunk grouping (10 s) and the summary
  prompt were chosen from first principles and only tested on synthetic audio.

## Next up (M3)

1. Notion client + `setup` script: create the Meetings and Action Items databases under a parent
   page, store their IDs.
2. Meeting page created at `/meeting start` (status `Recording`), completed after processing:
   properties, body template (summary, decisions, action items, open questions, bookmarks,
   materials, transcript in a toggle).
3. A `publish` pipeline step: upload `mixed.ogg` and `transcript.md` (File Upload API), create
   Action Items with a relation to the meeting. Same resume/retry rules as the other steps.
4. Collect attachments and links posted in the voice channel's chat during the session.
5. Notion link on the control panel.
