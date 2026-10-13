# Developing

Notes for working on the bot: where the project stands, how it's set up, and what comes next.
The product spec is in [`REQUIREMENTS.md`](REQUIREMENTS.md). Setup, configuration and day-to-day
use are in [`usage.md`](usage.md).

## Timeline

Milestones follow the plan in `REQUIREMENTS.md`. They're tracked as tasks on the
*Discord Transcript Bot* page in Notion (Projects → Tasks Tracker).

| # | Milestone | Scope | Status |
|---|---|---|---|
| M0 | Setup | Repo, Docker, Dokploy, bot token | 🟡 Code done (2026-10-13). Waiting on Discord app/token and first Dokploy deploy |
| M1 | Record | Join, record, save audio | 🟡 Code done (2026-10-13). Waiting on a manual test on a real server |
| M2 | Transcribe & Summarize | STT + LLM, job pipeline | 🟡 Code done (2026-10-13). Waiting on choosing providers and a test with real meetings |
| M3 | Notion | Databases, meeting page, action items | 🟡 Code done (2026-10-13). Waiting on a Notion integration and a test on a sandbox page |
| M4 | Polish | Auto-record, permissions, cleanup | ⚪ Not started (permissions already done in M1) |

A milestone counts as **done** only after it works against a real Discord server, not just in
tests.

## Current scope (M0–M3)

**In:**
- Slash commands `/meeting start [title] [type]`, `stop`, `note <text>`, `status` (current
  recording, or the last meeting with its processing state and summary)
- A control panel message with Pause/Resume, Bookmark (modal) and Stop buttons
- Per-speaker recording, time-aligned, as Ogg Opus; ffmpeg mixdown to `mixed.ogg` as the first
  processing step
- Auto-leave when the voice channel is empty (default 2 min)
- 🔴 nickname prefix while recording
- Optional recorder role (`RECORDER_ROLE_ID`)
- Crash recovery: interrupted sessions get finished and processed on the next start
- Graceful shutdown on `SIGTERM` (Dokploy redeploys)
- Processing after each recording: mix; per-speaker transcription → speaker-labelled transcript
  (with bookmarks) → structured summary (TL;DR, key points, decisions, action items, open questions)
- Any provider through the OpenAI-compatible APIs (`STT_*`, `LLM_*`), plus `mock` providers
- Progress, TL;DR, action items and the attached `transcript.md` on the control panel; a
  Retry button when a step fails
- Jobs resume after a restart; per-chunk caches avoid paying twice; a session lock keeps the bot
  and the script from processing the same session at once
- `process-session` script to (re)process a session by hand
- CI on GitHub Actions: type check + all tests, including the ffmpeg ones
- Notion: `/meeting setup` (or `npm run notion:setup`) creates the Meetings and Action Items
  databases. A page is created at `/meeting start` (`Recording`), its Status follows processing,
  and a `publish` step fills it in. Action items become linked rows. **Open in Notion** on the panel
- Chat materials (`COLLECT_CHAT_MATERIALS=true`): files and links from the voice channel's chat,
  downloaded during the meeting and published under Materials

**Out (later milestones):**
- Auto-record on channel join (M4)
- Mapping Discord users to Notion people (later; plain names for now)
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
| Notion | Official `@notionhq/client`, pinned to `Notion-Version: 2025-09-03` (data sources, file uploads); the SDK retries 429/5xx |
| Deploy | Dockerfile → Dokploy, persistent volume at `/app/data` |

No Opus encoder/decoder library is installed (`@discordjs/opus`, `opusscript`): the bot never
decodes audio. If a future feature needs to play audio into a channel, add one then.

## Architecture

