// tests/render-week.test.js — U-RN renderer edges on the week page (Q2 U-RN
// ①③④⑧⑨) plus F5/F6 a11y structure. Pure: fixture in, HTML string out, no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderWeek } from "../src/render/week.js";
import { STYLES } from "../src/render/styles.js";
import {
  goldenWeek,
  goldenWeekV2,
  recentWeek,
  staleSiteState,
  healthySiteState,
} from "./render-fixtures.js";

const LEGACY_IDS = ["m-classes", "m-vocab", "m-grammar", "m-phrasing", "m-practice"];
const V2_IDS = ["m-review", "m-level", ...LEGACY_IDS, "m-plan"];
const sectionIds = (html) => [...html.matchAll(/<section id="(m-[a-z]+)"/g)].map((m) => m[1]);
const sectionNums = (html) => [...html.matchAll(/<span class="num">(\d\d)<\/span>/g)].map((m) => m[1]);
const chipHrefs = (html) => {
  const nav = /<nav class="chips"[^>]*>(.*?)<\/nav>/.exec(html)[1];
  return [...nav.matchAll(/href="#(m-[a-z]+)"/g)].map((m) => m[1]);
};

test("renderWeek golden: single h1, all five section anchors + chips, stat band", () => {
  const html = renderWeek(goldenWeek());

  assert.equal((html.match(/<h1>/g) || []).length, 1, "exactly one h1");
  assert.match(html, /<h1>Week of <span class="accent"><span class="nowrap">May 25 – 31, 2026<\/span><\/span><\/h1>/);
  for (const id of ["m-classes", "m-vocab", "m-grammar", "m-phrasing", "m-practice"]) {
    assert.ok(html.includes(`id="${id}"`), `section ${id} present`);
    assert.ok(html.includes(`href="#${id}"`), `chip for ${id} present`);
  }
  // stat band — four precomputed numbers with their labels
  assert.match(html, /<div class="n">2<\/div><div class="l">classes<\/div>/);
  assert.match(html, /<div class="n">90<\/div><div class="l">minutes<\/div>/);
  // corrections stat = the Grammar section total (renderedGrammar=2), not the raw Σ anchor (4)
  assert.match(html, /<div class="n">2<\/div><div class="l">corrections<\/div>/);
  assert.match(html, /<div class="n">2<\/div><div class="l">expressions<\/div>/);
});

test("renderWeek: header back-link carries the .backlink class (styled to a ≥44px tap target)", () => {
  const html = renderWeek(goldenWeek());
  assert.match(
    html,
    /<a class="backlink" href="\.\.\/index\.html">← All weeks<\/a>/,
    "back-link opts into the enlarged tap target while staying a text link",
  );
});

test("renderWeek: the per-class chip reads 'flagged', never colliding with the grammar 'fixes' term (finding 4)", () => {
  const html = renderWeek(goldenWeek());
  // The raw per-lesson corrective-feedback count renders as a "flagged" chip …
  assert.match(html, /<i>\d+ flagged<\/i>/, "class chip relabelled to 'flagged'");
  // … and no longer as an <i>N fixes</i> chip that would read as the same number as the
  // header/index/grammar "fixes" (which count only rendered grammar).
  assert.ok(!/<i>\d+ fixes<\/i>/.test(html), "no class chip still says 'fixes'");
});

test("renderWeek: landmarks + self-contained document shell", () => {
  const html = renderWeek(goldenWeek());
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('<html lang="en" class="no-js">'), "ships no-js class");
  assert.ok(html.includes("document.documentElement.className='js'"), "head boot line");
  assert.ok(html.includes("<header"), "header landmark");
  assert.ok(html.includes('<nav class="chips"'), "nav landmark");
  assert.ok(html.includes("<main>"), "main landmark");
  assert.ok(html.includes('<footer class="wknav">'), "footer landmark");
  assert.ok(html.includes('href="data:image/svg+xml,'), "inline data-URI favicon");
});

