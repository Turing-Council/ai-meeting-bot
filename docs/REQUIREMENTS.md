# Turing Voice Bot — Requirements

## Context
This is a new project; `turing-voice-bot/` is empty. The goal is a Discord bot that joins a
voice channel, records the meeting, and turns each meeting into a structured Notion entry with
the event, notes, transcript, recording and any material shared during the call. It is for
closed, private use, so compliance is out of scope.

**Decisions made (from Q&A):**
| Topic | Decision |
|---|---|
| Notion | Bot uses **new dedicated databases** (Meetings + Action Items) that it creates during setup |
| Trigger | **Slash command** + **auto-record on channel join** |
| Speech-to-text (STT) | **Pluggable provider interface**, choice deferred (cloud API or self-hosted Whisper) |
| Summaries (LLM) | **Pluggable provider interface**, choice deferred (any cloud or self-hosted LLM) |
| Language | **English only** |
| Notion plan | **Paid**, so recordings and transcripts are attached directly through the Notion File Upload API (multipart) |
| Hosting | **VPS with Dokploy** (Docker image, persistent volume, ffmpeg inside the image) |
| People | **Plain Discord display names** for the MVP; mapping to Notion users comes later |
| Materials | **Files and links from the voice channel's text chat** + **recording + transcript** |

---

## Tier 0 — MVP (must-have)
- **R0.1 Join / leave.** The bot joins on `/meeting start` or when auto-record triggers. It
  leaves on `/meeting stop`, the ⏹ button, or when the channel has been empty for N minutes
  (default 2).
- **R0.2 Record each speaker.** One Opus stream per Discord user, so each speaker is already
  separated without extra processing. The bot also builds a mixed track for playback. Audio is
  written to disk in chunks as it arrives, so a crash loses at most one chunk.
- **R0.3 Session state.** At most one active session per server (a bot can be in one voice channel per server). Recording status is
  visible in two places: the bot's nickname gets a 🔴 prefix, and a control panel message is
  posted in the voice channel's text chat.
- **R0.4 Persist.** On stop, the bot encodes the audio to OGG/Opus (or MP3) and stores it on the
  Dokploy volume.
- **R0.5 Notion page.** A Meeting page is created **at start** with status `Recording`. It is
  completed at the end with date, duration, channel, participants and the attached recording.

## Tier 1 — Processing pipeline
- **R1.1 STT interface.** `transcribe(track) → segments[{start, end, text}]`. The first adapter
  is a cloud API. Each speaker's track is transcribed separately, then all segments are merged in
  time order into `[00:12:31] Alice: …`.
- **R1.2 AI summary (any LLM).** `summarize(transcript) → summary`, behind its own provider
  interface. The output is structured JSON:
  - TL;DR
  - Key points
  - Decisions
  - Action items (task, owner name, due date if mentioned)
  - Open questions

  Long meetings are summarized in chunks, then the chunk summaries are combined (map-reduce).
- **R1.3 Job pipeline.** Steps run in order: encode → transcribe → summarize → publish. Each step
  is idempotent, retries on failure, and can resume after a restart. Progress shows in the Notion
  `Status` property and on the Discord control panel.

## Tier 2 — Full Notion mapping
- **R2.1 Meetings database** properties:
  - Title
  - Date (start to end)
  - Duration
  - Channel
  - Participants (multi-select of names)
  - Type/Tags
  - Status (Recording / Processing / Done / Failed)
  - Recording (file)
  - Transcript (file)
  - Trigger (manual / auto)
- **R2.2 Page body template:**
  1. Summary
  2. Decisions
  3. Action items (to-do blocks)
  4. Open questions
  5. Bookmarks (`/meeting note` markers)
  6. Materials
  7. Full transcript (inside a toggle)
- **R2.3 Action Items database.** Properties: Task, Owner (text), Due, Status, and a relation to
  the Meeting.