```
Discord voice ──per-user Opus packets──▶ MeetingRecorder ──▶ TimelineTrack ──▶ OggOpusWriter ──▶ tracks/<userId>.ogg
                                               ▲                (fills gaps        (pages to disk)
SessionManager ── start/pause/stop ────────────┘                 with silence)
     ├── manifest.json (SessionStore, atomic writes)
     ├── control panel (PanelUpdater)
     ├── crash recovery on boot
     ├── chat materials (MessageCreate/Delete → materials/, manifest.materials)
     ├── onStarted ──▶ NotionPublisher.startMeeting → page (Recording) → manifest.notion
     └── onRecorded ──▶ Pipeline (one job at a time, state in manifest.processing, processing.lock)
                          1. mix:        ffmpeg amix → mixed.ogg
                          2. transcribe: silencedetect → speech chunks → SttProvider → merge → transcript.json/.md
                          3. summarize:  transcript + bookmarks → Summarizer (map-reduce) → ChatModel → summary.json
                          4. publish:    uploads + properties + body blocks + action items → Notion (Done)
                          └── progress/results ──▶ PanelUpdater (TL;DR, action items, transcript.md attached)
                                               └─▶ NotionPublisher.statusListener (Processing / Failed)
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
| `src/pipeline/runner.ts` | Job queue and step state machine: dependencies between steps, resume after restart, retry, reset |
| `src/pipeline/mix-step.ts` · `transcribe-step.ts` · `summarize-step.ts` | The steps; transcribe/summarize cache per chunk under `work/` |
| `src/pipeline/lock.ts` | Per-session lock file with a heartbeat; stale locks are taken over |
| `src/transcript/speech.ts` | ffmpeg `silencedetect` → speech regions → chunks; chunk extraction |
| `src/transcript/transcript.ts` | Merging per-speaker segments into turns; `transcript.json` schema; Markdown |
| `src/stt/` | `SttProvider` interface, `mock` and `openai-compatible` adapters |
| `src/summarize/` | `ChatModel` interface and adapters, `Summary` schema, prompt, map-reduce, JSON repair |
| `src/http.ts` | Provider HTTP calls: timeout, retries on network/408/429/5xx, `Retry-After` |
| `src/notion/api.ts` | `NotionApi` interface + SDK implementation: databases, pages, blocks, single/multi-part uploads |
| `src/notion/schema.ts` · `setup.ts` · `settings.ts` | Database schemas, idempotent setup, `notion.json` |
| `src/notion/properties.ts` · `blocks.ts` · `rich-text.ts` | Pure builders: page/action-item properties, the page body, Notion's text limits |
| `src/notion/publisher.ts` | Page at start, status sync, final properties |
| `src/pipeline/publish-step.ts` | The `publish` step: uploads, body, action items, with checkpoints |
| `src/sessions/materials.ts` | Links and attachments from chat messages; size-capped downloads |
| `src/scripts/register-commands.ts` | Registers slash commands and prints the invite link |
| `src/scripts/process-session.ts` | Runs the pipeline on one session without Discord (`--list`, `--force`) |
| `src/scripts/notion-setup.ts` | Same as `/meeting setup`, from the command line |
| `src/test-utils/` | Independent Ogg parser, a fake HTTP server and an in-memory fake Notion, used by the tests (not built into `dist`) |

### Key design decisions

- **Time alignment without decoding.** Discord only sends packets while someone talks. Each
  track starts at the meeting start, and gaps are filled with 3-byte Opus silence frames (about
  1 MB per hour of silence). Gaps under 100 ms are treated as network jitter and not filled.
  Aligned tracks mean M2 can transcribe each speaker separately and still get correct
  meeting-relative timestamps.
- **Session status:** `recording ⇄ paused → finalizing → recorded`. Anything still in
  `recording/paused/finalizing` at boot was interrupted and gets recovered. `recorded` only means
  the tracks are on disk; everything after that, including the mixdown, is a processing step
  with its own retry. (`failed` appears only in sessions from before that change, where the
  mixdown failed; processing treats them as `recorded`.)
- **Crash safety.** Ogg pages are written as they fill (at most 1 s of audio) and flushed every
  2 s. A file cut off mid-page still decodes. Recovery also picks up track files that were
  created but not yet listed in the manifest.
- **Shutdown is quick.** On `SIGTERM` the bot closes files, leaves voice and marks sessions
  `finalizing`. The next start completes them and hands them to processing. A processing job
  cut off by the shutdown leaves its step `running`, and it resumes too.
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
  "no speech + low confidence" signature are dropped as well (needs `verbose_json`), and so are
  lines models invent from noise that nobody says in a meeting ("Thanks for watching",
  "Subtitles by…"), in every response format.
- **Steps declare what they need.** `summarize` needs `transcribe`; `mix` needs nothing. A failed
  step blocks only the steps that need it, so a broken mixdown doesn't stop the transcript.
- **Session lock.** Processing holds `processing.lock` in the session directory. The holder
  touches it every 30 s; a lock untouched for 2 min was left by a dead process and is taken
  over. The bot skips a locked session (and logs who holds it); the script stops with a message.
- **Notion setup lives on the volume.** `/meeting setup` writes `$DATA_DIR/notion.json` (database
  and data source IDs, and whether Status is a real Status or a Select fallback). No extra env
  vars, no redeploy. Setup is idempotent while the saved data sources are reachable.
- **The page exists from the start.** It's created in the background at `/meeting start` and
  never blocks recording. If that fails, or the meeting ends first (the page is then trashed),
  the publish step creates it. The Status mirror (`Processing`/`Failed`) is a pipeline listener;
  `Done` is written only by the publish step, and the listener never overrides it.
- **Re-runnable publishing that keeps people's notes.** The bot records the IDs of the top-level
  blocks it appends (`manifest.notion.bodyBlockIds`) and deletes only those before rewriting.
  Action items are created once, in order (`actionItemIds`); a run cut short continues from the
  next one. `checkpoint()` saves these IDs as soon as they exist in Notion, so a crash can't
  duplicate them. Uploads are redone each run because they expire after an hour unattached.
- **Notion limits handled in the builders:** 2000 characters per rich-text item, 100 blocks per
  append, two levels of nesting. The transcript toggle is appended first, and its paragraphs are
  appended to it in batches of 100.
- **Chat materials are copied immediately.** Discord attachment URLs expire, so files (≤ 100 MB)
  are downloaded to `materials/` when posted. The session waits for pending downloads before it
  ends. Collecting needs the privileged Message Content intent, so it's opt-in
  (`COLLECT_CHAT_MATERIALS`): requesting it without enabling it in the portal makes Discord
  refuse the login. The bot then says so.
- **Pipeline state in the manifest, not SQLite.** The spec suggested SQLite for job state; per-step
  state in `manifest.json` (`processing.mix/transcribe/summarize`: status, attempts, error) turned out
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
  processing.lock           # only while being processed
  materials/<messageId>-<n>-<name>           # files posted in the chat during the meeting
  tracks/<discordUserId>.ogg
  mixed.ogg
  transcript.json           # { version, sessionId, turns: [{ speakerId, speaker, startMs, endMs, text }] }
  transcript.md
  summary.json              # { tldr, keyPoints, decisions, actionItems: [{ task, owner, due }], openQuestions }
  work/stt/<userId>-<startMs>-<endMs>.json   # cached STT result per chunk
  work/llm/<label>-<hash>.json               # cached LLM result per call
$DATA_DIR/notion.json        # Notion database/data source IDs (from /meeting setup)
```

