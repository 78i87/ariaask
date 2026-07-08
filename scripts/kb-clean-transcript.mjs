#!/usr/bin/env node
// Clean a YouTube transcript (plain text, as exported from an RTF via
// `textutil -convert txt` or from yt-dlp VTT via kb-fetch-transcript.mjs)
// into a kb/transcripts/ markdown doc.
//
// Usage: node scripts/kb-clean-transcript.mjs <input.txt> <output.md> "<Video title>" [<video url>]
//
// Strips [HH:MM:SS] / [MM:SS] timestamps, [music]-style bracketed cues, and
// ">>" speaker arrows, then re-wraps the text into paragraphs of a few
// sentences each so the RAG chunker gets natural segment boundaries.

import fs from "node:fs";

const [input, output, title, url] = process.argv.slice(2);
if (!input || !output || !title) {
  console.error('usage: kb-clean-transcript.mjs <input.txt> <output.md> "<Video title>" [<video url>]');
  process.exit(1);
}

const raw = fs.readFileSync(input, "utf8");

const text = raw
  .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, " ")
  .replace(/\[(?:music|applause|laughter)\]/gi, " ")
  .replace(/>>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

// Split into sentences, then group into paragraphs of ~4 sentences.
// Auto-captions often lack punctuation entirely; fall back to fixed-size
// word groups when "sentences" come out absurdly long.
const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [text];
const words = text.split(" ");
const avgSentenceWords = words.length / sentences.length;
const paragraphs = [];
if (avgSentenceWords > 150) {
  const WORDS_PER_PARA = 90;
  for (let i = 0; i < words.length; i += WORDS_PER_PARA) {
    paragraphs.push(words.slice(i, i + WORDS_PER_PARA).join(" "));
  }
} else {
  const SENTENCES_PER_PARA = 4;
  for (let i = 0; i < sentences.length; i += SENTENCES_PER_PARA) {
    const para = sentences
      .slice(i, i + SENTENCES_PER_PARA)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (para) paragraphs.push(para);
  }
}

const header = [
  `# ${title}`,
  "",
  `Transcript of the Justin Sung video "${title}"${url ? ` (${url})` : ""}.`,
  "Cleaned for the Aria learning-coach knowledge base; timestamps and filler cues removed.",
  "",
];

fs.writeFileSync(output, header.join("\n") + "\n" + paragraphs.join("\n\n") + "\n");
console.log(`wrote ${output} (${paragraphs.length} paragraphs, ${text.split(" ").length} words)`);
