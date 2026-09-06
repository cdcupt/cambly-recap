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
  tutor: () => "Alex R.",
};

// ── sectionsFor / chipNav ──────────────────────────────────────────────────────────

test("sectionsFor lists only the sections a week carries, in page order, numbered sequentially", () => {
  assert.deepEqual(sectionsFor(goldenWeek()).map((s) => `${s.num}:${s.id}`), [
    "01:m-vocab", "02:m-grammar", "03:m-phrasing", "04:m-practice", "A:m-classes",
  ]);
  assert.deepEqual(sectionsFor(goldenWeekV2()).map((s) => `${s.num}:${s.id}`), [
    "01:m-level", "02:m-review", "03:m-vocab", "04:m-grammar", "05:m-phrasing", "06:m-practice", "07:m-plan", "A:m-classes",
  ]);
  assert.deepEqual(sectionsFor(goldenWeekV2({ level: null })).map((s) => s.key), ["review", "vocab", "grammar", "phrasing", "practice", "plan", "classes"]);
  assert.deepEqual(sectionsFor(goldenWeekV2()).map((s) => s.appendix), [false, false, false, false, false, false, false, true]);
  assert.equal(SECTION_DEFS.length, 8);
  assert.equal(sectionNum(0), "01");
  assert.equal(sectionNum(7), "08");
});

