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
```

Regenerate a Material 3 palette block for `web/src/theme/tokens.css`: `node web/scripts/gen-m3-palette.mjs "#42A5F5"`.

## Layout

npm workspaces monorepo: `server/` (`@aria/server`, Express 5 + TypeScript, ESM via tsx) and `web/` (`@aria/web`, React 19 + Vite). Runtime state lives in `data/` (gitignored content): `data/settings.json` plus one directory per notebook at `data/notebooks/<id>/` holding `notebook.json` (metadata + full chat transcript) and `sources/` (uploaded files).

The server is ESM with NodeNext resolution — relative imports must use `.js` suffixes (`import ... from "./config.js"`), even though sources are `.ts`.

## Server architecture

Composition root is `server/src/index.ts`; `app.ts` wires routes and a gate middleware that 503s every `/api` route except `/api/health` unless the app-server is `running`.

**`appserver/`** — `AppServerClient` (client.ts) owns the single long-lived `codex app-server` child: JSON-RPC over stdio (framing in rpc.ts, request/response types in protocol.ts), typed method wrappers (`thread/start`, `turn/start`, …), per-thread notification routing via `subscribeThread`, and crash supervision with backoff (gives up after repeated failures within 60s → state `dead`). Each respawn increments `client.generation`; sessions compare it to know when a Codex thread needs `thread/resume`. The student runs in a **read-only sandbox with `approvalPolicy: "never"`** — approval requests should never happen and are auto-declined so a misconfiguration can't hang a turn.

**`domain/`** — the core logic:
- `store.ts` — `NotebookStore`: in-memory map, persisted per notebook as JSON via atomic writes chained per-notebook so saves apply in order.
- `settings.ts` — global settings (`model`, `effort`, `replyLength`, `probing`). `ARIA_MODEL`/`ARIA_EFFORT` env vars only *seed* the file on first boot; afterwards the file (Settings UI) wins.
- `persona.ts` — the student persona, developer instructions, kickoff prompt, and transcript catch-up block. The `"default"` reply-length/probing rule strings are the original prompt text verbatim, kept so default settings produce a byte-identical persona — don't reword them casually.
- `learning.ts` — the **learning state**: a server-owned belief inventory (`learningState` on the notebook, statuses `unknown | misconception | partial | understood`) deciding WHAT the student knows, kept strictly separate from the persona (HOW it speaks). Generated at kickoff by a one-shot side call (`AppServerClient.runOneShotTurn`, ephemeral thread), injected into every student turn as a hidden `[BELIEF STATE]` block, and updated only by a strict per-turn evaluator pass that runs before the student replies — a vague explanation must not resolve a misconception (at most `challenged`). Everything fails open: parse/RPC failures leave beliefs unchanged and never block the turn; a notebook without state behaves exactly pre-feature. Knobs: `ARIA_EVALUATOR_EFFORT` (default `low`), `ARIA_NO_LEARNING_STATE=1` kill switch. No UI yet — state ships on `GET /api/notebooks/:id` and the `learning-state` SSE event.
- `session.ts` — `SessionManager`, the heart of the app. One `NotebookSession` per notebook: turn state machine (`idle → starting → streaming`), SSE fan-out to attached browsers, a 5-minute inactivity watchdog that interrupts and then force-resets a wedged turn, and overload retry on `turn/start`.

Key invariants in the session layer:
- **One Codex thread per notebook** (the student remembers what it was taught). `developerInstructions` are pinned at thread creation and NOT re-applied on resume — so changing student style starts a *fresh* thread and prepends a transcript catch-up block (`catchUpNeeded`) to the next turn. The applied style is recorded on the notebook (`appliedStyle`) to detect drift.
- **The kickoff turn** (first turn of a notebook, `kickoffDone` flag) is hidden from the UI: deltas aren't broadcast, completed messages are buffered, and only the final agent message is rendered/persisted as the student's opener. Kickoff runs at `max(medium, chosen effort)` unless `ARIA_KICKOFF_EFFORT` pins it.
- Teacher messages are persisted optimistically before `turn/start` and rolled back if it fails; partial student text is persisted with `interrupted: true` when a turn is interrupted/failed.
- Thread notifications are filtered by `turnId` to guard against late/duplicate events.

SSE protocol (one channel per notebook, `routes/notebooks.ts` → `lib/sse.ts`): events `state` (snapshot on attach), `turn-started`, `delta`, `message`, `activity` (`reading-sources` | `thinking`), `learning-state`, `error`, `turn-completed`, each with an incrementing per-session `id`.

## Web architecture

Routing/auth shell in `App.tsx`: an auth gate (`lib/auth.tsx`) with phases `checking | backend-down | signed-out | waiting-oauth | signed-in` wraps two routes, `/` (HomeView) and `/notebook/:id` (SessionView).

- `lib/useTeachingSession.ts` is the streaming chat hook: subscribes to the notebook's SSE channel, buffers deltas and flushes them on `requestAnimationFrame`, and reconciles streaming items (id prefix `streaming:`) with persisted messages.
- `components/` is a hand-rolled Material 3 (Expressive) component library — each component is a `.tsx` + `.css` pair styled exclusively with `--md-sys-*` CSS variables from `theme/tokens.css`. No component framework; match this pattern for new UI.
- Theming is attribute-driven on `:root`: `data-palette` (`blue` default | `purple`) × `data-theme` (`dark` | light default), four token blocks at equal specificity. Blue is generated by `gen-m3-palette.mjs`; purple is material-web baseline kept verbatim.