test("renderWeek: practice cards carry the full tap-to-reveal a11y contract (F5)", () => {
  const html = renderWeek(goldenWeek());
  // two cards → pa1, pa2, each button controls its answer region
  assert.match(html, /<button class="pq" aria-expanded="false" aria-controls="pa1">/);
  assert.match(html, /<div class="pa" id="pa1" hidden>/);
  assert.match(html, /<button class="pq" aria-expanded="false" aria-controls="pa2">/);
  assert.match(html, /<div class="pa" id="pa2" hidden>/);
  // progress: aria-live text seeded to N, decorative bar aria-hidden
  assert.match(html, /<p class="ptxt" id="ptxt" aria-live="polite">0 of 2 revealed<\/p>/);
  assert.match(html, /<div class="pbar" aria-hidden="true"><i id="pfill"><\/i><\/div>/);
  assert.ok(html.includes('<button class="pall" id="revealall">'), "reveal-all button");
  // the reveal mechanic ships on a page that has practice
  assert.ok(html.includes("aria-controls"), "reveal script wiring present");
  assert.ok(html.includes("querySelectorAll('.pq')"), "reveal script inlined");
});

test("renderWeek: reveal script omitted when there is no practice", () => {
  const vm = goldenWeek({ practice: [] });
  const html = renderWeek(vm);
  assert.ok(!html.includes("querySelectorAll('.pq')"), "no reveal script");
  // zero-item practice section keeps its heading + one muted line
  assert.ok(html.includes('id="m-practice"'), "practice section still present");
  assert.match(html, /Practice — tap to reveal<\/h2><p class="empty-note">No practice drills this week\.<\/p>/);
});

test("U-RN-① zero-item section keeps its h2 + chip, body collapses to one muted line", () => {
  const vm = goldenWeek({ vocabulary: [] });
  const html = renderWeek(vm);
  assert.ok(html.includes('id="m-vocab"'), "vocab section kept");
  assert.ok(html.includes('href="#m-vocab"'), "vocab chip kept");
  assert.match(html, /<span class="num">02<\/span>Vocabulary of the week<\/h2><p class="empty-note">No new vocabulary this week\.<\/p>/);
});

test("U-RN-⑧ XSS: a <script> in transcript content renders escaped, never live", () => {
  const html = renderWeek(goldenWeek());
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "topic script escaped");
  assert.ok(html.includes("a diet popular fast &lt;script&gt;x&lt;/script&gt;"), "vocab script escaped");
  assert.ok(!html.includes("<script>alert(1)"), "no live injected script tag");
});

test("U-RN-⑨ micro-markup applies after escaping: gap, bold, moment <q>, cue", () => {
  const html = renderWeek(goldenWeek());
  assert.ok(html.includes('<span class="gapline">____</span>'), "____ → gapline");
  assert.ok(html.includes("<b>likes</b>"), "**likes** → <b>");
  assert.ok(html.includes("<q>I cut out soda</q>"), "curly span → <q>");
  assert.ok(html.includes('<em class="cue">(like)</em>'), "cue → italic hint");
});

test("U-RN-③ authStale banner is injected above the header with the verbatim recovery commands", () => {
  const html = renderWeek(goldenWeek(), { siteState: staleSiteState() });
  assert.ok(html.includes('<div class="banner" role="alert">'), "role=alert banner");
  assert.ok(html.includes("Cambly session expired Mon Jul 6"), "expiry date");
  // both commands rendered verbatim in <code> (ampersands HTML-escaped)
  assert.ok(html.includes("<code>Re-harvest your Cambly session in a browser and save cambly-state.json (see the README).</code>"));
  assert.ok(html.includes("<code>Copy cambly-state.json to the server, then re-run the generator.</code>"));
  // banner precedes the header
  assert.ok(html.indexOf('class="banner"') < html.indexOf("<header"), "banner above header");
});

test("U-RN-④ authStale:false emits zero banner markup anywhere", () => {
  const html = renderWeek(goldenWeek(), { siteState: healthySiteState() });
  assert.ok(!html.includes('role="alert"'), "no alert role");
  assert.ok(!html.includes('class="banner"'), "no banner element");
});

