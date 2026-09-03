// tests/render-chart.test.js — the index "Your progress" block (Recap v2 · C4):
// aggregation math, the <2-weeks gate, SVG shape + per-point titles, delta chips,
// the Level track variants, the table twin, an XSS probe in weekLabel, the CSS
// budget/scope, and the self-contained-page rule (no http / src= references).
//
// Every fixture below is SYNTHETIC (render-fixtures.js) — no real lesson data.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  progressBlock,
  weekSeries,
  avgStat,
  deltaLabel,
  deltaParts,
  CHART_STYLES,
} from "../src/render/chart.js";
import { weekWith, emptyWeek } from "./render-fixtures.js";

const count = (html, re) => (html.match(re) || []).length;

/** A non-empty week with the given per-class stats + weekly minutes (Σ closed on zero). */
function wk(weekId, weekLabel, classStats, minutes, extra = {}) {
  const classes = classStats.map((st, i) => ({
    lessonId: `${weekId}-L${i + 1}`,
    startAt: `${weekId}T20:00:00+08:00`,
    minutes: 60,
    topic: "Topic",
    tutor: "Tutor T.",
    stats: st,
    moment: null,
    tutorNote: null,
  }));
  return weekWith(weekId, weekLabel, 0, {
    stats: { classes: classes.length, minutes, corrections: 0, expressions: 0 },
    classes,
    grammarGroups: [],
    integrity: {
      reportedCorrections: 0,
      renderedGrammar: 0,
      renderedVocab: 0,
      renderedPhrasing: 0,
      rejectedCount: 0,
    },
    ...extra,
  });
}

/** Three consecutive weeks with a known trajectory: wpm 72→78→84, talk 45→43→41, words flat 400. */
function threeWeeks() {
  return [
    wk("2026-05-04", "May 4–10", [{ wpm: 72, talkPct: 45, words: 400 }], 90),
    wk("2026-05-11", "May 11–17", [{ wpm: 78, talkPct: 43, words: 400 }], 120),
    wk("2026-05-18", "May 18–24", [{ wpm: 84, talkPct: 41, words: 400 }], 300),
  ];
}

// ---------------------------------------------------------------- aggregation

test("avgStat: averages the classes that carry the stat and ignores 0 / null / missing / non-numeric", () => {
  // Arrange
  const classes = [
    { stats: { wpm: 80 } },
    { stats: { wpm: 0 } }, // stats outage, not a silent lesson
    { stats: null },
    {},
    { stats: { wpm: "90" } },
    null,
  ];

  // Act + Assert
  assert.equal(avgStat(classes, "wpm"), 80);
  assert.equal(avgStat([{ stats: { wpm: 70 } }, { stats: { wpm: 90 } }], "wpm"), 80);
  assert.equal(avgStat([{ stats: { wpm: 75 } }, { stats: { wpm: 76 } }], "wpm"), 76, "rounds to an integer");
  assert.equal(avgStat([{ stats: { wpm: 0 } }], "wpm"), null, "all-zero → null, never 0");
  assert.equal(avgStat([], "wpm"), null);
  assert.equal(avgStat(undefined, "wpm"), null);
});

test("weekSeries: ascending by weekId from any input order; empty weeks keep their slot as null gaps", () => {
  // Arrange — newest first, an empty week in the middle
  const weeks = [
    wk("2026-05-18", "May 18–24", [{ wpm: 84, talkPct: 41, words: 500 }], 120, {
      level: { overall: "B1+", confidence: "medium" },
    }),
    emptyWeek("2026-05-11", "May 11–17"),
    wk("2026-05-04", "May 4–10", [{ wpm: 72, talkPct: 45, words: 400 }, { wpm: 0, talkPct: 0, words: 0 }], 90),
  ];

  // Act
  const s = weekSeries(weeks);

  // Assert
  assert.deepEqual(s.map((x) => x.weekId), ["2026-05-04", "2026-05-11", "2026-05-18"]);
  assert.deepEqual(s[0], {
    weekId: "2026-05-04",
    weekLabel: "May 4–10",
    isEmpty: false,
    classes: 2,
    minutes: 90,
    wpm: 72, // the 0-stat class is ignored, not averaged in
    talkPct: 45,
    words: 400,
    level: null,
  });
  assert.equal(s[1].isEmpty, true);
  assert.deepEqual([s[1].minutes, s[1].wpm, s[1].talkPct, s[1].words, s[1].level], [null, null, null, null, null]);
  assert.deepEqual(s[2].level, { band: "B1+", confidence: "medium" });
});

