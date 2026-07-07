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
import { REVEAL } from "../src/render/script.js";
import { goldenWeek, emptyWeek } from "./render-fixtures.js";

test("validateWeek + assertSigma: the golden week passes both gates", () => {
  const vm = goldenWeek();
  assert.doesNotThrow(() => validateWeek(vm));
  const facts = assertSigma(vm);
  assert.deepEqual(facts, {
    reported: 4,
    renderedGrammar: 2,
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

test("assertSigma: stats.corrections not equal to the grammar-section total aborts", () => {
  // stats.corrections is the user-facing header/badge count and must equal renderedGrammar.
  const vm = goldenWeek({ stats: { classes: 2, minutes: 90, corrections: 9, expressions: 2 } });
  assert.throws(() => assertSigma(vm), /Σ mismatch/);
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

test("F6 budget: inline CSS ≤ 15 KB and inline JS ≤ 2 KB", () => {
  assert.ok(Buffer.byteLength(STYLES, "utf8") <= MAX_CSS_BYTES, "CSS within 15 KB");
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
