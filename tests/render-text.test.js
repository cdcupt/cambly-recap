// tests/render-text.test.js — display-only topic shaping (BETA FIX 3). The transform
// softens a screaming ALL-CAPS greeting and caps an over-long topic, for DISPLAY only —
// it never mutates stored data (the caller passes a fresh value each render).

import { test } from "node:test";
import assert from "node:assert/strict";

import { displayTopic } from "../src/render/text.js";

test("displayTopic: a screaming ALL-CAPS greeting is softened to sentence case", () => {
  const raw = "HELLO EVERYONE NICE TO MEET YOU";
  const out = displayTopic(raw);
  assert.equal(out, "Hello everyone nice to meet you");
  assert.ok(!/[A-Z]{4,}/.test(out), "no screaming run survives");
});

test("displayTopic: sentence case capitalizes after each sentence terminator", () => {
  assert.equal(displayTopic("HELLO THERE. HOW ARE YOU TODAY"), "Hello there. How are you today");
});

test("displayTopic: a normal mixed-case topic passes through untouched", () => {
  assert.equal(displayTopic("Physical Descriptions"), "Physical Descriptions");
  assert.equal(displayTopic("Food for Thought"), "Food for Thought");
});

test("displayTopic: a lone short acronym is NOT treated as screaming", () => {
  // fewer than 3 words → left alone (avoids clobbering titles/acronyms)
  assert.equal(displayTopic("TOEFL"), "TOEFL");
  assert.equal(displayTopic("PHYSICAL DESCRIPTIONS"), "PHYSICAL DESCRIPTIONS");
});

test("displayTopic: a non-Latin topic (no A–Z) is never altered", () => {
  assert.equal(displayTopic("值得深思"), "值得深思");
  assert.equal(displayTopic("专业成长"), "专业成长");
});

test("displayTopic: an over-long topic is capped to ~60 chars with an ellipsis, on a word boundary", () => {
  const raw = "A very long conversation about the history of tea and coffee across many different countries and centuries";
  const out = displayTopic(raw);
  assert.ok(out.length <= 61, `capped length ${out.length} ≤ ~60 + ellipsis`);
  assert.ok(out.endsWith("…"), "ends with an ellipsis");
  assert.ok(!out.endsWith(" …"), "no dangling space before the ellipsis");
  assert.ok(raw.startsWith(out.slice(0, -1)), "the kept head is a real prefix of the original");
});

test("displayTopic: a 60+ char unbroken token is still clipped (no infinite-width label)", () => {
  const raw = "x".repeat(120);
  const out = displayTopic(raw);
  assert.ok(out.length <= 61, "hard-capped even without a word boundary");
  assert.ok(out.endsWith("…"), "ellipsis appended");
});

test("displayTopic: null / undefined / blank / non-string → empty string", () => {
  assert.equal(displayTopic(null), "");
  assert.equal(displayTopic(undefined), "");
  assert.equal(displayTopic("   "), "");
  assert.equal(displayTopic(42), "");
});

test("displayTopic: does not mutate — repeated calls on the same input are stable", () => {
  const raw = "HELLO EVERYONE NICE TO MEET YOU";
  const a = displayTopic(raw);
  const b = displayTopic(raw);
  assert.equal(a, b);
  assert.equal(raw, "HELLO EVERYONE NICE TO MEET YOU", "input string untouched");
});
