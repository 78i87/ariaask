# Aria — learn anything, the right way

Aria is a **learning coach** that tells you *how* to learn anything. Create a
learning project, and an AI coach — grounded in a curated learning-science
knowledge base (distilled from learning coach Justin Sung) — helps you pick the
right technique for your task and stage, plans your study, and makes you do the
thinking (it won't hand over answers you haven't attempted).

One of the techniques it recommends is **teaching it back**: Aria also includes a
calibrated novice student that holds plausible misconceptions and probes exactly
where your explanations get vague — because the fastest way to find the holes in
your own understanding is to teach it to someone who keeps asking "wait, but why?"

Everything is powered by **OpenAI Codex** — you sign in with your own
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

Open http://localhost:5173, sign in with OpenAI, and create your first learning
project.

## How it works

1. **Create a learning project** from a typed topic ("how transformers work") or
   by uploading sources (txt / md / pdf — PDFs are text-extracted on upload).
2. **The coach greets you**, reads any materials you added, and asks what you
   want to be able to do and where you're starting from.
3. **It coaches the process.** It recommends one concrete technique at a time
   (with why it fits and the mistake to avoid), grounded in its knowledge base,
   and pushes back with scaffolds instead of answers when you ask a content
   question you haven't attempted.
4. **Guided reading** opens any PDF source with the coach's highlights in the
   document itself: key passages marked with pause / simplify / compare /
   connect / judge prompts (plus apply points and technique suggestions), a rail
   to work through them, and after-reading steps that hand back into the coach
   chat. Pick your level — scaffolding fades from full prompts (learner) to a
   few nudges (experienced), because the loop is supposed to end up in your
   head, not in the UI.
5. **Teach it back** (a technique the coach can hand you) opens the Aria student:
   it reacts with calibrated confusion, tests rules by restating them slightly
   wrong, presents contradictions as its own puzzlement (never corrects you), and
   shows a genuine "aha" when an explanation lands — then asks something deeper.
6. **Practise interviews** in projects built around a target role and required
   CV, with an optional company or job description. Cyra runs the main interview,
   keeps a live competency-coverage map, and gives a candid debrief when you end it.

Projects are created before any chat starts. Their shared sources feed the
learning coach, reverse tutor or interview practice; projects can be renamed,
archived, restored or deleted from the persistent sidebar.

## Architecture

- **`server/`** — Express + TypeScript. Owns one long-lived `codex app-server`
  child process, speaking JSON-RPC over stdio. Each learning project has up to three
  Codex personas on their own threads: the **coach**
  ([`server/src/domain/coach.ts`](server/src/domain/coach.ts)), the **Aria
  student** ([`server/src/domain/persona.ts`](server/src/domain/persona.ts)), and
  on-demand **Cyra** expert threads. Interview projects instead use Cyra as the
  main interviewer ([`server/src/domain/interviewer.ts`](server/src/domain/interviewer.ts))
  with a competency map from [`server/src/domain/coverage.ts`](server/src/domain/coverage.ts).
  Chat history is persisted as per-notebook
  JSON under `data/`; responses stream to the browser over per-persona SSE
  channels.
- **`kb/`** — the coach's learning-science knowledge base (curated principle /
  technique docs + cleaned transcripts). Indexed once to `data/kb-index.json`
  ([`server/src/domain/kb.ts`](server/src/domain/kb.ts)) and retrieved into each
  coach turn. Add material by dropping a cleaned `.md` in `kb/` and restarting.
- **`web/`** — React + Vite, hand-rolled Material 3 (Expressive) components over
  CSS design tokens. The coach shell is
  [`web/src/views/CoachShell.tsx`](web/src/views/CoachShell.tsx); the coach and
  teach-back streaming hooks are
  [`web/src/lib/useCoachThread.ts`](web/src/lib/useCoachThread.ts) and
  [`web/src/lib/useTeachingSession.ts`](web/src/lib/useTeachingSession.ts).

The student runs in a **read-only sandbox** with approvals disabled — it can read
your uploaded sources but cannot write files or run commands.

## Settings

The gear button opens autosaving Teaching, Appearance and Advanced settings:
coaching style, chat layout, model, thinking level, student style, reading
recall, color theme, local Codex CLI status/update, and account/sign-out. Model
and thinking apply to every project immediately;
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
| `ARIA_COACH_EFFORT` | (thinking level) | Reasoning effort for coach turns |
| `ARIA_READING_EFFORT` | `medium` | Reasoning effort for the guided-reading annotation pass |
| `ARIA_NO_KB` | (off) | Disable the knowledge base; the coach runs persona-only |
| `ARIA_KB_DIR` | `./kb` | Location of the knowledge-base corpus |
| `CODEX_BIN` | `codex` | Path to the Codex CLI |

## Scripts

- `npm run dev` — run backend + frontend together
- `npm run dev:server` / `npm run dev:web` — run one side
- `npm test -w @aria/server` — run server unit and route tests
- `npm test -w @aria/web` — run Vitest component tests
- `npm run typecheck` — typecheck both workspaces

The app tracks how often you use each technique and adapts: after several
learner-mode readings it defaults the level one step lighter, and the coach
itself fades its scaffolding as your habits internalize. Set the overall
**Coaching style** (Guided → Intermediate → Experienced) in Settings — at the
far end the coach treats you as a peer and critiques your plan instead of
handing you one, because the goal is for the thinking to end up in your head.
