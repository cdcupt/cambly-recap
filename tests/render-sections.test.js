// tests/render-sections.test.js — the recap-v2 week sections (review · level · plan) in
// isolation: present/absent, structure, numbering, the 7-cell CEFR track, day/ASK chips,
// the footnote, and an XSS probe per field. Pure: fixture in, HTML string out.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewSection, levelSection, planSection, SECTION_STYLES } from "../src/render/sections.js";
import { sectionsFor, chipNav, sectionNum, SECTION_DEFS } from "../src/render/components.js";
import { BANDS } from "../src/coach.js";
import { goldenWeek, goldenWeekV2 } from "./render-fixtures.js";

const resolve = {
  startAt: (id) => ({ L1: "2026-05-28T20:00:00+08:00", L2: "2026-05-30T20:00:00+08:00" })[id] ?? null,
  tutor: () => "Niki V.",
};

// ── sectionsFor / chipNav ──────────────────────────────────────────────────────────

test("sectionsFor lists only the sections a week carries, in page order, numbered sequentially", () => {
  assert.deepEqual(sectionsFor(goldenWeek()).map((s) => `${s.num}:${s.id}`), [
    "01:m-classes", "02:m-vocab", "03:m-grammar", "04:m-phrasing", "05:m-practice",
  ]);
  assert.deepEqual(sectionsFor(goldenWeekV2()).map((s) => `${s.num}:${s.id}`), [
    "01:m-review", "02:m-level", "03:m-classes", "04:m-vocab", "05:m-grammar", "06:m-phrasing", "07:m-practice", "08:m-plan",
  ]);
  assert.deepEqual(sectionsFor(goldenWeekV2({ level: null })).map((s) => s.key), ["review", "classes", "vocab", "grammar", "phrasing", "practice", "plan"]);
  assert.equal(SECTION_DEFS.length, 8);
  assert.equal(sectionNum(0), "01");
  assert.equal(sectionNum(7), "08");
});

test("chipNav renders one jump link per present section, in order, and nothing for absent blocks", () => {
  const legacy = chipNav(goldenWeek());
  assert.equal(legacy, '<nav class="chips" aria-label="Recap sections"><a href="#m-classes">Classes</a><a href="#m-vocab">Vocabulary</a><a href="#m-grammar">Grammar</a><a href="#m-phrasing">Phrasing</a><a href="#m-practice">Practice</a></nav>');
  const v2 = chipNav(goldenWeekV2());
  assert.ok(v2.startsWith('<nav class="chips" aria-label="Recap sections"><a href="#m-review">Review</a><a href="#m-level">Level</a><a href="#m-classes">'));
  assert.ok(v2.endsWith('<a href="#m-plan">Plan</a></nav>'));
  assert.equal((v2.match(/<a /g) || []).length, 8);
});

// ── review ────────────────────────────────────────────────────────────────────────

test("reviewSection returns '' when the block is absent, else a numbered section with the lead + two tinted cards", () => {
  assert.equal(reviewSection(goldenWeek(), resolve, "01"), "");
  assert.equal(reviewSection({ review: null }, resolve, "01"), "");
  const html = reviewSection(goldenWeekV2(), resolve, "01");
  assert.ok(html.startsWith('<section id="m-review" class="pad"><h2><span class="num">01</span>The week in review</h2>'));
  assert.match(html, /<p class="lead">Two classes this week, both about work routines\./);
  assert.ok(html.includes('<div class="rvgrid"><div class="rvcard good"><h3>What went well</h3><ul>'));
  assert.ok(html.includes('<div class="rvcard work"><h3>What needs work</h3><ul>'));
  // wentWell: a real ✓ glyph in markup (aria-hidden), the point, then ONE line holding the italic quote + its day chip.
  assert.ok(html.includes('<li><i class="ck" aria-hidden="true">✓</i><div><span class="pt">You kept the past tense steady across a long story</span><span class="rql"><q class="rq">I cut out soda</q> <i class="daychip">THU</i></span></div></li>'));
  // a point without a quote renders no quote line at all
  assert.match(html, /<span class="pt">You asked follow-up questions instead of waiting &lt;script&gt;ww\(\)&lt;\/script&gt;<\/span><\/div><\/li>/);
  // needsWork: bold issue · struck quote (+ chip) on one line · "→ fix"
  assert.ok(html.includes('<li><b class="iss">Missing articles before singular nouns</b><span class="rql"><q class="rq bad">I go to office every day</q> <i class="daychip">SAT</i></span><span class="fx"><i aria-hidden="true">→</i> Say &#39;the office&#39;, &#39;a meeting&#39;.</span></li>'));
  // a quote whose lessonId does not resolve gets no chip, but keeps its line
  const noDay = reviewSection({ review: { summary: "s", wentWell: [{ point: "p", quote: "q", lessonId: null }], needsWork: [] } }, resolve, "01");
  assert.ok(noDay.includes('<span class="rql"><q class="rq">q</q></span>'));
  assert.equal((html.match(/<li>/g) || []).length, 5, "2 went-well + 3 needs-work rows");
  assert.ok(reviewSection(goldenWeekV2(), resolve, "04").startsWith('<section id="m-review" class="pad"><h2><span class="num">04</span>'), "the number is injected");
});

