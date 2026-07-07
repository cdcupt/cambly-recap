// tests/render-week.test.js — U-RN renderer edges on the week page (Q2 U-RN
// ①③④⑧⑨) plus F5/F6 a11y structure. Pure: fixture in, HTML string out, no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderWeek } from "../src/render/week.js";
import {
  goldenWeek,
  recentWeek,
  staleSiteState,
  healthySiteState,
} from "./render-fixtures.js";

test("renderWeek golden: single h1, all five section anchors + chips, stat band", () => {
  const html = renderWeek(goldenWeek());

  assert.equal((html.match(/<h1>/g) || []).length, 1, "exactly one h1");
  assert.match(html, /<h1>Week of <span class="accent">May 25 – 31, 2026<\/span><\/h1>/);
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