test("renderWeek: grammar group >3 items previews two and collapses the rest in native <details>", () => {
  const bigGroup = {
    pattern: "Prepositions",
    rule: null,
    items: Array.from({ length: 5 }, (_, i) => ({
      id: `x${i}`,
      said: `said ${i}`,
      fix: `fix ${i}`,
      why: `why ${i}`,
      lessonId: "L1",
      correctionId: `k${i}`,
    })),
  };
  const vm = goldenWeek({
    grammarGroups: [bigGroup],
    // Σ stays closed: 5 grammar + 1 vocab + 1 phrasing = 7 (raw anchor in integrity).
    // stats.corrections = renderedGrammar = 5 (the Grammar section total).
    stats: { classes: 2, minutes: 90, corrections: 5, expressions: 2 },
    integrity: { reportedCorrections: 7, renderedGrammar: 5, renderedVocab: 1, renderedPhrasing: 1, rejectedCount: 0 },
  });
  const html = renderWeek(vm);
  assert.match(html, /<span class="cnt">5<\/span>/, "count badge = 5");
  assert.match(html, /<details class="more"><summary>Show 3 more<\/summary>/, "collapses 3 behind details");
  // rule:null → no rule line for this group
  assert.ok(!html.includes('<p class="rule">'), "null rule omits the rule line");
});

test("renderWeek: a vocab item with no example quote renders term + meaning, no quote line (finding 5)", () => {
  const vm = goldenWeek({
    vocabulary: [
      { id: "v1", term: "tech savvy", meaning: "good with technology", quote: null, quoteBy: null, lessonId: "L1", fromCorrectionId: null },
    ],
    stats: { classes: 2, minutes: 90, corrections: 2, expressions: 1 },
  });
  const html = renderWeek(vm);
  assert.ok(html.includes("<b>tech savvy</b>"), "term rendered");
  assert.ok(html.includes("good with technology"), "meaning rendered");
  assert.ok(!html.includes('class="vq"'), "no quote line when the example is absent");
});

test("renderWeek: tutor-quoted vocab gets the — tutor attribution; student quote does not", () => {
  const html = renderWeek(goldenWeek());
  assert.ok(html.includes("This is called binge watching.” — Alex R."), "tutor attribution appended");
  // student quote line has no em-dash tutor suffix
  assert.match(html, /diets that become popular very quickly”<\/p>/);
});

test("renderWeek recent shape: Focus & tutor feedback renders — AI summary, tutor note + Chinese line, Next-focus chip", () => {
  const html = renderWeek(recentWeek());
  assert.ok(html.includes('<div class="focus">'), "focus block present");
  assert.ok(html.includes(`<div class="fhead">Focus &amp; tutor feedback</div>`), "labeled block heading (escaped &)");
  // AI coach summary (verbatim Cambly prose) rendered
  assert.ok(html.includes("kept the past tense steady across a long story"), "AI coach summary rendered");
  // tutor note with its Chinese translation as the secondary line
  assert.ok(html.includes(`<p class="en">Great flow. Keep an eye on irregular past verbs when you speed up.</p>`), "tutor note (en) rendered");
  assert.ok(html.includes(`<p class="zh">表达很流畅。加快语速时注意不规则动词的过去式。</p>`), "Chinese secondary line rendered");
  // prominent Next-focus chip
  assert.match(
    html,
    /<p class="fnext"><b>Next focus<\/b><span>Maintaining Past Tense While Narrating Work Stories<\/span><\/p>/,
    "Next-focus chip",
  );
});

test("renderWeek older shape: no Focus & tutor feedback block (tutorFocus absent)", () => {
  const html = renderWeek(goldenWeek());
  assert.ok(!html.includes('class="focus"'), "no focus block for older lessons");
  assert.ok(!html.includes("Focus &amp; tutor feedback"), "no focus heading for older lessons");
});

test("renderWeek: a screaming ALL-CAPS topic is softened for display (BETA FIX 3), data untouched", () => {
  const greeting = "HELLO EVERYONE NICE TO MEET YOU TODAY WE WILL TALK";
  const vm = goldenWeek();
  vm.classes[0].topic = greeting;
  const html = renderWeek(vm);
  assert.ok(html.includes("Hello everyone nice to meet you"), "topic softened to sentence case");
  assert.ok(!html.includes(greeting), "the raw screaming topic is not displayed verbatim");
  // display-only: the VM's stored topic is not mutated by rendering
  assert.equal(vm.classes[0].topic, greeting, "stored topic string is untouched");
});

