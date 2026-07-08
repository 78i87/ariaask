#!/usr/bin/env node
// Fetch a YouTube video's auto-generated subtitles with yt-dlp and convert
// them to plain deduplicated text on stdout (auto-sub VTTs repeat each line
// in overlapping rolling cues). Pipe the output into kb-clean-transcript.mjs.
//
// Usage: node scripts/kb-fetch-transcript.mjs <video-url-or-id> > /tmp/raw.txt

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const video = process.argv[2];
if (!video) {
  console.error("usage: kb-fetch-transcript.mjs <video-url-or-id>");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-vtt-"));
try {
  execFileSync(
    "yt-dlp",
    ["--write-auto-subs", "--sub-lang", "en", "--skip-download", "-o", path.join(tmp, "video"), video],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const vttFile = fs.readdirSync(tmp).find((f) => f.endsWith(".vtt"));
  if (!vttFile) {
    console.error("no English auto-subs found");
    process.exit(2);
  }
  const vtt = fs.readFileSync(path.join(tmp, vttFile), "utf8");

  const lines = [];
  let last = "";
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw
      .replace(/<[^>]+>/g, "") // inline word-timing tags
      .trim();
    if (!line) continue;
    if (/^WEBVTT|^Kind:|^Language:|^NOTE/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3} --> /.test(line)) continue;
    if (line === last) continue; // rolling-cue duplicate
    last = line;
    lines.push(line);
  }
  process.stdout.write(lines.join(" ") + "\n");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
