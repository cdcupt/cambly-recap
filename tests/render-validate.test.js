// tests/render-validate.test.js — fail-closed gates (Q2 U-RN ⑩⑪⑬⑭ + F6 budget).
// The renderer re-asserts schema, ▣ quotes, the Σ-invariant, and the page budget;
// every violation throws RenderAbort so the run reports and never publishes.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateWeek,
  assertSigma,
  assertBudget,
  RenderAbort,
  MAX_PAGE_BYTES,
  MAX_CSS_BYTES,
  MAX_JS_BYTES,
} from "../src/render/validate.js";
import { STYLES } from "../src/render/styles.js";
import { SECTION_STYLES } from "../src/render/sections.js";
import { CHART_STYLES } from "../src/render/chart.js";
import { REVEAL } from "../src/render/script.js";
import { goldenWeek, goldenWeekV2, emptyWeek } from "./render-fixtures.js";

test("validateWeek + assertSigma: the golden week passes both gates", () => {
  const vm = goldenWeek();
  assert.doesNotThrow(() => validateWeek(vm));
  const facts = assertSigma(vm);
  assert.deepEqual(facts, {
    reported: 4,
    renderedGrammar: 2,
    anchoredGrammar: 2,
    derivedGrammar: 0,
    renderedVocab: 1,
    renderedPhrasing: 1,
    sum: 4,
  });
});

test("validateWeek + assertSigma: the v2 golden week (review · level · plan · derived row) passes both gates", () => {
  const vm = goldenWeekV2();
  assert.doesNotThrow(() => validateWeek(vm));
  const facts = assertSigma(vm);
  // Σ counts only anchored rows; the section total (and stats.corrections) counts every row.
  assert.deepEqual(facts, {
    reported: 4,
    renderedGrammar: 3,
    anchoredGrammar: 2,
    derivedGrammar: 1,
    renderedVocab: 1,
    renderedPhrasing: 1,
    sum: 4,
  });
});

test("validateWeek: an empty-week stub passes; a non-empty stub with arrays fails", () => {
  assert.doesNotThrow(() => validateWeek(emptyWeek()));
  const bad = { ...emptyWeek(), classes: [{ lessonId: "x" }] };
  assert.throws(() => validateWeek(bad), RenderAbort);
});

test("U-RN-⑪ schemaVersion ≠ 1 aborts before render", () => {
  assert.throws(() => validateWeek(goldenWeek({ schemaVersion: 2 })), RenderAbort);
});

test("U-RN-⑩ doctored integrity{} mismatch aborts (Σ re-assert)", () => {
  // stats say 4 but the integrity block claims a different rendered breakdown
  const vm = goldenWeek({
    integrity: { reportedCorrections: 4, renderedGrammar: 3, renderedVocab: 1, renderedPhrasing: 1, rejectedCount: 0 },
  });
  assert.throws(() => assertSigma(vm), /doctored integrity/);
});

test("U-RN-⑩ a correction id placed twice aborts even when every integrity count is consistent", () => {
  // Same id in two grammar rows (counts unchanged: anchored 3, reported 4).
  const vm = goldenWeek();
  const [g0] = vm.grammarGroups;
  assert.ok(g0.items.length >= 2, "fixture has two anchored rows in one group");
  const twice = {
    ...vm,
    grammarGroups: [{ ...g0, items: g0.items.map((it, i) => (i === 1 ? { ...it, correctionId: g0.items[0].correctionId } : it)) }, ...vm.grammarGroups.slice(1)],
  };
  assert.throws(() => assertSigma(twice), /placed more than once/);
  // Same id as a grammar row AND a vocabulary fromCorrectionId, with the integrity block "made consistent".
  const cid = g0.items[0].correctionId;
  const cross = {
    ...vm,
    vocabulary: [{ ...vm.vocabulary[0], fromCorrectionId: cid }, ...vm.vocabulary.slice(1)],
  };
  const vocabIds = cross.vocabulary.filter((v) => v.fromCorrectionId != null).length;
  const anchored = cross.grammarGroups.flatMap((g) => g.items).filter((it) => it.correctionId != null).length;
  const phr = cross.phrasing.filter((p) => p.fromCorrectionId != null).length;
  cross.integrity = { ...vm.integrity, reportedCorrections: anchored + vocabIds + phr, renderedVocab: vocabIds };
  assert.throws(() => assertSigma(cross), /placed more than once/);
  // The untouched fixtures still pass.
  assert.doesNotThrow(() => assertSigma(goldenWeek()));
  assert.doesNotThrow(() => assertSigma(goldenWeekV2()));
});

