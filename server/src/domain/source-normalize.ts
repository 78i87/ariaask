const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{72,}$/;
const BOILERPLATE = /^(?:last updated|save as pdf|page id)$/i;
const EMPTY_MEDIA_LINK = /^!?\[\]\([^\s)]+\.(?:avif|gif|jpe?g|png|svg|webp)(?:\?[^)]*)?\)$/i;

function normalizeMath(text: string): string {
  return text
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, tex: string) => `\n\n$$\n${tex.trim()}\n$$\n\n`)
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_match, tex: string) => `$${tex.trim()}$`);
}

function isOpaqueLine(line: string): boolean {
  const value = line.trim().replace(/^[-*+]\s+/, "");
  if (!value || /^(?:https?:\/\/|www\.)/i.test(value)) return false;
  return OPAQUE_TOKEN.test(value);
}

/**
 * Cleans the text artifacts that commonly survive Readability + Turndown.
 * It is intentionally conservative: uploaded notes are never passed through
 * this helper, and headings, prose, links, lists, code, and TeX are retained.
 */
export function normalizeResearchMarkdown(input: string): string {
  const lines = normalizeMath(input.replace(/\r\n?/g, "\n")).split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (isOpaqueLine(line) || BOILERPLATE.test(trimmed) || EMPTY_MEDIA_LINK.test(trimmed)) continue;

    // Readability sometimes leaves the numeric Page ID on the following line.
    if (/^\d{3,}$/.test(trimmed) && BOILERPLATE.test((lines[i - 1] ?? "").trim())) continue;
    if (/^[-*+]\s*$/.test(trimmed)) continue;
    out.push(line.replace(/[ \t]+$/g, ""));
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function usefulMediaAlt(alt: string): string {
  const value = alt.replace(/\s+/g, " ").trim();
  if (!value || value.length > 400 || OPAQUE_TOKEN.test(value)) return "";
  if (/^\\[([]/.test(value)) {
    return normalizeMath(value);
  }
  if (/\\(?:frac|sum|int|left|right|begin|mathrm|mathbf)\b/.test(value)) return `$${value}$`;
  return value.length <= 160 ? value : "";
}

export function htmlTableToMarkdown(table: Element): string {
  const rows = [...table.querySelectorAll("tr")]
    .map((row) =>
      [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) =>
        (cell.textContent ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"),
      ),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
  const header = normalized[0]!;
  return `\n\n| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |\n${normalized
    .slice(1)
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n")}\n\n`;
}
