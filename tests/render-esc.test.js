// tests/render-esc.test.js — the escaping + micro-markup transforms and the
// quote-guard normalization (§10). These are the renderer's trust-adjacent
// primitives: escape happens first, the three whitelisted transforms apply after,
// and the quote normalizer is NFKC + curly→straight + whitespace-collapse,
// case-PRESERVING.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  esc,
  normalizeQuote,
  gapMarkup,
  boldMarkup,
  momentMarkup,
  renderPrompt,
  renderAnswer,
  renderMoment,
} from "../src/render/esc.js";
import { numberWord, pluralize, expiryLabel, dayChipUpper, dateLabel } from "../src/render/dates.js";

test("esc: all five HTML metacharacters escape; null/undefined → empty string", () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("normalizeQuote: NFKC + curly→straight + whitespace collapse, case-preserving", () => {
  // full-width punctuation (real Chinese-topic lessons) folds under NFKC
  assert.equal(normalizeQuote("ｈｅｌｌｏ"), "hello");
  // curly quotes/apostrophes → straight
  assert.equal(normalizeQuote("“it’s”"), '"it\'s"');
  // whitespace runs (incl. newlines) collapse to one space, trimmed
  assert.equal(normalizeQuote("a   b\n\tc "), "a b c");
  // case is preserved — a case-altered quote is NOT the same string
  assert.notEqual(normalizeQuote("Hello"), normalizeQuote("hello"));
});

test("micro-markup transforms operate on already-escaped text", () => {
  assert.equal(gapMarkup("a ____ b"), 'a <span class="gapline">____</span> b');
  assert.equal(gapMarkup("x __ y"), 'x <span class="gapline">__</span> y'); // 2+ underscores
  assert.equal(boldMarkup("say **this** now"), "say <b>this</b> now");
  assert.equal(momentMarkup("he said “hi” loud"), "he said <q>hi</q> loud");
});

test("renderPrompt: escapes, gaps, and appends the italic cue only when present", () => {
  assert.equal(
    renderPrompt("My wife ____ it <x>", "like"),
    'My wife <span class="gapline">____</span> it &lt;x&gt; <em class="cue">(like)</em>',
  );
  assert.equal(renderPrompt("no gap here", null), "no gap here");
  assert.equal(renderPrompt("blank", "   "), "blank"); // whitespace cue ignored
});

test("renderAnswer / renderMoment escape then apply their single transform", () => {
  assert.equal(renderAnswer("do **it** <b>"), "do <b>it</b> &lt;b&gt;");
  assert.equal(renderMoment("read “safe <x>” now"), "read <q>safe &lt;x&gt;</q> now");
});

test("dates: numberWord spells 0–20, falls back to digits, pluralize agrees", () => {
  assert.equal(numberWord(0), "zero");
  assert.equal(numberWord(3), "three");
  assert.equal(numberWord(20), "twenty");
  assert.equal(numberWord(21), "21");
  assert.equal(pluralize(1, "class", "classes"), "class");
  assert.equal(pluralize(2, "class", "classes"), "classes");
});

test("dates: labels are Asia/Shanghai; unparseable input → empty string", () => {
  assert.equal(dayChipUpper("2026-05-28T20:00:00+08:00"), "THU");
  assert.equal(dateLabel("2026-05-28T20:00:00+08:00"), "Thu May 28");
  assert.equal(expiryLabel("2026-07-06"), "Mon Jul 6");
  assert.equal(expiryLabel(null), "");
  assert.equal(dayChipUpper("not-a-date"), "");
});
