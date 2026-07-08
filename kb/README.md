# Aria Learning-Coach Knowledge Base

Curated learning-science corpus grounding the Learning Coach persona. Distilled from
Justin Sung's teaching (transcripts in `transcripts/`). The server RAG-indexes every
`.md` file here (except this README) into `data/kb-index.json` and retrieves relevant
excerpts into each coach turn.

## Layout

- `core-model.md` — the distilled framework; source of truth for the summary baked
  into the coach persona (`server/src/domain/coach.ts`). Keep the two in sync.
- `principles/` — one doc per foundational principle (memory handling, cognitive load,
  encoding vs review, higher-order learning, self-regulation, clear thinking).
- `techniques/` — one doc per technique. The coach's recommendation menu.
- `guides/` — synthesis guides: `technique-selection.md` (task × stage → technique,
  the most load-bearing doc) and `skill-acquisition.md` (RAIL).
- `transcripts/` — cleaned full video transcripts (retrieval depth; timestamps and
  filler removed).

## Doc schema

YAML frontmatter is curation metadata (`name`, `type: principle|technique|guide|core`,
`for:`, `stages:`, `effectiveness:`, `effort:`, `sources:`). **Important facts must
also appear in the prose** — RAG chunks carry only text plus the nearest heading, so
frontmatter alone is invisible to retrieval. Technique docs follow: What it's for /
When / How / Common mistakes / Signs it's working, plus coaching cues where useful.

## Adding material

1. New transcript: convert/clean with
   `node scripts/kb-clean-transcript.mjs <in.txt> kb/transcripts/<slug>.md "<Title>" [url]`
   (for YouTube, fetch subtitles first — e.g. `yt-dlp --write-auto-subs --sub-lang en
   --skip-download <url>`, then convert the VTT to plain text).
2. New/updated curated doc: edit the markdown directly, following the schema above.
3. Restart the server. The boot-time fingerprint check detects the change and rebuilds
   `data/kb-index.json` automatically. `ARIA_NO_KB=1` disables the KB entirely.

If a change belongs in the coach's always-present persona (not just retrieval), update
`core-model.md` *and* the persona block in `server/src/domain/coach.ts`.