test("weekSeries: a legacy VM with no class stats and no minutes yields nulls, not zeros", () => {
  const legacy = wk("2026-05-04", "May 4–10", [{}], 0);
  const [s] = weekSeries([legacy]);
  assert.deepEqual([s.minutes, s.wpm, s.talkPct, s.words], [null, null, null, null]);
  assert.equal(s.classes, 1);
});

test("deltaLabel: sign + unit vs the FIRST week that has the metric; 'No change' at zero; null below two points", () => {
  const s = weekSeries(threeWeeks());
  assert.equal(deltaLabel(s, "wpm"), "+12 wpm since May 4–10");
  assert.equal(deltaLabel(s, "talkPct"), "−4% since May 4–10");
  assert.equal(deltaLabel(s, "words"), "No change since May 4–10");
  assert.equal(deltaLabel(s, "minutes"), "+210 min since May 4–10");

  // the first week lacks wpm → the baseline moves to the first week that has it
  const noFirst = weekSeries([
    wk("2026-05-04", "May 4–10", [{ talkPct: 45 }], 90),
    wk("2026-05-11", "May 11–17", [{ wpm: 78 }], 90),
    wk("2026-05-18", "May 18–24", [{ wpm: 80 }], 90),
  ]);
  assert.equal(deltaLabel(noFirst, "wpm"), "+2 wpm since May 11–17");
  assert.equal(deltaLabel(weekSeries(threeWeeks().slice(0, 1)), "wpm"), null, "one point is not a delta");
  assert.equal(deltaLabel(s, "nope"), null, "unknown metric → null");
});

// ---------------------------------------------------------------- the gate

test("progressBlock: '' with fewer than two non-empty weeks (empties do not count)", () => {
  assert.equal(progressBlock([]), "");
  assert.equal(progressBlock(threeWeeks().slice(0, 1)), "");
  assert.equal(progressBlock([threeWeeks()[0], emptyWeek(), emptyWeek("2026-06-15", "Jun 15–21")]), "");
  assert.match(progressBlock(threeWeeks().slice(0, 2)), /^<section class="pad progress" aria-labelledby="progress-h">/);
});

// ---------------------------------------------------------------- tiles + SVG

