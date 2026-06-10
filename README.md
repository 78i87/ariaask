# Aria — the reverse tutor

You don't get tutored. **You teach.** Aria is a calibrated novice student that
holds plausible misconceptions and probes exactly where your explanations get
vague — because the fastest way to find the holes in your own understanding is to
teach it to someone who keeps asking "wait, but why?"

The AI student is powered by **OpenAI Codex** — you sign in with your own
ChatGPT/OpenAI account, no API key required.

## Prerequisites

- **Node 18+** (developed on Node 24)
- **Codex CLI** on your PATH: `npm install -g @openai/codex`
  Aria spawns `codex app-server` under the hood. You can sign in from inside the
  app, or ahead of time with `codex login`.

## Run

```bash
npm install
npm run dev
```

- Frontend (Vite): http://localhost:5173
- Backend (Express): http://localhost:5275 (the Vite dev server proxies `/api` to it)

Open http://localhost:5173, sign in with OpenAI, and create your first notebook.

## How it works

1. **Create a notebook** from a typed topic ("how transformers work") or by
   uploading sources (txt / md / pdf — PDFs are text-extracted on upload).
2. **The student opens** with its current shaky understanding and one question.
3. **You teach.** It reacts with calibrated confusion, tests rules by restating
   them slightly wrong, presents contradictions as its own puzzlement (never
   corrects you), and shows a genuine "aha" when an explanation actually lands —
   then asks something one level deeper.

## Architecture

- **`server/`** — Express + TypeScript. Owns one long-lived `codex app-server`
  child process, speaking JSON-RPC over stdio. One Codex thread per notebook
  (the student remembers what you taught it). Chat history is persisted as
  per-notebook JSON under `data/`. Student responses stream to the browser over
  a per-notebook SSE channel. The student persona and kickoff prompts live in
  [`server/src/domain/persona.ts`](server/src/domain/persona.ts).
- **`web/`** — React + Vite, hand-rolled Material 3 (Expressive) components over
  CSS design tokens. The streaming chat hook is
  [`web/src/lib/useTeachingSession.ts`](web/src/lib/useTeachingSession.ts).

The student runs in a **read-only sandbox** with approvals disabled — it can read
your uploaded sources but cannot write files or run commands.

## Settings

The gear button in the top bar opens Settings: model, thinking level, student
style (reply length + probing intensity), color theme (blue default / purple),
and account/sign-out. Model and thinking apply to every notebook immediately;
changing student style restarts the notebook's thread behind the scenes (the
student re-reads the transcript, so nothing it learned is lost). Settings
persist in `data/settings.json`.

## Configuration (optional env vars)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `5275` | Backend port |
| `ARIA_MODEL` | (none) | Seeds the model setting on first boot only; after that `data/settings.json` (the Settings UI) wins |
| `ARIA_EFFORT` | (model default) | Seeds the thinking-level setting on first boot only |
| `ARIA_KICKOFF_EFFORT` | (auto) | Pin the opener's effort; otherwise max(medium, chosen thinking level) |
| `ARIA_DATA_DIR` | `./data` | Where notebooks and settings are stored |
| `CODEX_BIN` | `codex` | Path to the Codex CLI |

## Scripts

- `npm run dev` — run backend + frontend together
- `npm run dev:server` / `npm run dev:web` — run one side
- `npm run typecheck` — typecheck both workspaces

v1 is conversational Q&A only — no scoring, debrief, or quizzes (yet).