test("chipNav renders one jump link per present section, in order, and nothing for absent blocks", () => {
  const legacy = chipNav(goldenWeek());
  assert.equal(legacy, '<nav class="chips" aria-label="Recap sections"><a href="#m-vocab">Vocabulary</a><a href="#m-grammar">Grammar</a><a href="#m-phrasing">Phrasing</a><a href="#m-practice">Practice</a><a href="#m-classes">Class log</a></nav>');
  const v2 = chipNav(goldenWeekV2());
  assert.ok(v2.startsWith('<nav class="chips" aria-label="Recap sections"><a href="#m-level">Level</a><a href="#m-review">Review</a><a href="#m-vocab">'));
  assert.ok(v2.endsWith('<a href="#m-plan">Next week</a><a href="#m-classes">Class log</a></nav>'));
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

// ── plan = next week's schedule + quota ───────────────────────────────────────────

test("planSection returns '' without vm.nextWeek, else the teal frame: title with the next-week label, a Mon–Sun row of class cells and the quota meter — no LLM plan text", () => {
  assert.equal(planSection(goldenWeek(), "07"), "");
  assert.equal(planSection({ plan: goldenWeekV2().plan }, "07"), "", "the LLM plan alone renders nothing");
  const html = planSection(goldenWeekV2(), "07");
  assert.ok(html.startsWith('<section id="m-plan" class="pad"><div class="planbox"><h2><span class="num">07</span><span>Plan for the week of <span class="nowrap">Jun 1–7</span></span></h2>'));
  const grid = /<div class="wk sched" role="table"[\s\S]*?<\/div><div class="quota">/.exec(html);
  assert.ok(grid, "grid then meter");
  assert.equal((grid[0].match(/role="columnheader"/g) || []).length, 7);
  assert.equal((grid[0].match(/<div class="wkrow" role="row">/g) || []).length, 1, "one Classes row");
  assert.ok(grid[0].includes('<span class="wkc on done" role="cell" title="Tue Jun 2 · 20:00 · 60 min · with Alex R. · done"'), "a done class is a teal cell with its time");
  assert.ok(grid[0].includes('<b>20:00</b>'));
  assert.ok(grid[0].includes('class="wkc on booked"') && grid[0].includes('<b>18:00</b><b>21:00</b>'), "two Thursday classes stack their times in one booked cell");
  assert.ok(grid[0].includes('with Sam T. &lt;script&gt;n()&lt;/script&gt; · booked'), "tutor name escaped inside the title");
  assert.equal((grid[0].match(/<span class="wkc" role="cell" aria-hidden="true"><\/span>/g) || []).length, 5, "five empty days");
  assert.ok(html.includes('<div class="qbar" role="img" aria-label="1 done, 2 booked, 2 open of 5 classes">'));
  assert.deepEqual(html.match(/<i class="qs (done|booked|open)"><\/i>/g).map((m) => /qs (\w+)/.exec(m)[1]), ["done", "booked", "booked", "open", "open"]);
  assert.ok(html.includes('<p class="qcap"><i class="qk done"></i><b>1</b> done · <i class="qk booked"></i><b>2</b> booked · <i class="qk open"></i><b>2</b> open of 5 classes · 60 min each · premium · with Alex R., Sam T. &lt;script&gt;n()&lt;/script&gt;</p>'));
  assert.ok(!html.includes("Ask your tutor") && !html.includes('class="pfocus"') && !html.includes('<ul class="plan">'), "no plan prose");
  assert.ok(!html.includes("<script>n()"), "no live script");
  assert.ok(html.endsWith("</div></div></section>"));
});

test("planSection: an empty week and an unknown quota degrade honestly (no bar, counts only)", () => {
  const vm = goldenWeekV2();
  vm.nextWeek = { ...vm.nextWeek, lessons: [], quota: { lessonsPerWeek: null, minutesPerLesson: null, tier: null, planType: null } };
  const html = planSection(vm, "07");
  assert.equal((html.match(/class="wkc on/g) || []).length, 0);
  assert.ok(!html.includes('class="qbar"'), "no meter without a plan size or classes");
  assert.ok(html.includes('<p class="qcap"><i class="qk done"></i><b>0</b> done · <i class="qk booked"></i><b>0</b> booked</p>'));
  vm.nextWeek.quota.lessonsPerWeek = 3;
  vm.nextWeek.lessons = goldenWeekV2().nextWeek.lessons.slice(0, 2);
  const html2 = planSection(vm, "07");
  assert.deepEqual(html2.match(/<i class="qs (done|booked|open)"><\/i>/g).map((m) => /qs (\w+)/.exec(m)[1]), ["done", "booked", "open"]);
  vm.nextWeek.lessons = [...goldenWeekV2().nextWeek.lessons, { lessonId: "N4", startAt: "2026-06-06T10:00:00+08:00", minutes: 60, tutor: "", state: "confirmed" }];
  const html3 = planSection(vm, "07");
  assert.equal((html3.match(/<i class="qs /g) || []).length, 4, "more classes than the plan size → the bar grows, open never negative");
  assert.ok(html3.includes("<b>0</b> open"));
});

test("SECTION_STYLES is scoped under .mk, stays ≤ 9 KB, wraps every text cell, and stacks the review band below 760px", () => {
  assert.ok(Buffer.byteLength(SECTION_STYLES, "utf8") <= 9 * 1024, `section CSS ${Buffer.byteLength(SECTION_STYLES, "utf8")} bytes`);
  const rules = SECTION_STYLES.split("\n").filter((l) => l && !l.startsWith("/*") && !l.startsWith("@media"));
  assert.ok(rules.every((l) => l.startsWith(".mk ")), "every rule is scoped under .mk");
  assert.match(SECTION_STYLES, /\.mk \.lvbig\{[^}]*font-family:var\(--disp\)[^}]*font-size:3\.1rem[^}]*color:var\(--acc\)/, "the band is the display-serif accent big number");
  assert.match(SECTION_STYLES, /\.mk \.track\{[^}]*grid-template-columns:repeat\(7,1fr\)/);
  assert.match(SECTION_STYLES, /@media \(min-width:760px\)\{\.mk \.rvgrid\{grid-template-columns:1fr 1fr\}\}/);
  assert.match(SECTION_STYLES, /\.mk \.lead,[^{]*\{overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(SECTION_STYLES, /\.mk \.sr\{position:absolute;width:1px;height:1px/);
  assert.ok(!/content:\s*"[^"]*[✓→]/.test(SECTION_STYLES), "no decorative pseudo-content glyphs — they live in markup");
});

test("level legibility: the dimension evidence lines and the footnote use --ink-soft (not the 4.35:1 muted tone), sizes unchanged", () => {
  assert.match(SECTION_STYLES, /\.mk \.dev\{grid-area:ev;font-size:\.78rem;color:var\(--ink-soft\)\}/, "evidence lines");
  assert.match(SECTION_STYLES, /\.mk \.lvfoot\{font-size:\.74rem;color:var\(--ink-soft\);font-style:italic;margin:10px 0 4px\}/, "footnote");
  // The rendered markup still carries both.
  const html = levelSection(goldenWeekV2(), "02");
  assert.ok(html.includes('<span class="dev">77 wpm with short pauses; self-repairs quickly.</span>'));
  assert.ok(html.includes('<p class="lvfoot">Estimated from this week'));
});

