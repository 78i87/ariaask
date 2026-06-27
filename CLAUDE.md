# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Aria is a "reverse tutor": the user teaches, and an AI student (powered by OpenAI Codex via the user's own ChatGPT account) responds with calibrated confusion and probing questions. The server spawns `codex app-server` as a child process — the Codex CLI (`npm install -g @openai/codex`) must be on PATH for anything beyond `/api/health` to work.

Use "Aria" in the product sense to mean both the system and the AI student the user is teaching. In implementation notes, be precise about the layer: the app/server orchestrates notebooks, sessions, sources, and Codex threads; the in-character Aria student is the Codex thread shaped by `persona.ts`; its learned state is the server-owned belief inventory.

## Commands

```bash
npm install          # once, at the repo root (npm workspaces)
npm run dev          # backend (Express, :5275) + frontend (Vite, :5173) together
npm run dev:server   # backend only (tsx watch)
npm run dev:web      # frontend only; Vite proxies /api → localhost:5275
npm run typecheck    # tsc on both workspaces — the only check; there is no lint or test suite
npm run build -w @aria/web   # frontend production build (also runs web typecheck)
npm run start -w @aria/server # run the backend once without watch
```

Regenerate a Material 3 palette block for `web/src/theme/tokens.css`: `node web/scripts/gen-m3-palette.mjs "#42A5F5"`.

## Layout

npm workspaces monorepo: `server/` (`@aria/server`, Express 5 + TypeScript, ESM via tsx) and `web/` (`@aria/web`, React 19 + Vite). Runtime state lives in `data/` (gitignored content): `data/settings.json` plus one directory per notebook at `data/notebooks/<id>/` holding `notebook.json` (metadata + full chat transcript), `sources/` (uploaded files and discovered web sources), and optionally `rag-index.json` (server-only retrieval index). Local embedding models are cached under `data/models/`.

The server is ESM with NodeNext resolution — relative imports must use `.js` suffixes (`import ... from "./config.js"`), even though sources are `.ts`.

## Server architecture

Composition root is `server/src/index.ts`; `app.ts` wires routes and a gate middleware that 503s every `/api` route except `/api/health` unless the app-server is `running`.

**`appserver/`** — `AppServerClient` (client.ts) owns the single long-lived `codex app-server` child: JSON-RPC over stdio (framing in rpc.ts, request/response types in protocol.ts), typed method wrappers (`thread/start`, `turn/start`, …), per-thread notification routing via `subscribeThread`, and crash supervision with backoff (gives up after repeated failures within 60s → state `dead`). Each respawn increments `client.generation`; sessions compare it to know when a Codex thread needs `thread/resume`. The student runs in a **read-only sandbox with `approvalPolicy: "never"`** — approval requests should never happen and are auto-declined so a misconfiguration can't hang a turn.

**`domain/`** — the core logic:
- `store.ts` — `NotebookStore`: in-memory map, persisted per notebook as JSON via atomic writes chained per-notebook so saves apply in order.
- `settings.ts` — global settings (`model`, `effort`, `replyLength`, `probing`, `ragMode`, `ragRecall`). `ARIA_MODEL`/`ARIA_EFFORT` env vars only *seed* the file on first boot; afterwards the file (Settings UI) wins.
- `persona.ts` — the student persona, developer instructions, kickoff prompt, and transcript catch-up block. The `"default"` reply-length/probing rule strings are the original prompt text verbatim, kept so default settings produce a byte-identical persona — don't reword them casually.
- `learning.ts` — the **learning state**: a server-owned belief inventory (`learningState` on the notebook, statuses `unknown | misconception | partial | understood`) deciding WHAT the student knows, kept strictly separate from the persona (HOW it speaks). Generated at kickoff by a one-shot side call (`AppServerClient.runOneShotTurn`, ephemeral thread), injected into every student turn as a hidden `[BELIEF STATE]` block, and updated only by a strict per-turn evaluator pass that runs before the student replies — a vague explanation must not resolve a misconception (at most `challenged`). The inventory doubles as the **knowledge map**: beliefs carry an `area` (cluster) and `deps` (prerequisite ids); initial generation stakes out 10–25 concepts (hard cap 40, evaluator adds ≤2/turn). Past `WORKING_SET_CAP` (14) the per-turn block goes two-tier — `selectWorkingSet` keeps all misconceptions, just-changed beliefs, and the entries most lexically relevant to the teacher's message in full detail, rolls the rest up by name; smaller inventories render byte-identical to the pre-map block. Everything fails open: parse/RPC failures leave beliefs unchanged and never block the turn; a notebook without state behaves exactly pre-feature. Knobs: `ARIA_EVALUATOR_EFFORT` (default `low`), `ARIA_NO_LEARNING_STATE=1` kill switch (also nulls `learningState` on GET so the map UI hides). State ships on `GET /api/notebooks/:id` and the `learning-state` SSE event; the web renders it as the "Knowledge map" pane (`KnowledgeMapView`, toggled via the app-bar chip in `SessionView`).
- `intake.ts` — pre-session setup ("tune Aria"): deterministic level/research questions plus up to two generated focus questions. Answers calibrate learning-state generation, can request pre-kickoff online source discovery, and are answered once before kickoff. `ARIA_NO_INTAKE=1` disables the form for new notebooks.
- `discover.ts` — online source discovery. A web-search-enabled Codex turn finds public URLs, then the server downloads/extracts them into individual source files (`origin: "research"`, optional `originUrl`) that are previewable, deletable, and RAG-indexed. It powers intake research and the mid-session "Find online" action, fails open per URL, and uses `ARIA_RESEARCH_EFFORT` (default `medium`) plus `ARIA_DISCOVER_MAX` (default `5`, clamped 1–10).
- `rag.ts` — server-side retrieval over source files. Large readings (or any reading when `ragMode: "always"`) are chunked and embedded with Transformers.js, saved to `rag-index.json`, and recalled as hidden excerpts before non-kickoff turns. It fails open and can be disabled with `ARIA_NO_RAG=1`; other knobs are `ARIA_RAG_MODEL`, `ARIA_RAG_MIN_WORDS`, and `ARIA_RAG_WAIT_MS`.
- `session.ts` — `SessionManager`, the heart of the app. One `NotebookSession` per notebook: turn state machine (`idle → starting → streaming`), SSE fan-out to attached browsers, a 5-minute inactivity watchdog that interrupts and then force-resets a wedged turn, and overload retry on `turn/start`.
- `cyra-session.ts` / `cyra.ts` — "Ask Cyra" expert-teacher threads. These are separate Codex threads stored under `notebook.cyraThreads`, run concurrently with the Aria student thread, use source retrieval with expert framing, and intentionally mirror only the generic session mechanics instead of sharing the dense Aria kickoff/evaluator code.

