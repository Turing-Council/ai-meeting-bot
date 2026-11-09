# Turing Voice Bot

A Discord bot that joins a voice channel, records the meeting (one track per speaker plus a mix),
transcribes and summarizes it, and logs it to Notion as a structured meeting page.

**Set it up → [`docs/usage.md`](docs/usage.md)** (quick setup, commands, configuration, providers, troubleshooting)

Spec: [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) · Developer notes: [`docs/developing.md`](docs/developing.md) ·
Status: **M0 Setup, M1 Record, M2 Transcribe & Summarize, M3 Notion**

## What works now

- `/meeting start [title] [type]` joins your voice channel and starts recording.
- A **control panel** in the voice channel's chat shows a live timer and participants, with
  **Pause / Resume · Bookmark · Stop** buttons.
- `/meeting note <text>` (or the 📝 button) adds a timestamped bookmark.
- `/meeting stop` (or ⏹) saves the recording. `/meeting status` shows the current recording, or
  the last meeting with its processing state and summary.
- The bot leaves automatically when the channel has been empty for 2 minutes (configurable).
- While recording, the bot's nickname gets a 🔴 prefix.
- **Crash-safe:** audio reaches disk every ~2 s. If the bot crashes or is redeployed mid-meeting,
  the session is finished and processed automatically on the next start.
- **Mix, transcript and summary:** after the recording, the panel shows progress, then (when
  providers are configured) the TL;DR, decisions, action items and open questions, with
  `transcript.md` attached. If a step fails, a **Retry processing** button appears.
- **Any AI provider:** speech-to-text and the LLM are configured separately, against any server
  that speaks the common OpenAI-compatible API, hosted or self-hosted.
- **Notion:** `/meeting setup` creates a Meetings and an Action Items database. Each meeting
  gets a page as soon as recording starts. After processing, the page gets the summary,
  decisions, action items (also as linked rows), bookmarks, chat materials, the recording and
  the full transcript.

> **One recording per server.** Discord lets a bot be in only one voice channel per server.

## Live transcription (optional)