test("U-RN-⑩ a doctored derivedGrammar count aborts; an integrity block without it (older VM) is tolerated", () => {
  const doctored = goldenWeekV2({
    integrity: { reportedCorrections: 4, renderedGrammar: 3, derivedGrammar: 0, renderedVocab: 1, renderedPhrasing: 1, rejectedCount: 0 },
  });
  assert.throws(() => assertSigma(doctored), /doctored integrity/);
  const older = goldenWeekV2({
    integrity: { reportedCorrections: 4, renderedGrammar: 3, renderedVocab: 1, renderedPhrasing: 1, rejectedCount: 0 },
  });
  assert.doesNotThrow(() => assertSigma(older));
});

test("assertSigma: stats.corrections not equal to the grammar-section total aborts", () => {
  // stats.corrections is the user-facing header/badge count and must equal renderedGrammar.
  const vm = goldenWeek({ stats: { classes: 2, minutes: 90, corrections: 9, expressions: 2 } });
  assert.throws(() => assertSigma(vm), /Σ mismatch/);
});

test("assertSigma: stats.corrections must count derived rows too (header == section total), while Σ excludes them", () => {
  // Counting only the anchored rows in the header would disagree with the Grammar section.
  const anchoredOnly = goldenWeekV2({ stats: { classes: 2, minutes: 90, corrections: 2, expressions: 3 } });
  assert.throws(() => assertSigma(anchoredOnly), /stats\.corrections=2 ≠ rendered grammar 3/);
  // Counting the derived row inside Σ would over-report Cambly's records.
  const inflated = goldenWeekV2({
    integrity: { reportedCorrections: 5, renderedGrammar: 3, derivedGrammar: 1, renderedVocab: 1, renderedPhrasing: 1, rejectedCount: 0 },
  });
  assert.throws(() => assertSigma(inflated), /reportedCorrections=5 ≠ anchored grammar 2/);
});

test("assertSigma: only non-null fromCorrectionId vocab/phrasing count toward Σ", () => {
  // both fromCorrectionId cleared → Σ = grammar(2) only; stats.corrections must be 2
  const vm = goldenWeek({
    vocabulary: goldenWeek().vocabulary.map((v) => ({ ...v, fromCorrectionId: null })),
    phrasing: goldenWeek().phrasing.map((p) => ({ ...p, fromCorrectionId: null })),
    stats: { classes: 2, minutes: 90, corrections: 2, expressions: 2 },
    integrity: { reportedCorrections: 2, renderedGrammar: 2, renderedVocab: 0, renderedPhrasing: 0, rejectedCount: 0 },
  });
  assert.doesNotThrow(() => assertSigma(vm));
});

test("U-RN-⑭ a moment quote need NOT be a substring of moment.text (corpus-guarded upstream); an empty quote still aborts", () => {
  // Moment highlights are verbatim transcript lines, guarded against the real corpus in
  // the builder (which the renderer cannot see). They are not required to appear in the
  // moment.text narrative, so a non-embedded highlight no longer fails the site closed.
  const ok = goldenWeek();
  ok.classes[0].moment.quotes = ["a corpus line the narrative never embeds"];
  assert.doesNotThrow(() => validateWeek(ok));
  // The ▣ non-empty re-assert still holds.
  const empty = goldenWeek();
  empty.classes[0].moment.quotes = ["   "];
  assert.throws(() => validateWeek(empty), /moment\.quotes\[0\] empty/);
});

test("validateWeek: an empty ▣ quote field aborts", () => {
  const vm = goldenWeek();
  vm.vocabulary[0].quote = "   ";
  assert.throws(() => validateWeek(vm), /quote empty/);
});

test("validateWeek: a null example quote is allowed but a whitespace one still aborts (finding 5)", () => {
  const ok = goldenWeek();
  ok.vocabulary = [
    { id: "v1", term: "tech savvy", meaning: "good with tech", quote: null, quoteBy: null, lessonId: "L1", fromCorrectionId: null },
  ];
  assert.doesNotThrow(() => validateWeek(ok));
  // only null/undefined is the drop signal — a whitespace-only quote is still a violation
  const bad = goldenWeek();
  bad.vocabulary[0].quote = "   ";
  assert.throws(() => validateWeek(bad), /quote empty/);
});

test("validateWeek: an invalid practice format or quoteBy enum aborts", () => {
  assert.throws(
    () => validateWeek(goldenWeek({ practice: [{ id: "x", format: "MYSTERY", prompt: "p", answer: "a" }] })),
    /format invalid/,
  );
  const badQuoteBy = goldenWeek();
  badQuoteBy.vocabulary[0].quoteBy = "robot";
  assert.throws(() => validateWeek(badQuoteBy), /quoteBy invalid/);
});