test("renderWeek: an over-long topic is capped with an ellipsis in the class card (BETA FIX 3)", () => {
  const longTopic = "A very long conversation about the history of tea and coffee across many centuries";
  const vm = goldenWeek();
  vm.classes[0].topic = longTopic;
  const html = renderWeek(vm);
  assert.ok(html.includes("…"), "an ellipsis marks the truncation");
  assert.ok(!html.includes(longTopic), "the full over-long topic is not shown verbatim");
});

test("renderWeek: minutes show in the header stat band and per-class cards (no 0 min)", () => {
  const html = renderWeek(recentWeek());
  // header stat band carries the summed minutes
  assert.match(html, /<div class="n">90<\/div><div class="l">minutes<\/div>/, "header minutes = 90");
  // each class card shows its own scheduledMinutes (substring guards against the 0-min regression)
  assert.ok(html.includes(">60 min "), "class R1 shows 60 min");
  assert.ok(html.includes(">30 min "), "class R2 shows 30 min");
});

test("renderWeek recent shape: a grammar-empty week is never content-empty — grammar note + focus + practice all present", () => {
  const html = renderWeek(recentWeek());
  // grammar collapses to its one muted line (older zero-item behavior kept)
  assert.match(html, /Grammar corrections<\/h2><p class="empty-note">No grammar corrections this week\.<\/p>/);
  // ...but the page still carries coaching content AND a real practice card
  assert.ok(html.includes('<div class="focus">'), "focus content present despite zero grammar");
  assert.match(html, /<button class="pq" aria-expanded="false" aria-controls="pa1">/, "a real practice card");
  assert.ok(html.includes("querySelectorAll('.pq')"), "reveal script shipped (practice non-empty)");
});

test("renderWeek recent shape: tutorFocus content is escaped (nextFocus XSS probe), never live", () => {
  const html = renderWeek(recentWeek());
  assert.ok(html.includes("Using future forms for plans &lt;script&gt;x&lt;/script&gt;"), "nextFocus script escaped");
  assert.ok(!html.includes("<script>x</script>"), "no live injected script from tutorFocus");
});

// ── recap v2: dynamic sections, tutors, titles, work-on, derived rows, examples ─────

test("v2: an older VM (no review/level/plan) renders EXACTLY the five legacy sections, numbered 01..05, five chips in order", () => {
  const html = renderWeek(goldenWeek());
  assert.deepEqual(sectionIds(html), LEGACY_IDS);
  assert.deepEqual(sectionNums(html), ["01", "02", "03", "04", "05"]);
  assert.deepEqual(chipHrefs(html), LEGACY_IDS);
  for (const id of ["m-review", "m-level", "m-plan"]) assert.ok(!html.includes(`id="${id}"`), `${id} absent`);
  assert.ok(!html.includes("Level estimate") && !html.includes("The week in review") && !html.includes("Plan for the week"));
});

test("v2: a VM carrying every block renders all eight sections in order Review · Level · Classes · Vocabulary · Grammar · Phrasing · Practice · Plan, numbered 01..08", () => {
  const html = renderWeek(goldenWeekV2());
  assert.deepEqual(sectionIds(html), V2_IDS);
  assert.deepEqual(sectionNums(html), ["01", "02", "03", "04", "05", "06", "07", "08"]);
  assert.deepEqual(chipHrefs(html), V2_IDS);
  assert.equal((html.match(/<h1>/g) || []).length, 1, "still exactly one h1");
  assert.match(html, /<span class="num">01<\/span>The week in review<\/h2>/);
  assert.match(html, /<span class="num">02<\/span>Level estimate<\/h2>/);
  assert.match(html, /<span class="num">03<\/span>The class log<\/h2>/);
  assert.match(html, /<span class="num">07<\/span>Practice — tap to reveal<\/h2>/);
  assert.match(html, /<span class="num">08<\/span><span>Plan for the week of <span class="nowrap">Jun 1–7<\/span><\/span><\/h2>/);
});