test("reviewSection omits a card whose list is empty and drops the grid when both are empty", () => {
  const onlyWell = reviewSection({ review: { summary: "s", wentWell: [{ point: "p", quote: null, lessonId: null }], needsWork: [] } }, resolve, "01");
  assert.ok(onlyWell.includes('class="rvcard good"') && !onlyWell.includes('class="rvcard work"'));
  const none = reviewSection({ review: { summary: "just a summary", wentWell: [], needsWork: [] } }, resolve, "01");
  assert.ok(none.includes('<p class="lead">just a summary</p>') && !none.includes("rvgrid"));
});

// ── level ─────────────────────────────────────────────────────────────────────────

test("levelSection returns '' when absent, else the hero (eyebrow · big band · summary), 5 dimension rows, advice, footnote", () => {
  assert.equal(levelSection(goldenWeek(), "02"), "");
  const html = levelSection(goldenWeekV2(), "02");
  assert.ok(html.startsWith('<section id="m-level" class="pad"><h2><span class="num">02</span>Level estimate</h2>'));
  assert.ok(html.includes('<div class="lvhero"><span class="lveye">Estimated CEFR level · medium confidence</span><span class="lvbig">B1+</span><p class="lvsum">Long, confident turns'));
  assert.equal((html.match(/<li class="dim">/g) || []).length, 5);
  assert.deepEqual([...html.matchAll(/<span class="dname">([A-Za-z]+)<\/span>/g)].map((m) => m[1]), ["Range", "Accuracy", "Fluency", "Interaction", "Coherence"]);
  assert.ok(html.includes('<h3 class="lvh3">To reach the next band</h3><ol class="advice">'));
  assert.equal((html.match(/<i class="an" aria-hidden="true">\d<\/i>/g) || []).length, 3);
  assert.ok(html.includes('<i class="an" aria-hidden="true">1</i><div><b>Articles on autopilot</b><span>Before every singular count noun'));
  assert.ok(html.includes("<p class=\"lvfoot\">Estimated from this week's spontaneous speech only (read-aloud passages excluded). Not an official test result.</p>"));
});