`manifest.json` holds:
- title, type and trigger
- status and timestamps (`startedAt`, `endedAt`, `durationMs`, `endReason`, `interrupted`)
- `participants` (everyone present) and `tracks` (only people who spoke)
- `pauses` and `bookmarks`, as ms offsets from the start
- the panel message location
- `materials`: files and links from the chat
- `notion`: page ID/URL, and the IDs of the body blocks and action items the bot created
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
npm test                 # all tests; the ffmpeg ones skip if ffmpeg is missing (brew install ffmpeg)
npm run typecheck
npm run build            # → dist/
```

The Dockerfile is for Dokploy. It still has a `test` stage, but day-to-day testing is local
(`npm test`) and in CI, not Docker.

npm 11 only runs dependency install scripts you've approved. `esbuild` (used by `tsx`) is
approved in `package.json` under `allowScripts`. If an update to it fails, run
`npm install-scripts approve esbuild`.

### Testing approach

- Unit-test the pure parts thoroughly: Ogg/Opus, timeline alignment, manifest store, panel,
  custom IDs, config, permissions.
- `MeetingRecorder` is tested against a fake voice receiver: speaking events and packet streams.
- Crash recovery is tested against a real session directory, checking what it hands to processing.
- The pipeline runner is tested with fake steps: order, dependencies, retry, resume, reset, the
  lock (held and stale), and old `failed` sessions.
- `ffmpeg.integration.test.ts` encodes a real Opus tone and checks decoding, timeline placement
  (`silencedetect`), the mixdown, and a truncated "crashed" file. It only runs where ffmpeg is
  installed: in CI, or locally after `brew install ffmpeg`.
- Provider adapters are tested against a local fake HTTP server: request shape (multipart,
  JSON body, auth header), parsing, retry and fail-fast behaviour.
- The summarizer is tested with a scripted `ChatModel`: single call, map-reduce, JSON repair,
  caching.
- `pipeline.integration.test.ts` places Opus tones on two speakers' tracks and runs the real
  pipeline (mixdown, ffmpeg speech detection and chunking, fake STT, mock LLM). It checks the
  mix, that only speech is sent, that lines land at the right time with the right speaker, and
  that a re-run makes no new STT calls. Like the other ffmpeg tests, it runs in CI.
- CI (`.github/workflows/ci.yml`): one job on pushes to `main` and on PRs, only when code or its
  config changes. It caches `node_modules` (keyed on the lockfile) and a static ffmpeg build,
  fails if ffmpeg lacks libopus instead of silently skipping tests, and cancels superseded runs.
- Notion is tested against `FakeNotionApi` (`src/test-utils/fake-notion.ts`), an in-memory
  Notion that enforces the append and nesting limits and can fail a chosen call. The publish
  tests cover the first run, a retry after a failure part-way (no duplicates, human notes kept),
  starting over, and missing setup. Setup tests cover creation, idempotency and the Select
  fallback.
- Live Discord behavior, real providers and real Notion are covered by the manual checklist in
  the README.

## Open points for M2

- **Pick the providers.** Any OpenAI-compatible endpoint works. Main trade-off for STT:
  hosted (no GPU, pay per minute) vs. a self-hosted Whisper server on the VPS (free, but needs
  CPU/GPU headroom; CPU-only is slow for long meetings).
- **Tune on real meetings:** silence threshold (`-40dB`), chunk grouping (10 s) and the summary
  prompt were chosen from first principles and only tested on synthetic audio.

## Open points for M3

- **Verify against real Notion** (README checklist), in particular:
  - creating a `status` property through the API (otherwise the Select fallback is used)
  - multi-part upload of a long recording
  - the 3 requests/second rate limit on a long transcript
- If the page is deleted in Notion while a meeting is processed, publishing fails; it doesn't
  recreate the page.

## Next up (M4)

1. Auto-record: whitelisted channels, start at N humans, auto title, discard sessions under M
   minutes.
2. Cleanup: delete local audio N days after a successful publish.
3. Decide whether `/meeting setup` should use its own role instead of Manage Server.