test("v2: numbering stays sequential when only SOME optional blocks are present (chips follow)", () => {
  const levelOnly = renderWeek(goldenWeekV2({ review: undefined, plan: undefined }));
  assert.deepEqual(sectionIds(levelOnly), ["m-level", ...LEGACY_IDS]);
  assert.deepEqual(sectionNums(levelOnly), ["01", "02", "03", "04", "05", "06"]);
  assert.deepEqual(chipHrefs(levelOnly), ["m-level", ...LEGACY_IDS]);
  const planOnly = renderWeek(goldenWeekV2({ review: null, level: null }));
  assert.deepEqual(sectionIds(planOnly), [...LEGACY_IDS, "m-plan"]);
  assert.deepEqual(sectionNums(planOnly), ["01", "02", "03", "04", "05", "06"]);
  assert.match(planOnly, /<span class="num">06<\/span><span>Plan for the week of/);
});

test("v2: the header names the tutor; each class card reads an eyebrow (min · with <tutor>) and the title-or-topic as its headline", () => {
  const html = renderWeek(goldenWeekV2());
  assert.match(html, /<p class="sub">2 classes with Alex R\. · published/);
  // Generic "Pro Lesson" topic → the LLM title is the headline (escaped), never the generic topic.
  assert.ok(
    html.includes('<span>30 min · with Alex R.</span></div><h3 class="ctitle">Lunch breaks &amp; indoor workdays &lt;script&gt;t()&lt;/script&gt;</h3>'),
    "eyebrow + title headline on card 1",
  );
  assert.ok(!html.includes("Pro Lesson"), "the generic topic is not displayed when a title exists");
  // title:null → the topic is the headline (softened by displayTopic), the tutor stays in the eyebrow.
  assert.ok(
    html.includes('<span>60 min · with Alex R.</span></div><h3 class="ctitle">Screen habits &lt;script&gt;alert(1)&lt;/script&gt;</h3>'),
    "eyebrow + topic headline on card 2",
  );
  // The legacy fixture (specific topic, tutor "Alex R.") reads the same way.
  assert.ok(
    renderWeek(goldenWeek()).includes('<span>30 min · with Alex R.</span></div><h3 class="ctitle">Food for Thought</h3>'),
    "eyebrow + topic headline on the legacy card",
  );
});

test("v2: a class with an empty tutor renders no '· with' suffix", () => {
  const vm = goldenWeekV2();
  vm.classes[1].tutor = "";
  const html = renderWeek(vm);
  assert.ok(html.includes('<span>60 min</span></div><h3 class="ctitle">Screen habits &lt;script&gt;alert(1)&lt;/script&gt;</h3>'), "no dangling with");
  assert.ok(!/<span>60 min · with/.test(html));
});

