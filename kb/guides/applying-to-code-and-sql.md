---
name: Applied guide — legacy codebases & large SQL databases
type: guide
for: [software engineers, understanding legacy systems, large schemas, onboarding]
stages: [all]
sources: ["Learning Efficiency Tips (ChatGPT synthesis session)", "How to Learn Fast Full Course"]
---

# Applied guide — legacy codebases & large SQL databases

A worked translation of the core principles into a professional domain. Legacy systems
are nearly pure **relational knowledge**: the value isn't in files or tables but in what
calls what, what writes what, and what breaks what. The goal is never "understand the
whole codebase" — it is "build a map of how this system behaves, one workflow at a
time."

## Core moves

- **Learn flows, not files.** Never read top-to-bottom (learning a city by reading
  street names alphabetically). Pick one real workflow — "user places an order",
  "nightly job updates balances" — and trace it end-to-end: entry point → code path →
  reads/writes → side effects → downstream jobs/reports. This is priming/schema-building
  applied to systems.
- **Thin layers, not tiny pieces.** First pass wide and shallow (main services, entry
  points, business entities, schemas, scheduled jobs, external systems, risky areas) to
  plant anchor points; second pass one workflow deep; third pass files/queries/edge
  cases. Isolating small pieces too early strips the context that makes them meaningful.
- **Run the deep processing loop on everything you open.** Simplify (what is this,
  plainly?), compare (how does this table differ from the similar one? current state vs
  history? source-of-truth vs derived?), connect (who calls/reads/writes this? which
  jobs and reports depend on it?), judge (is this risky? money/security/reporting?
  deprecated? what breaks if it changes?).
- **Think on paper.** Working memory overloads instantly at system scale. Rough maps —
  code-path traces, data-lineage chains (raw → staging → core → derived → reports),
  entity-relationship sketches. Messy is fine; the goal is mental organization, not
  documentation.
- **Apply from day zero.** You understand *by* doing: run one test, trace one request,
  add a log line, reproduce one bug; query 10 rows, count by status, join two tables to
  test an assumed relationship, trace one customer ID through the whole database.
  Predict, then verify.
- **Hypothesize before searching.** Observe → hypothesize → verify (query, code search,
  commit history, teammate) → update the map. Wrong hypotheses are productive — they
  reveal the real structure. In legacy systems treat names, comments, and apparent
  meanings as hypotheses until verified.

## Profiles (the schema-building artifacts)

**Table profile** — type (core entity / transaction / join / history / staging /
derived / reporting / config / log), **grain** (what one row represents — the single
biggest source of SQL confusion), primary key, business meaning, written by, read by,
important columns, **dangerous assumptions** ("status ≠ paid", "cancelled orders can
still have payments"), open questions. Classifying a new table by type is itself
chunking — it makes hundreds of tables hold-able.

**Function/file profile** — purpose, inputs/outputs, reads/writes, calls/called-by,
hidden business rules, risk level. The question is never just "what does this do?" but
"where does this sit in the system?"

## PACER, translated

- **Procedural** (run the app, migrations, deploys, backfills) → *practice it*, don't
  read about it.
- **Conceptual** (how orders relate to invoices, service boundaries, permission model)
  → *map it*.
- **Reference** (column names, env vars, enum values, cron schedules) → *store it* in a
  searchable glossary; never memorize.
- **Evidence** (a real order lifecycle, a production log, a report discrepancy, one
  concrete traced example) → *store and rehearse*; one real example teaches more than a
  generic explanation.

## Retrieval that matches the job

Not "what does column X mean" flashcards. Close the code/schema and: explain the
checkout flow; draw the tables behind invoice generation; predict the blast radius of
changing `customer_id`; explain why the report disagrees with the dashboard; given this
bug, name the three most likely places. Then open everything and correct yourself.

## The loop and the routine

**Loop:** pick a real workflow/bug/report → find the entry point → trace one real
example (real IDs) → draw the flow → mark Known / Likely / Unknown / Risky → verify →
explain it closed-book → make one safe change or test → log the gap → repeat.

**Routine:** daily 20–60 min (trace one thing, map one relationship, verify one
assumption, one log entry); weekly (update system map, entity map, glossary, risk list,
unknowns list); end of week closed-book: explain the system, draw the main
relationships, top-5 risky workflows, top-5 tables, top-5 things still not understood.

## Using AI without losing the learning

Good: "here's my current map — challenge it"; "here are five table profiles — what
relationships am I missing?"; "quiz me on this workflow"; "explain what business logic
this query implies" *after* you've formed a hypothesis. Bad: "explain this codebase",
"summarize this schema so I don't have to understand it" — outsourced organization is
the illusion of competence, and it won't be there during the incident.
