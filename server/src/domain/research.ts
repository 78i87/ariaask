import fs from "node:fs/promises";
import path from "node:path";
import { approxWordCount } from "./extract.js";
import { sanitizeName, type Notebook, type NotebookStore, type SourceFile } from "./store.js";

/**
 * Pre-session online research: a one-shot, web-search-enabled turn writes a
 * background digest that becomes a normal (visible, previewable, deletable)
 * source file for the session.
 */

export function buildResearchPrompt(opts: {
  topic: string;
  focus: string | null;
  note: string | null;
  manifest: string | null;
}): string {
  return `You are preparing a background reading digest for a teaching session. A human teacher is
about to teach this subject to a simulated student; your digest becomes one of the
session's source documents. Use the web search tool to ground it in real, current sources —
do not rely on memory alone.

Subject: ${opts.topic}
${opts.focus ? `The teacher plans to focus the session on: ${opts.focus}.` : ""}
${opts.note ? `The teacher's note about this research: ${opts.note}` : ""}
${
  opts.manifest
    ? `
The teacher also uploaded their own materials — the files in your working directory:

${opts.manifest}

Skim them first (where a .txt sits alongside a PDF of the same name, read the .txt) so the
digest complements rather than repeats them: fill gaps, add context, cover what they leave
out.`
    : ""
}

Write the digest in markdown, 800 to 1500 words. Start with a single H1 title naming the
subject, then exactly these sections:

## Overview — what this subject is and why it matters (2–3 paragraphs).
## Key concepts — the 5 to 8 ideas a session on this subject will visit, each one short
paragraph in plain language.
## Common misconceptions — 3 to 5 misconceptions real learners actually hold about this
subject: state each wrong claim plainly, then one or two sentences on why it is wrong and
what is true instead. Be specific — this section matters most.
## Sources — the web sources you actually used, as a markdown list of titles with URLs.

Rules:
- Plain, precise language; no marketing tone, no filler.
- Make only claims you verified in the sources; where sources disagree, say so briefly.
- Output ONLY the markdown document — no preamble, no commentary, and no code fence around
  the document.`;
}

/** Strip a single wrapping ``` fence, if the model ignored the no-fence rule. */
export function stripWrappingFence(raw: string): string {
  const text = raw.trim();
  const match = text.match(/^```[a-z]*\n([\s\S]*)\n```$/);
  return match ? match[1]!.trim() : text;
}

/** Write the digest into the sources dir and register it on the notebook (caller saves). */
export async function writeResearchDigest(store: NotebookStore, nb: Notebook, text: string): Promise<SourceFile> {
  const used = new Set(nb.sourceFiles.flatMap((f) => (f.extractedName ? [f.storedName, f.extractedName] : [f.storedName])));
  const storedName = sanitizeName("online-research.md", used);
  await fs.writeFile(path.join(store.sourcesDir(nb.id), storedName), text, "utf8");
  const topic = (nb.topic ?? nb.title).slice(0, 60);
  const file: SourceFile = {
    originalName: `Online research: ${topic}`,
    storedName,
    extractedName: null,
    mimeType: "text/markdown",
    size: Buffer.byteLength(text, "utf8"),
    approxWords: approxWordCount(text),
    origin: "research",
  };
  nb.sourceFiles.push(file);
  return file;
}