// ── v2 grammar rule: correctionId null ⇔ derived:true ───────────────────────────────

test("validateWeek grammar: correctionId may be null only on a derived:true item; derived:true may not carry an id", () => {
  const nullNoDerived = goldenWeekV2();
  nullNoDerived.grammarGroups[1].items[0] = { ...nullNoDerived.grammarGroups[1].items[0], derived: false };
  assert.throws(() => validateWeek(nullNoDerived), /correctionId required \(only a derived:true item/);

  const legacyShapeNull = goldenWeek();
  legacyShapeNull.grammarGroups[0].items[0].correctionId = null; // no `derived` key at all
  assert.throws(() => validateWeek(legacyShapeNull), /correctionId required/);

  const derivedWithId = goldenWeekV2();
  derivedWithId.grammarGroups[1].items[0] = { ...derivedWithId.grammarGroups[1].items[0], correctionId: "c9" };
  assert.throws(() => validateWeek(derivedWithId), /derived:true item must not carry a correctionId/);

  const blankSaid = goldenWeekV2();
  blankSaid.grammarGroups[1].items[0] = { ...blankSaid.grammarGroups[1].items[0], said: " " };
  assert.throws(() => validateWeek(blankSaid), /said empty/);
});

// ── v2 optional blocks: absent is fine; present must be well-shaped ─────────────────

test("validateWeek: classes[].title may be absent, null, or a non-empty string — never blank", () => {
  assert.doesNotThrow(() => validateWeek(goldenWeekV2()));
  const blank = goldenWeekV2();
  blank.classes[0].title = "  ";
  assert.throws(() => validateWeek(blank), /title must be null or a non-empty string/);
});

test("validateWeek review: absent passes; empty summary, blank point/issue/fix, or a whitespace quote aborts", () => {
  const withNull = goldenWeekV2({ review: null });
  assert.doesNotThrow(() => validateWeek(withNull));
  const noSummary = goldenWeekV2({ review: { ...goldenWeekV2().review, summary: "" } });
  assert.throws(() => validateWeek(noSummary), /review\.summary empty/);
  const blankPoint = goldenWeekV2();
  blankPoint.review.wentWell[0].point = " ";
  assert.throws(() => validateWeek(blankPoint), /wentWell\[0\]\.point empty/);
  const blankFix = goldenWeekV2();
  blankFix.review.needsWork[0].fix = "";
  assert.throws(() => validateWeek(blankFix), /needsWork\[0\]\.fix empty/);
  const wsQuote = goldenWeekV2();
  wsQuote.review.needsWork[0].quote = "   ";
  assert.throws(() => validateWeek(wsQuote), /needsWork\[0\]\.quote empty \(▣\)/);
  const notArrays = goldenWeekV2({ review: { summary: "s", wentWell: "x", needsWork: [] } });
  assert.throws(() => validateWeek(notArrays), /wentWell\/needsWork must be arrays/);
});

test("validateWeek level: bad band / confidence enums, wrong bandIndex, wrong dimension count or order, >3 advice all abort", () => {
  const set = (mut) => {
    const vm = goldenWeekV2();
    mut(vm.level);
    return vm;
  };
  assert.throws(() => validateWeek(set((l) => (l.overall = "Z9"))), /level\.overall invalid band/);
  assert.throws(() => validateWeek(set((l) => (l.bandIndex = 2))), /bandIndex does not match overall/);
  assert.throws(() => validateWeek(set((l) => (l.confidence = "certain"))), /confidence invalid/);
  assert.throws(() => validateWeek(set((l) => l.dimensions.pop())), /exactly the 5 canonical dimensions/);
  assert.throws(() => validateWeek(set((l) => l.dimensions.reverse())), /dimensions\[0\]\.name must be "range"/);
  assert.throws(() => validateWeek(set((l) => (l.dimensions[2].band = "B9"))), /dimensions\[2\]\.band invalid band/);
  assert.throws(() => validateWeek(set((l) => (l.dimensions[2].bandIndex = 0))), /dimensions\[2\]\.bandIndex does not match/);
  assert.throws(() => validateWeek(set((l) => (l.dimensions[2].evidence = null))), /evidence must be a string/);
  assert.throws(() => validateWeek(set((l) => (l.summary = " "))), /level\.summary empty/);
  assert.throws(() => validateWeek(set((l) => l.advice.push({ title: "D", detail: "d" }))), /advice must be an array of at most 3/);
  assert.throws(() => validateWeek(set((l) => (l.advice[0].detail = ""))), /advice\[0\]\.detail empty/);
  // Zero advice is allowed (the builder never pads); empty evidence is allowed (an inherited dimension).
  assert.doesNotThrow(() => validateWeek(set((l) => (l.advice = []))));
  assert.doesNotThrow(() => validateWeek(set((l) => (l.dimensions[4].evidence = ""))));
});

test("validateWeek plan: empty weekLabel/focus, no items, a bad day, a blank task, a non-string why or a blank ask all abort", () => {
  const set = (mut) => {
    const vm = goldenWeekV2();
    mut(vm.plan);
    return vm;
  };
  assert.throws(() => validateWeek(set((p) => (p.weekLabel = ""))), /plan\.weekLabel empty/);
  assert.throws(() => validateWeek(set((p) => (p.focus = " "))), /plan\.focus empty/);
  assert.throws(() => validateWeek(set((p) => (p.items = []))), /items must be a non-empty array/);
  assert.throws(() => validateWeek(set((p) => (p.items[0].day = "Funday"))), /items\[0\]\.day invalid/);
  assert.throws(() => validateWeek(set((p) => (p.items[1].task = ""))), /items\[1\]\.task empty/);
  assert.throws(() => validateWeek(set((p) => (p.items[1].why = null))), /items\[1\]\.why must be a string/);
  assert.throws(() => validateWeek(set((p) => p.askTutor.push(" "))), /askTutor\[2\] empty/);
  assert.doesNotThrow(() => validateWeek(set((p) => (p.askTutor = []))));
});

// ── budgets ──────────────────────────────────────────────────────────────────────

test("U-RN-⑬ budget: a page ≥ 200 KB aborts", () => {
  const huge = "x".repeat(MAX_PAGE_BYTES + 1);
  assert.throws(() => assertBudget(huge, "big"), /budget/);
});

test("U-RN-⑬ budget: an external resource reference aborts", () => {
  const withCdn = '<link rel="stylesheet" href="https://cdn.example.com/a.css">';
  assert.throws(() => assertBudget(withCdn), /external resource/);
  const protoRel = '<script src="//evil.example.com/x.js"></script>';
  assert.throws(() => assertBudget(protoRel), /external resource/);
});

test("budget: an internal relative link and the inline data-URI favicon pass", () => {
  const ok =
    '<a href="../index.html">x</a><a href="weeks/2026-05-25.html">y</a>' +
    '<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">';
  assert.doesNotThrow(() => assertBudget(ok));
});

test("budget: escaped user content containing a pasted URL does NOT trip the external-resource gate", () => {
  // esc() turns real quotes into entities, so a pasted 'href=https://…' in transcript
  // content has no attribute quote and cannot be mistaken for an external resource.
  const pastedLink = '<p class="vq">Check href=https://grammar.example for more</p>';
  assert.doesNotThrow(() => assertBudget(pastedLink));
  const pastedAnchor = '<p>&lt;a href=https://x.co&gt;link&lt;/a&gt;</p>';
  assert.doesNotThrow(() => assertBudget(pastedAnchor));
  // A genuine emitted (quoted) external attribute is still caught.
  assert.throws(() => assertBudget('<img src="https://cdn.example/x.png">'), /external resource/);
});

test("F6 budget: the whole inline CSS (STYLES + SECTION_STYLES + CHART_STYLES) ≤ 28 KB and inline JS ≤ 2 KB", () => {
  assert.equal(MAX_CSS_BYTES, 28 * 1024);
  const css = STYLES + SECTION_STYLES + CHART_STYLES;
  assert.ok(Buffer.byteLength(css, "utf8") <= MAX_CSS_BYTES, `CSS within 28 KB (got ${Buffer.byteLength(css, "utf8")})`);
  assert.ok(Buffer.byteLength(REVEAL, "utf8") <= MAX_JS_BYTES, "reveal JS within 2 KB");
});

test("A11y CSS: revealed cards drop the hint (display:none, no dead gap); back-link keeps a 44px target", () => {
  // A revealed practice card removes the "Tap to reveal" pill from flow (display:none)
  // so the answer box sits flush — the old visibility:hidden reserved an empty gap.
  assert.match(STYLES, /\.pq\[aria-expanded="true"\] \.phint\{display:none\}/);
  assert.ok(!STYLES.includes(".phint{visibility:hidden}"), "hint no longer merely visibility:hidden");
  // The header back-link is a ≥44px WCAG 2.5.5 tap target.
  assert.match(STYLES, /\.sub a\.backlink\{[^}]*min-height:44px/);
});