test("regression (visual): the class title is the card headline — ink display serif, never the small-caps day caption", () => {
  // The title lives in its own h3, outside the uppercase `.day span` caption …
  const html = renderWeek(goldenWeekV2());
  const card = /<article class="ccard">([\s\S]*?)<\/article>/.exec(html)[1];
  assert.match(card, /^<div class="day"><b>[^<]+<\/b><span>30 min · with Alex R\.<\/span><\/div><h3 class="ctitle">/);
  assert.ok(!/<span>[^<]*Lunch breaks/.test(card), "the title is not inside the day caption");
  // … whose rule never uppercases (displayTopic's sentence-case softening must reach the page) and reads as a headline.
  const rule = /\.mk \.ccard \.ctitle\{([^}]*)\}/.exec(STYLES)[1];
  assert.ok(!/text-transform/.test(rule), "no text-transform on the title");
  assert.match(rule, /font-family:var\(--disp\)/);
  assert.match(rule, /color:var\(--mink\)/);
  assert.match(rule, /font-size:1\.0[0-9]rem/);
  assert.match(STYLES, /\.mk \.ccard \.day b\{font-size:\.78rem/, "the date steps back to an eyebrow");
  assert.match(STYLES, /\.mk \.ccard \.ctitle,/, "the headline is in the defensive overflow-wrap list");
  // A screaming ALL-CAPS title is softened to sentence case and stays that way in the markup.
  const vm = goldenWeekV2();
  vm.classes[0].title = "LUNCH BREAKS AND INDOOR WORKDAYS";
  assert.ok(renderWeek(vm).includes('<h3 class="ctitle">Lunch breaks and indoor workdays</h3>'));
  // No title and no topic → no empty headline; the card is flagged so the date takes the headline role.
  const bare = goldenWeekV2();
  bare.classes[0].title = null;
  bare.classes[0].topic = null;
  const bareHtml = renderWeek(bare);
  assert.ok(bareHtml.includes('<article class="ccard nohead"><div class="day">'));
  assert.equal((bareHtml.match(/<h3 class="ctitle">/g) || []).length, 1, "only the second card has a headline");
  assert.ok(!bareHtml.includes('<h3 class="ctitle"></h3>'));
  assert.match(STYLES, /\.mk \.ccard\.nohead \.day b\{font-family:var\(--disp\)/);
});

test("v2: the Focus box gains a 'Work on' line (accent-edged), escaped, only when workOn is present", () => {
  const html = renderWeek(goldenWeekV2());
  assert.ok(html.includes('<p class="fwork"><b>Work on</b>Put the article before every singular count noun &lt;script&gt;w()&lt;/script&gt;</p>'), "work-on line rendered + escaped");
  // The line sits inside the Focus box, after the AI summary and before Next focus.
  const focus = /<div class="focus">([\s\S]*?)<\/div><\/article>/.exec(html)[1];
  assert.ok(focus.indexOf('class="fai"') < focus.indexOf('class="fwork"') && focus.indexOf('class="fwork"') < focus.indexOf('class="fnext"'));
  // recentWeek has no workOn → no line.
  assert.ok(!renderWeek(recentWeek()).includes('class="fwork"'));
});

test("v2: a transcript-derived grammar row carries the <i class=\"src\">transcript</i> tag and the subtitle splits the counts", () => {
  const html = renderWeek(goldenWeekV2());
  assert.ok(html.includes('<span class="fix">I go to the office every day</span><i class="src">transcript</i>'), "derived row tagged");
  assert.equal((html.match(/<i class="src">transcript<\/i>/g) || []).length, 1, "only the derived row is tagged");
  assert.match(html, /<p class="ssub">3 grammar fixes — 2 flagged by Cambly · 1 spotted in your transcript, grouped into 2 habits\. Strike = what you said\.<\/p>/);
  assert.ok(html.includes("I go to office every day &lt;script&gt;g()&lt;/script&gt;"), "derived said escaped");
  // The header stat equals the section total (3), not the Σ anchor (4) nor anchored-only (2).
  assert.match(html, /<div class="n">3<\/div><div class="l">corrections<\/div>/);
});

test("v2: grammar subtitle keeps the legacy sentence when every row is Cambly-flagged, and says so when every row is derived", () => {
  assert.match(renderWeek(goldenWeek()), /<p class="ssub">All 2 grammar fixes from the week, grouped into 1 habit\. Strike = what you said\.<\/p>/);
  const allDerived = goldenWeekV2({
    grammarGroups: [goldenWeekV2().grammarGroups[1]],
    vocabulary: goldenWeekV2().vocabulary.map((v) => ({ ...v, fromCorrectionId: null })),
    phrasing: goldenWeekV2().phrasing.map((p) => ({ ...p, fromCorrectionId: null })),
    stats: { classes: 2, minutes: 90, corrections: 1, expressions: 3 },
    integrity: { reportedCorrections: 0, renderedGrammar: 1, derivedGrammar: 1, renderedVocab: 0, renderedPhrasing: 0, rejectedCount: 0 },
  });
  assert.match(renderWeek(allDerived), /<p class="ssub">1 grammar fix — 1 spotted in your transcript, grouped into 1 habit\. Strike = what you said\.<\/p>/);
});

test("v2: a vocab card with no clean quote shows the model sentence as an 'e.g.' line (escaped); a card with a quote never shows one", () => {
  const html = renderWeek(goldenWeekV2());
  assert.ok(html.includes('<p class="veg">e.g. I&#39;m completely swamped with work today &lt;script&gt;e()&lt;/script&gt;</p>'), "e.g. line rendered + escaped");
  assert.equal((html.match(/class="veg"/g) || []).length, 1, "only the quote-less card gets an e.g. line");
  const swamped = /<div class="vword"><div class="w"><b>swamped<\/b>[\s\S]*?<\/div><\/div>/.exec(html)[0];
  assert.ok(!swamped.includes('class="vq"'), "no quote line on the e.g. card");
  // example present but a quote also present → the quote wins (defensive).
  const both = goldenWeekV2();
  both.vocabulary[0].example = "should not show";
  assert.ok(!renderWeek(both).includes("should not show"));
});

test("v2 XSS: every new field (title, workOn, example, derived said, review, level, plan) renders escaped — zero live script tags", () => {
  const html = renderWeek(goldenWeekV2());
  const probes = ["t()", "w()", "e()", "g()", "r()", "ww()", "nw()", "d()", "ls()", "a()", "p()", "pi()", "at()"];
  for (const p of probes) {
    assert.ok(html.includes(`&lt;script&gt;${p}&lt;/script&gt;`), `probe ${p} escaped`);
    assert.ok(!html.includes(`<script>${p}</script>`), `probe ${p} never live`);
  }
  // The only <script> tags on the page are the head boot line and the reveal mechanic.
  assert.equal((html.match(/<script>/g) || []).length, 2);
});

test("v2: the level band is the page's one big number and the page stays self-contained + within budget", () => {
  const html = renderWeek(goldenWeekV2());
  assert.match(html, /<span class="lvbig">B1\+<\/span>/);
  assert.equal((html.match(/class="lvbig"/g) || []).length, 1);
  assert.ok(!/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(html), "no external resource");
  assert.ok(Buffer.byteLength(html, "utf8") < 200 * 1024);
});

// ── polish pass: nav chips · per-row tag · header tutors · non-breaking week labels ──

/** goldenWeekV2 reduced to its ONE derived grammar row (every row derived, Σ closes on 0). */
function allDerivedWeek() {
  const v2 = goldenWeekV2();
  return goldenWeekV2({
    grammarGroups: [v2.grammarGroups[1]],
    vocabulary: v2.vocabulary.map((v) => ({ ...v, fromCorrectionId: null })),
    phrasing: v2.phrasing.map((p) => ({ ...p, fromCorrectionId: null })),
    stats: { classes: 2, minutes: 90, corrections: 1, expressions: 3 },
    integrity: { reportedCorrections: 0, renderedGrammar: 1, derivedGrammar: 1, renderedVocab: 0, renderedPhrasing: 0, rejectedCount: 0 },
  });
}

test("nav chips WRAP instead of scrolling: flex-wrap on the sticky bar, ≥44px tap targets, no hidden-overflow row, all eight chips present", () => {
  const nav = /\.mk nav\.chips\{([^}]*)\}/.exec(STYLES)[1];
  assert.match(nav, /position:sticky/, "the bar stays sticky");
  assert.match(nav, /display:flex/);
  assert.match(nav, /flex-wrap:wrap/, "chips wrap onto a second row when they do not fit");
  assert.ok(!/overflow-x:auto|white-space:nowrap|scrollbar-width/.test(nav), "no scrolling row that hides Phrasing/Practice/Plan off-screen with no affordance");
  const chip = /\.mk nav\.chips a\{([^}]*)\}/.exec(STYLES)[1];
  assert.match(chip, /display:inline-flex/);
  assert.match(chip, /min-height:44px/, "WCAG 2.5.5 tap target kept with the tighter vertical padding");
  assert.match(chip, /padding:8px 10px/, "vertical padding tightened from 12px");
  assert.match(chip, /white-space:nowrap/, "a chip's own label never breaks mid-word");
  assert.ok(!STYLES.includes("nav.chips a:first-child"), "the bar carries the gutter (padding) so a wrapped second row aligns with the first");
  assert.equal(chipHrefs(renderWeek(goldenWeekV2())).length, 8, "a full v2 week ships all eight chips");
});

