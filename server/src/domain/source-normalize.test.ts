import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { htmlTableToMarkdown, normalizeResearchMarkdown, usefulMediaAlt } from "./source-normalize.js";

test("research markdown removes opaque media artifacts and preserves TeX", () => {
  const opaque = "LW_y6Ejq_zCt5Gw03tVdB5X1N7CO5gyzQK1yVWGnbr1dD_vrXjlCI0HnulGKOvFlsREjwYDabfLia3Jk9Q7Zhclt5BOdkOsEAR";
  const cleaned = normalizeResearchMarkdown(`# Compound interest\n\n${opaque}\n\n[](https://example.test/assets/plot.png)\n\n\\[F=P(1+r)^t\\]\n\nUseful prose.`);
  assert.doesNotMatch(cleaned, /LW_y6/);
  assert.doesNotMatch(cleaned, /plot\.png/);
  assert.match(cleaned, /\$\$\nF=P\(1\+r\)\^t\n\$\$/);
  assert.match(cleaned, /Useful prose/);
  assert.equal(usefulMediaAlt(opaque), "");
  assert.equal(usefulMediaAlt("\\frac{a}{b}"), "$\\frac{a}{b}$");
  assert.equal(usefulMediaAlt("\\(x^2 + y^2\\)"), "$x^2 + y^2$");
});

test("HTML tables become GFM tables", () => {
  const dom = new JSDOM("<table><tr><th>Period</th><th>Rate</th></tr><tr><td>Monthly</td><td>0.5%</td></tr></table>");
  const table = dom.window.document.querySelector("table")!;
  const markdown = htmlTableToMarkdown(table);
  assert.match(markdown, /\| Period \| Rate \|/);
  assert.match(markdown, /\| Monthly \| 0.5% \|/);
  dom.window.close();
});