test("progressBlock: four tiles, each with one well-formed inline SVG and a <title> per data point", () => {
  const html = progressBlock(threeWeeks());

  assert.equal(count(html, /<article class="tile">/g), 4);
  assert.equal(count(html, /<svg /g), 4, "one SVG per tile");
  assert.equal(count(html, /<\/svg>/g), 4);
  assert.equal(count(html, /role="img" aria-label="[^"]+ by week"/g), 4);
  assert.equal(count(html, /preserveAspectRatio="none"/g), 4, "stretch to the tile width at a fixed 56px height");
  assert.equal(count(html, /<title>/g), 12, "3 weeks × 4 tiles — one native hover title per point");
  assert.ok(html.includes("<title>Week of May 18–24 · 84 wpm</title>"));
  assert.ok(html.includes("<title>Week of May 18–24 · 41%</title>"));
  assert.ok(html.includes("<title>Week of May 4–10 · 400 words</title>"));
  assert.ok(html.includes("<title>Week of May 18–24 · 300 min</title>"));
  // tile order and labels in sentence case
  assert.match(
    html,
    /<h3>Speaking speed<\/h3>[\s\S]*<h3>Your share of talk<\/h3>[\s\S]*<h3>Unique words per class<\/h3>[\s\S]*<h3>Minutes studied<\/h3>/,
  );
  assert.equal(count(html, /class="base"/g), 4, "a hairline baseline per tile");
});

test("progressBlock: latest value + unit and the neutral delta chip per tile", () => {
  const html = progressBlock(threeWeeks());
  const chip = (value) => `<p class="delta"><span class="td">${value}</span><span class="tds">since May 4–10</span></p>`;
  assert.ok(html.includes(`<p class="tv"><b>84</b><span class="tu">wpm</span></p>${chip("+12 wpm")}`));
  assert.ok(html.includes(`<p class="tv"><b>41</b><span class="tu">%</span></p>${chip("−4%")}`));
  assert.ok(html.includes(`<p class="tv"><b>400</b></p>${chip("No change")}`), "words: no unit on the value");
  assert.ok(html.includes(`<p class="tv"><b>300</b><span class="tu">min</span></p>${chip("+210 min")}`));
  assert.ok(!/class="td"[^>]*>[^<]*(good|bad|up|down)/i.test(html), "no judgement wording in the chip");
});

test("regression (visual): the delta pill never wraps — 'since <week>' is a separate muted tail, and the pill is nowrap", () => {
  const s = weekSeries(threeWeeks());
  assert.deepEqual(deltaParts(s, "wpm"), { value: "+12 wpm", since: "since May 4–10" });
  assert.deepEqual(deltaParts(s, "talkPct"), { value: "−4%", since: "since May 4–10" });
  assert.deepEqual(deltaParts(s, "words"), { value: "No change", since: "since May 4–10" });
  assert.equal(deltaParts(weekSeries(threeWeeks().slice(0, 1)), "wpm"), null);
  assert.equal(deltaLabel(s, "wpm"), "+12 wpm since May 4–10", "the one-sentence form is the two parts joined");
  // Markup: the pill (.td) holds only the signed value; the week lives in .tds outside the pill.
  const html = progressBlock(threeWeeks());
  assert.equal(count(html, /<span class="td">[^<]*<\/span>/g), 4);
  assert.ok(!/<span class="td">[^<]*since/.test(html), "no 'since' inside a pill");
  assert.equal(count(html, /<span class="tds">since May 4–10<\/span>/g), 4);
  // CSS: the pill cannot break inside; the tail cannot break inside its date; the row wraps between them.
  const td = /\.ix \.td\{([^}]*)\}/.exec(CHART_STYLES)[1];
  assert.match(td, /white-space:nowrap/);
  assert.ok(!/overflow-wrap|max-width/.test(td), "the pill no longer relies on wrapping");
  assert.match(CHART_STYLES, /\.ix \.tds\{[^}]*white-space:nowrap/);
  assert.match(CHART_STYLES, /\.ix \.delta\{display:flex;flex-wrap:wrap/);
  // The week label is escaped inside the tail too.
  const xss = progressBlock([weekWith("2026-05-04", '<b>x</b>', 1), weekWith("2026-05-11", "May 11–17", 1)]);
  assert.ok(xss.includes('<span class="tds">since &lt;b&gt;x&lt;/b&gt;</span>'));
});

test("'Show the data' summary meets the 44px tap target", () => {
  // `.ix details.ptable>summary` ties the specificity of the base `.mk details.more>summary` rule and wins by order.
  assert.match(CHART_STYLES, /\.ix details\.ptable>summary\{[^}]*box-sizing:border-box;min-height:44px/);
});

test("progressBlock: line tiles draw one 2px teal polyline per run, an accent end marker on a surface ring, and first/last labels only", () => {
  const html = progressBlock(threeWeeks());
  assert.equal(count(html, /<polyline class="ln" points="[^"]+" vector-effect="non-scaling-stroke"\/>/g), 3);
  assert.equal(count(html, /class="ring"/g), 3, "one surface ring per line tile");
  assert.equal(count(html, /class="dot"/g), 3, "one accent end marker per line tile");
  // direct labels: exactly first + last per tile (2 × 4), no text inside the SVG
  assert.equal(count(html, /class="pl a"/g), 4);
  assert.equal(count(html, /class="pl b"/g), 4);
  assert.equal(count(html, /<text/g), 0);
  assert.match(html, /<span class="pl a" style="top:[\d.]+px" aria-hidden="true">72<\/span>/);
  assert.match(html, /<span class="pl b" style="top:[\d.]+px" aria-hidden="true">84<\/span>/);
});

test("progressBlock: honest y range — the line spans min→max (not from 0) and the lower value sits lower", () => {
  const html = progressBlock(threeWeeks());
  const m = /<polyline class="ln" points="([^"]+)"/.exec(html);
  const pts = m[1].split(" ").map((p) => p.split(",").map(Number));
  assert.equal(pts.length, 3);
  const [y72, y78, y84] = pts.map((p) => p[1]);
  assert.ok(y72 > y78 && y78 > y84, "72 → 78 → 84 climbs (SVG y grows downward)");
  assert.ok(y72 <= 49 && y84 >= 7, "padded inside the 7..49 band, never anchored at the baseline");
  assert.ok(y72 - y84 > 20, "a 12 wpm rise fills most of the band — the range is min−pad…max+pad, not 0-based");
});