test("v2: the per-row TRANSCRIPT tag is omitted when EVERY grammar row is derived (the sub-line already says so) and kept only in a mixed week", () => {
  const mixed = renderWeek(goldenWeekV2());
  assert.equal((mixed.match(/<i class="src">transcript<\/i>/g) || []).length, 1, "mixed week: the derived row is tagged");
  const html = renderWeek(allDerivedWeek());
  assert.ok(!html.includes('class="src"'), "all-derived week: no per-row tag");
  assert.match(html, /<p class="ssub">1 grammar fix — 1 spotted in your transcript, grouped into 1 habit\./, "the sub-line carries the provenance instead");
  assert.ok(html.includes('<span class="fix">I go to the office every day</span><span class="why">'), "the row itself is unchanged apart from the tag");
});

test("header tutor line: all named → 'with A, B'; some unnamed → 'with Alex R. and 1 other tutor' (pluralised); none named → no 'with'", () => {
  const named = goldenWeekV2();
  assert.match(renderWeek(named), /<p class="sub">2 classes with Alex R\. · published/, "one tutor named once");
  named.classes[1].tutor = "Sam T.";
  assert.match(renderWeek(named), /<p class="sub">2 classes with Alex R\., Sam T\. · published/, "two named tutors listed");
  const some = goldenWeekV2();
  some.classes[1].tutor = "";
  assert.match(renderWeek(some), /<p class="sub">2 classes with Alex R\. and 1 other tutor · published/, "an unnamed class is counted, not dropped");
  const more = goldenWeekV2();
  more.classes = [...more.classes, { ...more.classes[1], lessonId: "L3", tutor: "" }];
  more.classes[1].tutor = "   "; // whitespace-only counts as unnamed
  assert.match(renderWeek(more), /<p class="sub">3 classes with Alex R\. and 2 other tutors · published/, "plural 'tutors'");
  const none = goldenWeekV2();
  for (const c of none.classes) c.tutor = "";
  const sub = /<p class="sub">[\s\S]*?<\/p>/.exec(renderWeek(none))[0];
  assert.match(sub, /^<p class="sub">2 classes · published/, "no 'with' at all when no class names a tutor");
  assert.ok(!sub.includes(" with "), "no dangling 'with'");
  assert.ok(!sub.includes("other tutor"), "no 'N other tutors' without a named one to anchor it");
});