Key invariants in the session layer:
- **One Codex thread per notebook** (the student remembers what it was taught). `developerInstructions` are pinned at thread creation and NOT re-applied on resume — so changing student style starts a *fresh* thread and prepends a transcript catch-up block (`catchUpNeeded`) to the next turn. The applied style is recorded on the notebook (`appliedStyle`) to detect drift.
- **The kickoff turn** (first turn of a notebook, `kickoffDone` flag) is hidden from the UI: deltas aren't broadcast, completed messages are buffered, and only the final agent message is rendered/persisted as the student's opener. Kickoff runs at `max(medium, chosen effort)` unless `ARIA_KICKOFF_EFFORT` pins it.
- **The intake pipeline gates kickoff** for new notebooks when enabled: clients must submit `POST /api/notebooks/:id/intake` before any Aria turn can start. If research is requested, `SessionManager.runIntakePipeline` discovers and downloads online sources first, then starts the hidden kickoff.
- **Rewind editing is destructive by design**: `POST /api/notebooks/:id/messages/:mid/edit` replaces a past teacher message, deletes that message and everything after it, abandons the Codex thread, re-derives the belief inventory from the surviving prefix, then sends the edited text as a fresh turn. Cyra mirrors this at `/cyra/:tid/messages/:mid/edit`.
- **Source changes after kickoff are queued into the next turn**: uploads accept `.txt`, `.md`, and `.pdf` only, max 10 files / 25MB each; PDFs get a sibling `.extracted.txt` when text extraction succeeds. Because thread instructions are pinned, added/removed files are recorded as `pendingNewSources` / `pendingRemovedSources` and injected as hidden notes on the next student turn; explicit upload/delete also retries and rebuilds the RAG index.
- Teacher messages are persisted optimistically before `turn/start` and rolled back if it fails; partial student text is persisted with `interrupted: true` when a turn is interrupted/failed.
- Thread notifications are filtered by `turnId` to guard against late/duplicate events.

SSE protocol (one channel per notebook, `routes/notebooks.ts` → `lib/sse.ts`): events `state` (snapshot on attach), `turn-started`, `delta`, `message`, `activity` (`reading-sources` | `thinking` | `researching`), `learning-state`, `sources-updated`, `discover-completed`, `notice`, `error`, `turn-completed`, each with an incrementing per-session `id`. Cyra threads have their own `/cyra/:tid/events` channel with the same streaming events minus kickoff/intake/source-discovery fields.

## Web architecture

Routing/auth shell in `App.tsx`: an auth gate (`lib/auth.tsx`) with phases `checking | backend-down | signed-out | waiting-oauth | signed-in` wraps two routes, `/` (HomeView) and `/notebook/:id` (SessionView).

- `lib/useTeachingSession.ts` is the streaming chat hook: subscribes to the notebook's SSE channel, buffers deltas and flushes them on `requestAnimationFrame`, reconciles streaming items (id prefix `streaming:`) with persisted messages, and drives the intake/research/kickoff loading states.
- `lib/useCyraThread.ts` is the parallel streaming hook for "Ask Cyra"; `SessionView` switches between the main Aria thread and Cyra expert threads via `ThreadBar`. A split-chat preference (settings dialog "Chat layout", localStorage via `lib/splitChat.ts`) instead pins one Cyra conversation beside the Aria pane on wide windows (≥1141px): the Cyra chips move to the right pane's own bar, "Ask Cyra" merges the question into that pane's composer rather than opening a new thread (a thread is created only when none exists), and the knowledge map always takes the full panel (the Cyra pane steps aside while the map is open).
- `components/` is a hand-rolled Material 3 (Expressive) component library — each component is a `.tsx` + `.css` pair styled exclusively with `--md-sys-*` CSS variables from `theme/tokens.css`. No component framework; match this pattern for new UI.
- Theming is attribute-driven on `:root`: `data-palette` (`blue` default | `purple`) × `data-theme` (`dark` | light default), four token blocks at equal specificity. Blue is generated by `gen-m3-palette.mjs`; purple is material-web baseline kept verbatim.