test("progressBlock: minutes are thin rounded columns from 0, the latest in the accent", () => {
  const html = progressBlock(threeWeeks());
  const cols = html.match(/<path class="col(?: last)?" d="[^"]+"\/>/g) || [];
  assert.equal(cols.length, 3, "one column per non-empty week");
  assert.equal(count(html, /class="col last"/g), 1, "exactly one accent (latest) column");
  // tallest (300 min) tops out at y=4; 90 min = 30 % of it → y = 55 − 0.3·51 = 39.7
  assert.match(cols[2], /Q[\d.]+ 4 /, "max column reaches the top of the column band");
  assert.match(cols[0], /Q[\d.]+ 39.7 /, "column height is proportional from 0");
  for (const c of cols) assert.match(c, / 55V/, "every column stands on the baseline");
});

test("progressBlock: an empty week is a GAP — the polyline splits, a lone point becomes a dot, and no title/row names it", () => {
  const weeks = [
    wk("2026-05-04", "May 4–10", [{ wpm: 72, talkPct: 45, words: 400 }], 90),
    emptyWeek("2026-05-11", "May 11–17"),
    wk("2026-05-18", "May 18–24", [{ wpm: 78, talkPct: 43, words: 420 }], 120),
    wk("2026-05-25", "May 25–31", [{ wpm: 84, talkPct: 41, words: 440 }], 300),
  ];
  const html = progressBlock(weeks);
  assert.equal(count(html, /<path class="pt" /g), 3, "the lone first point renders as a dot in each line tile");
  assert.equal(count(html, /<polyline class="ln"/g), 3, "one polyline for the 2-point run after the gap");
  assert.equal(count(html, /<title>/g), 12, "3 non-empty weeks × 4 tiles — the gap carries no title");
  assert.ok(!html.includes("May 11–17"), "the empty week is named nowhere in the block");
  assert.equal(count(html, /class="col(?: last)?"/g), 3, "no zero-height column for the gap");
});

// ---------------------------------------------------------------- level track

test("Level track: omitted when no week carries level.overall", () => {
  const html = progressBlock(threeWeeks());
  assert.ok(!html.includes("ltrack"));
});

test("Level track: exactly one leveled week → the one-line 'began' sentence (confidence optional)", () => {
  const weeks = threeWeeks();
  weeks[2] = { ...weeks[2], level: { overall: "B1+", confidence: "medium" } };
  const html = progressBlock(weeks);
  assert.ok(html.includes(`<p class="ltrack one">Level estimate began May 18–24: B1+ (medium confidence)</p>`));

  const noConf = threeWeeks();
  noConf[2] = { ...noConf[2], level: { overall: "B2" } };
  assert.ok(progressBlock(noConf).includes(`<p class="ltrack one">Level estimate began May 18–24: B2</p>`));
});

test("Level track: many leveled weeks → chips in week order with their week labels", () => {
  const weeks = threeWeeks();
  weeks[0] = { ...weeks[0], level: { overall: "B1", confidence: "low" } };
  weeks[2] = { ...weeks[2], level: { overall: "B1+", confidence: "medium" } };
  const html = progressBlock([weeks[2], weeks[1], weeks[0]]); // any input order
  assert.match(
    html,
    /<div class="ltrack"><span class="lk">Level<\/span><ol><li><b>B1<\/b><span>May 4–10<\/span><\/li><li><b>B1\+<\/b><span>May 18–24<\/span><\/li><\/ol><\/div>/,
  );
  assert.ok(!html.includes("Level estimate began"));
});

