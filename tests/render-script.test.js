// tests/render-script.test.js — jsdom-free structural checks on the emitted reveal
// script (BETA FIX 1). The behavioral proof lives in render-smoke.test.js (a real
// browser toggles cards); this suite guards the SHAPE that makes re-hide recompute —
// so a regression to the latching `done++` counter fails even on a bare clone with no
// browser. Runs a static analysis of the REVEAL source string.

import { test } from "node:test";
import assert from "node:assert/strict";

import { REVEAL, BOOT } from "../src/render/script.js";
import { MAX_JS_BYTES } from "../src/render/validate.js";

test("REVEAL recomputes from revealed state — never a latching ++ counter", () => {
  assert.ok(!/\bdone\+\+/.test(REVEAL), "no `done++` increment-only counter");
  assert.ok(!/,done=0/.test(REVEAL), "no mutable `done` accumulator seeded to 0");
  // the count is derived from the cards currently expanded on every toggle
  assert.match(REVEAL, /aria-expanded'\)==='true'/, "derives count from aria-expanded='true'");
});

test("REVEAL toggles the card .done class BOTH ways (add on open, remove on hide)", () => {
  assert.match(REVEAL, /classList\.add\('done'\)/, "adds .done when revealed");
  assert.match(REVEAL, /classList\.remove\('done'\)/, "removes .done when re-hidden");
});

test("REVEAL calls update() on every toggle (both branches), keeping reveal-all + aria-live", () => {
  // update() is invoked unconditionally after the open/close branch, not only on first reveal
  assert.match(REVEAL, /card\.classList\.remove\('done'\);\}\s*update\(\);/, "update() runs after re-hide too");
  assert.match(REVEAL, /getElementById\('revealall'\)/, "reveal-all wiring intact");
  assert.match(REVEAL, /getElementById\('ptxt'\)/, "aria-live progress text wiring intact");
});

test("REVEAL + BOOT stay within the inline-JS budget", () => {
  assert.ok(Buffer.byteLength(REVEAL, "utf8") < MAX_JS_BYTES, "reveal script under 2 KB");
  assert.ok(Buffer.byteLength(BOOT, "utf8") < MAX_JS_BYTES, "boot line under 2 KB");
});
