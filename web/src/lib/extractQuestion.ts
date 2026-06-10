/**
 * Returns the trailing run of question sentences from an Aria message (the
 * student typically ends with one or more probing questions), or the whole
 * trimmed message when no usable trailing question exists.
 */
export function extractTrailingQuestion(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  // Sentence chunks: text up to and including terminal punctuation (with
  // optional closing quotes/brackets), or a trailing fragment.
  const sentences = normalized.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [];
  const trailing: string[] = [];
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i]!.trim();
    if (/\?["')\]]*$/.test(s)) trailing.unshift(s);
    else break;
  }
  const joined = trailing.join(" ").trim();
  // Below 8 chars (a bare "Why?") the question can't stand alone — fall back
  // to the whole message so Cyra gets the context.
  return joined.length >= 8 ? joined : normalized;
}