With `LIVE_TRANSCRIPTION=true` the bot also shows a live transcript in the voice channel's chat
while recording. See [docs/usage.md](docs/usage.md#live-transcription).

## How recording works

Discord sends each speaker's audio as a separate stream of Opus packets, only while they talk.
The bot writes those packets as-is (no re-encoding) into one Ogg Opus file per speaker and
fills the gaps with 3-byte silence frames. That keeps every track aligned to the meeting
clock, which matters later for speaker-labelled, timestamped transcripts. After the recording,
processing mixes the tracks into `mixed.ogg` with ffmpeg.

```
data/sessions/<session-id>/
  manifest.json        # title, participants, bookmarks, pauses, status…
  tracks/<userId>.ogg  # one aligned track per speaker
  mixed.ogg            # everyone, mixed
```

Session status: `recording ⇄ paused → finalizing → recorded`. `recorded` means every track is
safely on disk; what happens next is processing.

## How processing works

Once a session is `recorded`, a job runs these steps, one session at a time:

1. **Mix.** ffmpeg mixes the tracks into `mixed.ogg`. Always runs.
2. **Transcribe** (when `STT_PROVIDER` is set). For each speaker's track, ffmpeg finds the stretches with speech
   (`silencedetect`) and cuts them into small mono chunks. Only those chunks are sent to the
   speech-to-text provider, never the silence (providers bill per audio minute, and silence makes
   Whisper-style models invent text). Each line keeps its speaker and its time on the meeting
   clock, and all speakers are merged into `transcript.json` and `transcript.md`
   (`**[00:12:31] Alice:** …`, with bookmarks shown where they were made).
3. **Summarize** (when `LLM_PROVIDER` is also set). The transcript, the participant list and the bookmarks go to the LLM, which
   returns JSON: TL;DR, key points, decisions, action items (task, owner, due date) and open
   questions. The JSON is validated; long meetings are summarized in parts and then combined.
   Result: `summary.json`.
4. **Publish** to Notion (when `NOTION_TOKEN` is set) runs last: it fills in the meeting's
   page. See [`docs/usage.md`](docs/usage.md#notion).

Each step's state is kept in `manifest.json`. A failed step waits for **Retry processing** and
blocks only the steps that need its output: a failed mix doesn't stop the transcript. A job cut
short by a restart resumes on the next start, and results of each speech chunk and LLM call are
cached under `work/`, so a retry doesn't pay for the same audio twice. Network errors, rate
limits and 5xx responses are retried automatically. While a session is processed it holds a
`processing.lock` file, so the bot and the reprocess script never work on it at the same time.

```
data/sessions/<session-id>/
  transcript.json      # speaker turns with ms offsets (input for Notion)
  transcript.md        # readable transcript, attached to the panel
  summary.json         # tldr, keyPoints, decisions, actionItems, openQuestions
  work/                # per-chunk caches
```

Providers, configuration, deployment and reprocessing are covered in
[`docs/usage.md`](docs/usage.md).

## Development

```bash
npm install
cp .env.example .env   # see docs/usage.md for the variables
npm run register       # print the invite link, register slash commands
npm run dev            # run with reload on change
```

## Tests

```bash
npm test           # all tests; the ffmpeg integration tests are skipped if ffmpeg is missing
npm run typecheck
```

The ffmpeg integration tests encode a real Opus tone, push it through the recorder at a known
time, and check with ffmpeg that the file decodes, the speech lands at the right timestamp, the
mix keeps both speakers in place, a file cut off mid-write (a crash) still mixes, and the full
processing pipeline puts each line at the right time and speaker.

**CI** (`.github/workflows/ci.yml`) runs the type check and every test, including the ffmpeg
ones, on pushes to `main` and on pull requests. To keep it cheap it only runs when code or its
config changes, caches `node_modules` and a static ffmpeg build, and cancels a run when a newer
push arrives.

### Manual check on a test server

Voice can't be fully unit-tested. Before relying on it, check on a test server with two accounts:

- [ ] `/meeting start` from a voice channel: the bot joins, 🔴 nickname, panel appears in the channel chat
- [ ] Both accounts talk → `/meeting stop` → one `tracks/<id>.ogg` per speaker + `mixed.ogg` that plays back correctly
- [ ] Pause → talk → Resume: the paused part is silent
- [ ] Bookmark button and `/meeting note` show up on the panel and in `manifest.json`
- [ ] Everyone leaves the channel → the bot stops after the timeout
- [ ] Kill the bot mid-meeting (`docker kill`, or Ctrl+C twice) and start it again → the session becomes `recorded` with `interrupted: true` and earlier audio is kept
- [ ] With `RECORDER_ROLE_ID` set, a member without the role can't start or stop
- [ ] With `STT_PROVIDER=mock` and `LLM_PROVIDER=mock`: after stop, the panel shows ⏳ → ✅ for Transcript and Summary, the mock TL;DR, and `transcript.md` attached
- [ ] With real providers: names and timestamps in `transcript.md` match who said what; the summary's action items make sense
- [ ] Wrong API key → the panel shows ⚠️ with the error and a **Retry processing** button; fix the key, redeploy, press Retry → it finishes
- [ ] Redeploy while "Transcribing" → after restart it resumes and finishes without re-sending chunks already done
- [ ] `/meeting setup parent:<sandbox page>` creates Meetings and Action Items with the right properties; running it again changes nothing
- [ ] `/meeting start` → the Notion page appears with Status `Recording`, and the panel shows **Open in Notion**
- [ ] With `COLLECT_CHAT_MATERIALS=true`: a file and a link posted in the voice channel's chat appear under Materials; a deleted message's file doesn't
- [ ] After stop: Status `Processing` → `Done`; the page has the recording player, the transcript file and toggle, the summary sections and the bookmarks; the action items are rows linked to the meeting
- [ ] Wrong `NOTION_TOKEN` → Status unchanged in Notion, ⚠️ on the panel; fix the token, redeploy, Retry → `Done`, with no duplicated content and notes typed on the page still there

## Project layout

```
src/
  index.ts                 entry point: Discord client, events, graceful shutdown
  config.ts                env parsing (zod)
  bot/                     slash commands, buttons/modals, control panel
  recorder/                Opus/Ogg writer, time-aligned tracks, receiver → files, ffmpeg mixdown
  sessions/                session manifest, on-disk store, session lifecycle + crash recovery
  pipeline/                job runner (mix, transcribe → summarize), steps, resume/retry, session lock
  notion/                  Notion API client, database setup, page/property builders, publisher
  stt/                     speech-to-text interface + adapters (mock, OpenAI-compatible)
  summarize/               LLM interface + adapters, prompt, summary schema, map-reduce
  transcript/              speech detection/chunking (ffmpeg), merging and rendering transcripts
  http.ts                  HTTP client for providers: timeouts, retries, Retry-After
  scripts/                 register-commands.ts, process-session.ts, notion-setup.ts
```

## Next milestones

- **M4 Polish:** auto-record, cleanup of old audio