- **R2.4 Materials.** Every attachment and link posted in the voice channel's text chat while
  the session is active is re-uploaded or linked under "Materials".
- **R2.5 Bootstrap.** A one-time `setup` script (or `/meeting setup`) creates both databases
  under a given parent page and saves their IDs to config.

## UX
- **`/meeting start [title] [type]`**
  - The bot joins the caller's voice channel.
  - It posts a control panel with a live timer, a Notion link, and three buttons:
    **⏸ Pause · 📝 Bookmark · ⏹ Stop**.
- **`/meeting note <text>`** adds a timestamped bookmark. The summarizer receives it as context,
  and it is listed on the Notion page.
- **`/meeting stop` or ⏹**
  - The panel changes to "Processing…".
  - When the pipeline finishes, the panel is edited to show the TL;DR, action items and the
    Notion link.
- **Auto-record** (configured per voice channel)
  - Starts when at least N humans (default 2) are in a whitelisted channel.
  - Gets an auto-generated title, `<Channel> — <date>`, which can be renamed in Notion.
  - Sessions shorter than M minutes (default 3) are discarded.
- **Permissions:** a configurable Discord role can start, stop and set up recordings.

## Stack & architecture
- **TypeScript + discord.js / `@discordjs/voice`.** This library has the most mature
  voice-receive support, including support for DAVE, Discord's end-to-end encryption for voice.
- **Modules:**
  - `bot/` handles commands, the control panel and voice sessions.
  - `recorder/` handles per-user streams, chunked writing and the mixdown via ffmpeg.
  - `pipeline/` is the job runner.
  - `stt/` holds the provider interface and adapters.
  - `summarize/` holds the LLM provider interface and adapters, the prompt and the JSON schema.
  - `notion/` holds the setup, page builder and file uploads.
- **State:** SQLite on the volume stores sessions, job steps and config. That is enough for one
  server.
- **Deploy:** a Dockerfile (Node + ffmpeg), deployed from git through Dokploy, with secrets in
  environment variables: `DISCORD_TOKEN`, `NOTION_TOKEN`, `LLM_*`, `STT_*`.

## Known constraints / risks
- Discord does not officially support bots receiving voice. A Discord update could break it, so
  the library version must be kept pinned and up to date.
- Bots **cannot capture screen share or video**, only audio and text chat.
- Provider-agnostic: transcription (STT) and summarization (LLM) sit behind their own
  interfaces, so any provider, cloud or self-hosted, can be plugged in through config.
- Notion blocks and files have per-request limits, so long transcripts go into a toggle split
  over multiple blocks, plus an attached `.txt`/`.md` file.

## Assumed defaults (override if wrong)
- A single Discord server. **One recording at a time per server**: Discord lets a bot be in only one
  voice channel per server (recording two channels at once would need a second bot account).
- Summary output is in English.
- Raw audio is kept on the VPS for 30 days after a successful Notion upload, then deleted.

## Milestones
| # | Milestone | Scope |
|---|---|---|
| M0 | Setup | Repo, Docker, Dokploy, bot token |
| M1 | Record | Join, record, save audio |
| M2 | Transcribe & Summarize | STT + LLM, job pipeline |
| M3 | Notion | Databases, meeting page, action items |
| M4 | Polish | Auto-record, permissions, cleanup |

## Verification
- **Recorder:** a test Discord server with 2 accounts. Run start, pause, bookmark and stop,
  check the per-user and mixed files, and kill the process mid-meeting to confirm the earlier
  chunks survive.
- **Pipeline:** feed a fixture recording through mock STT and LLM providers (plus one real provider), then check
  that the summary matches the JSON schema.
- **Notion:** run setup against a sandbox parent page, then confirm the database schemas, the
  page template, the attachments and the Action Item relations.
- **Auto-record:** confirm the threshold join and the short-session discard.
- **Deploy:** deploy to Dokploy, restart the container while a job is running, and confirm the
  job resumes.