// ---------------------------------------------------------------- table twin

test("table twin: one row per NON-EMPTY week inside details > div.table-wrap, nulls as dashes, tabular-nums only there", () => {
  const weeks = [...threeWeeks(), emptyWeek("2026-05-25", "May 25–31")];
  weeks[1] = { ...weeks[1], level: { overall: "B1", confidence: "low" } };
  const html = progressBlock(weeks);

  assert.ok(html.includes(`<details class="more ptable"><summary>Show the data</summary><div class="table-wrap"><table>`));
  assert.equal(count(html, /<th scope="row">/g), 3, "rows = non-empty weeks");
  assert.match(
    html,
    /<thead><tr><th scope="col" class="t">Week<\/th><th scope="col">Classes<\/th><th scope="col">Min<\/th><th scope="col">wpm<\/th><th scope="col">Talk %<\/th><th scope="col">Words<\/th><th scope="col" class="t">Level<\/th><\/tr><\/thead>/,
  );
  assert.ok(html.includes(`<tr><th scope="row">May 4–10</th><td>1</td><td>90</td><td>72</td><td>45</td><td>400</td><td class="t">—</td></tr>`));
  assert.ok(html.includes(`<tr><th scope="row">May 11–17</th><td>1</td><td>120</td><td>78</td><td>43</td><td>400</td><td class="t">B1</td></tr>`));
  assert.ok(html.includes(`<td class="t">B1</td>`) && !html.includes(`<td class="t">B1+</td>`));
  // the table is the only place numbers align in columns
  assert.equal(count(CHART_STYLES, /tabular-nums/g), 1);
  assert.match(CHART_STYLES, /\.ix \.ptable td\{[^}]*tabular-nums/);
});

// ---------------------------------------------------------------- XSS + budgets

test("XSS: a weekLabel / level probe is escaped everywhere it lands (titles, chips, table, level row)", () => {
  const weeks = threeWeeks();
  weeks[0] = { ...weeks[0], weekLabel: `May <script>alert(1)</script> 4–10` };
  weeks[2] = { ...weeks[2], level: { overall: `B1+<img src=x onerror=alert(2)>`, confidence: `"medium"` } };
  const html = progressBlock(weeks);
  assert.ok(!html.includes("<script"), "no raw script tag");
  assert.ok(!html.includes("<img"), "no raw img tag");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  assert.ok(html.includes("(&quot;medium&quot; confidence)"));
});

test("CHART_STYLES: ≤ 5 KB, every rule scoped under .ix, table-wrap scrolls horizontally", () => {
  assert.ok(Buffer.byteLength(CHART_STYLES, "utf8") <= 5 * 1024, `CSS ${Buffer.byteLength(CHART_STYLES, "utf8")} B > 5 KB`);
  const selectors = CHART_STYLES.replace(/@media[^{]+\{/g, "")
    .split("}")
    .map((rule) => rule.split("{")[0].trim())
    .filter((s) => s !== "")
    .flatMap((s) => s.split(",").map((x) => x.trim()));
  assert.ok(selectors.length > 20);
  for (const sel of selectors) assert.ok(sel.startsWith(".ix "), `unscoped selector: ${sel}`);
  assert.match(CHART_STYLES, /\.ix \.table-wrap\{overflow-x:auto/);
  assert.match(CHART_STYLES, /@media \(min-width:760px\)\{\.ix \.tiles\{grid-template-columns:repeat\(4,1fr\)\}\}/);
});

test("self-contained: the block references no external resource (no http, src=, href=, xmlns)", () => {
  const html = progressBlock(threeWeeks());
  assert.ok(!/http/i.test(html));
  assert.ok(!/src=/i.test(html));
  assert.ok(!/href=/i.test(html));
  assert.ok(!/xmlns/i.test(html));
  assert.ok(!/<script/i.test(html));
});