test("cross-month week labels never break at the spaced en dash: h1, Plan title and footer nav wrap the label in .nowrap; the CSS rule exists", () => {
  const vm = goldenWeekV2({ weekLabel: "Jun 29 – Jul 5" });
  vm.plan.weekLabel = "Jul 27 – Aug 2";
  const html = renderWeek(vm, {
    prev: { weekId: "2026-06-22", weekLabel: "Jun 22–28" },
    next: { weekId: "2026-07-06", weekLabel: "Jul 6–12" },
  });
  assert.ok(html.includes('<h1>Week of <span class="accent"><span class="nowrap">Jun 29 – Jul 5</span></span></h1>'), "h1");
  assert.ok(html.includes('<h2><span class="num">08</span><span>Plan for the week of <span class="nowrap">Jul 27 – Aug 2</span></span></h2>'), "plan title: one title span (the h2 is a flex row) around the nowrap label");
  assert.ok(html.includes('<a href="2026-06-22.html"><span>← Week of <span class="nowrap">Jun 22–28</span></span></a>'), "footer prev");
  assert.ok(html.includes('<a href="2026-07-06.html"><span>Week of <span class="nowrap">Jul 6–12</span> →</span></a>'), "footer next");
  assert.match(STYLES, /\.mk \.nowrap\{white-space:nowrap;overflow-wrap:normal;word-break:normal\}/, "the rule also cancels the defensive overflow-wrap:anywhere inherited from its container");
  assert.ok(html.includes('<title>Week of Jun 29 – Jul 5 · Cambly Recap</title>'), "the <title> stays plain text");
});
