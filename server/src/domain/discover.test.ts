import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDiscoverPrompt,
  buildDiscoveryClarificationPrompt,
  buildInterviewDiscoverPrompt,
  createPinnedLookup,
  downloadJobDescriptionFile,
  parseDiscoveryClarificationQuestions,
  preferReadableTitle,
} from "./discover.js";

test("pinned DNS lookup supports Node's scalar and all-address callback shapes", () => {
  const lookup = createPinnedLookup({ address: "93.184.216.34", family: 4 });
  let scalar: unknown[] | null = null;
  let all: unknown[] | null = null;

  lookup("example.com", {}, (err, address, family) => {
    scalar = [err, address, family];
  });
  lookup("example.com", { all: true }, (err, addresses, family) => {
    all = [err, addresses, family];
  });

  assert.deepEqual(scalar, [null, "93.184.216.34", 4]);
  assert.deepEqual(all, [null, [{ address: "93.184.216.34", family: 4 }], undefined]);
});

test("source download rejects a loopback destination before connecting", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-discover-test-"));
  try {
    await assert.rejects(
      downloadJobDescriptionFile(dir, "http://127.0.0.1:1/internal", new Set()),
      /private IPv4 address rejected/i,
    );
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("clarification prompt carries project and originating activity context", () => {
  const prompt = buildDiscoveryClarificationPrompt({
    topic: "Learn distributed systems",
    activity: "interview",
    activityTitle: "Staff engineer interview",
    interviewTarget: "Staff engineer at Example Co",
    focus: "system design tradeoffs",
    request: "Help me prepare for the architecture round",
    manifest: "- CV\n- Job description",
  });

  assert.match(prompt, /Project goal: Learn distributed systems/);
  assert.match(prompt, /Originating activity: interview \("Staff engineer interview"\)/);
  assert.match(prompt, /Interview target: Staff engineer at Example Co/);
  assert.match(prompt, /Existing session focus: system design tradeoffs/);
  assert.match(prompt, /Return zero questions when the request is already specific enough/);
});

test("clarification parser accepts zero questions and caps valid output at two", () => {
  assert.deepEqual(parseDiscoveryClarificationQuestions('{"questions":[]}'), []);

  const parsed = parseDiscoveryClarificationQuestions(
    JSON.stringify({
      questions: [
        { id: "depth", question: "What depth?", options: ["Overview", "Practical", "Research"] },
        { id: "format", question: "Which source style?", options: ["Docs", "Course notes", "Papers", "Examples"] },
        { id: "extra", question: "Ignored?", options: ["A", "B", "C"] },
      ],
    }),
  );

  assert.equal(parsed?.length, 2);
  assert.deepEqual(parsed?.[0], {
    id: "depth",
    question: "What depth?",
    options: [
      { value: "Overview", label: "Overview" },
      { value: "Practical", label: "Practical" },
      { value: "Research", label: "Research" },
    ],
    allowsCustom: true,
  });
});

test("clarification parser rejects malformed envelopes and drops weak questions", () => {
  assert.equal(parseDiscoveryClarificationQuestions("not json"), null);
  assert.equal(parseDiscoveryClarificationQuestions('{"questions":"wrong"}'), null);
  assert.deepEqual(
    parseDiscoveryClarificationQuestions(
      JSON.stringify({
        questions: [
          { id: "weak", question: "Too few choices?", options: ["One", "Two"] },
          { id: "good", question: "Useful?", options: ["One", "Two", "Three", "Three"] },
        ],
      }),
    ),
    [
      {
        id: "good",
        question: "Useful?",
        options: [
          { value: "One", label: "One" },
          { value: "Two", label: "Two" },
          { value: "Three", label: "Three" },
        ],
        allowsCustom: true,
      },
    ],
  );
});

test("learning and interview search prompts include the structured refinement brief", () => {
  const refinements = [
    { question: "What depth?", answer: "Practical implementation" },
    { question: "Which format?", answer: "Official documentation" },
  ];
  const learning = buildDiscoverPrompt({
    topic: "Playwright",
    focus: null,
    note: null,
    request: "Build reliable end-to-end tests",
    refinements,
    manifest: null,
    knownUrls: [],
    max: 5,
  });
  const interview = buildInterviewDiscoverPrompt({
    role: "QA engineer",
    company: "Example Co",
    note: null,
    request: "Prepare for a technical screen",
    refinements,
    manifest: null,
    knownUrls: [],
    max: 5,
  });

  for (const prompt of [learning, interview]) {
    assert.match(prompt, /What the user needs these sources to help with:/);
    assert.match(prompt, /- What depth\?: Practical implementation/);
    assert.match(prompt, /- Which format\?: Official documentation/);
  }
});

test("downloaded placeholder titles fall back to the model-selected source title", () => {
  assert.equal(
    preferReadableTitle("references-details-empty", "Making Retries Safe with Idempotent APIs"),
    "Making Retries Safe with Idempotent APIs",
  );
  assert.equal(
    preferReadableTitle("Group Communication, Membership, and Failure Detection", "Fallback"),
    "Group Communication, Membership, and Failure Detection",
  );
});