test("levelSection: each dimension has a 7-cell track filled up to bandIndex, the reached cell names the band for screen readers, the visible chip is aria-hidden", () => {
  const html = levelSection(goldenWeekV2(), "02");
  const rows = [...html.matchAll(/<li class="dim">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(rows.length, 5);
  const expectIdx = [3, 2, 4, 3, 3]; // range B1+, accuracy B1, fluency B2, interaction B1+, coherence B1+
  rows.forEach((row, i) => {
    const track = /<span class="track">((?:<i[^>]*>(?:<span class="sr">[^<]*<\/span>)?<\/i>)+)<\/span>/.exec(row);
    assert.ok(track, `row ${i} has a track`);
    const cells = track[1].match(/<i[^>]*>(?:<span class="sr">[^<]*<\/span>)?<\/i>/g);
    assert.equal(cells.length, BANDS.length, "7 cells");
    assert.equal(cells.filter((c) => c.includes('class="on')).length, expectIdx[i] + 1, `row ${i}: filled up to and including bandIndex`);
    assert.equal(cells[expectIdx[i]].includes('class="on hit"'), true);
    assert.ok(cells[expectIdx[i]].includes(`<span class="sr">${BANDS[expectIdx[i]]}</span>`), "reached cell carries the band text");
    assert.ok(row.includes(`<span class="dband" aria-hidden="true">${BANDS[expectIdx[i]]}</span>`));
  });
  assert.ok(html.includes('<span class="dev">Work vocabulary is ready; abstract topics fall back to simple words.</span>'));
  // An inherited dimension (empty evidence) renders no evidence span.
  const inherited = goldenWeekV2();
  inherited.level.dimensions[4].evidence = "";
  const last = [...levelSection(inherited, "02").matchAll(/<li class="dim">([\s\S]*?)<\/li>/g)].map((m) => m[1])[4];
  assert.ok(!last.includes('class="dev"'));
});

test("levelSection: A2 fills exactly one cell, C1 fills all seven; zero advice omits the advice block", () => {
  const vm = goldenWeekV2();
  vm.level.dimensions[0] = { name: "range", band: "A2", bandIndex: 0, evidence: "short" };
  vm.level.dimensions[1] = { name: "accuracy", band: "C1", bandIndex: 6, evidence: "rare" };
  vm.level.advice = [];
  const html = levelSection(vm, "02");
  const rows = [...html.matchAll(/<li class="dim">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal((rows[0].match(/class="on/g) || []).length, 1);
  assert.equal((rows[1].match(/class="on/g) || []).length, 7);
  assert.ok(!html.includes("To reach the next band"));
});

// ── plan ──────────────────────────────────────────────────────────────────────────

test("planSection returns '' when absent, else the teal frame: title with the next-week label, focus line, day-chipped items, ASK rows", () => {
  assert.equal(planSection(goldenWeek(), "08"), "");
  const html = planSection(goldenWeekV2(), "08");
  assert.ok(html.startsWith('<section id="m-plan" class="pad"><div class="planbox"><h2><span class="num">08</span>Plan for the week of Jun 1–7</h2>'));
  assert.match(html, /<p class="pfocus">Articles before every singular count noun, in every sentence you say\. &lt;script&gt;p\(\)&lt;\/script&gt;<\/p>/);
  assert.equal((html.match(/<ul class="plan">/g) || []).length, 1);
  assert.deepEqual(/<ul class="plan">[\s\S]*?<\/ul>/.exec(html)[0].match(/<i class="daychip">([A-Z]+)<\/i>/g), [
    '<i class="daychip">MON</i>', '<i class="daychip">DAILY</i>', '<i class="daychip">WED</i>', '<i class="daychip">FRI</i>', '<i class="daychip">SUN</i>',
  ]);
  assert.ok(html.includes('<span class="task">Re-read the two struck sentences above and say the fixed versions aloud five times.</span><span class="pwhy">Fixes stick when spoken.</span>'));
  // An empty why renders no pwhy span.
  assert.match(html, /<span class="task">Describe your lunch in six sentences, one article per noun\. &lt;script&gt;pi\(\)&lt;\/script&gt;<\/span><\/div><\/li>/);
  assert.ok(html.includes('<h3 class="askh">Ask your tutor next class</h3><ul class="ask"><li><i class="daychip askc">ASK</i><span>Ask Niki to stop you on every missing article.</span></li>'));
  assert.equal((html.match(/<i class="daychip askc">ASK<\/i>/g) || []).length, 2);
  assert.ok(html.endsWith("</ul></div></section>"));
});

test("planSection omits the ASK block when askTutor is empty and escapes the week label", () => {
  const vm = goldenWeekV2();
  vm.plan.askTutor = [];
  vm.plan.weekLabel = 'Jun 1–7 <b onclick="x">';
  const html = planSection(vm, "08");
  assert.ok(!html.includes("Ask your tutor next class"));
  assert.ok(html.includes("Plan for the week of Jun 1–7 &lt;b onclick=&quot;x&quot;&gt;</h2>"));
});

// ── styles ────────────────────────────────────────────────────────────────────────

test("SECTION_STYLES is scoped under .mk, stays ≤ 7 KB, wraps every text cell, and stacks the review band below 760px", () => {
  assert.ok(Buffer.byteLength(SECTION_STYLES, "utf8") <= 7 * 1024, `section CSS ${Buffer.byteLength(SECTION_STYLES, "utf8")} bytes`);
  const rules = SECTION_STYLES.split("\n").filter((l) => l && !l.startsWith("/*") && !l.startsWith("@media"));
  assert.ok(rules.every((l) => l.startsWith(".mk ")), "every rule is scoped under .mk");
  assert.match(SECTION_STYLES, /\.mk \.lvbig\{[^}]*font-family:var\(--disp\)[^}]*font-size:3\.1rem[^}]*color:var\(--acc\)/, "the band is the display-serif accent big number");
  assert.match(SECTION_STYLES, /\.mk \.track\{[^}]*grid-template-columns:repeat\(7,1fr\)/);
  assert.match(SECTION_STYLES, /@media \(min-width:760px\)\{\.mk \.rvgrid\{grid-template-columns:1fr 1fr\}\}/);
  assert.match(SECTION_STYLES, /\.mk \.lead,[^{]*\{overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(SECTION_STYLES, /\.mk \.sr\{position:absolute;width:1px;height:1px/);
  assert.ok(!/content:\s*"[^"]*[✓→]/.test(SECTION_STYLES), "no decorative pseudo-content glyphs — they live in markup");
});
