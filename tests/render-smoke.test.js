// tests/render-smoke.test.js — F5 interaction smoke on the EMITTED HTML, driven
// by Playwright (skipped on a bare clone where playwright is not installed).
// Proves the real tap-to-reveal mechanic, done-once counting, reveal-all, and the
// no-JS answer-sheet fallback against a rendered page — not a mock.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { renderWeek } from "../src/render/week.js";
import { goldenWeek } from "./render-fixtures.js";

let chromium = null;
try {
  // Resolve playwright from wherever it is installed (skips gracefully if absent).
  const req = createRequire(import.meta.url);
  ({ chromium } = req("playwright"));
} catch {
  chromium = null;
}
const guard = chromium ? {} : { skip: "playwright not available (bare clone)" };

function emitWeek() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-smoke-"));
  const file = path.join(dir, "week.html");
  fs.writeFileSync(file, renderWeek(goldenWeek()));
  return "file://" + file;
}

test("F5 tap-to-reveal: reveal counts up, re-hide RECOMPUTES down, reveal-all, un-reveal clears All-done", guard, async () => {
  if (!chromium) return;
  const url = emitWeek();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url);
    const first = page.locator(".pq").first();

    assert.equal(await first.getAttribute("aria-expanded"), "false");
    assert.ok(await page.locator("#pa1").evaluate((e) => e.hasAttribute("hidden")), "answer starts hidden");

    await first.click();
    assert.equal(await first.getAttribute("aria-expanded"), "true", "expands on tap");
    assert.ok(!(await page.locator("#pa1").evaluate((e) => e.hasAttribute("hidden"))), "answer revealed");
    assert.equal((await page.locator("#ptxt").textContent()).trim(), "1 of 2 revealed");
    assert.ok(await page.locator(".pcard").first().evaluate((e) => e.classList.contains("done")), "card marked done");

    // BETA FIX (1): re-hiding a revealed card DECREMENTS the counter (recompute, not ++)
    // and clears the card's done state — the "N of 8" progress reflects live reveal state.
    await first.click();
    assert.equal(await first.getAttribute("aria-expanded"), "false", "collapses on second tap");
    assert.ok(await page.locator("#pa1").evaluate((e) => e.hasAttribute("hidden")), "answer re-hidden");
    assert.equal((await page.locator("#ptxt").textContent()).trim(), "0 of 2 revealed", "counter recomputes down");
    assert.ok(!(await page.locator(".pcard").first().evaluate((e) => e.classList.contains("done"))), "done cleared on re-hide");

    // reveal all → progress lands at N of N with the sign-off copy
    await page.locator("#revealall").click();
    assert.match(await page.locator("#ptxt").textContent(), /All done/);
    assert.ok(
      await page.locator(".pa").evaluateAll((els) => els.every((e) => !e.hasAttribute("hidden"))),
      "every answer visible after reveal-all",
    );

    // BETA FIX (1): un-revealing one card after "All done" clears the sign-off and drops
    // the count back below N — the latched "All done" state no longer sticks.
    await first.click();
    assert.equal((await page.locator("#ptxt").textContent()).trim(), "1 of 2 revealed", "All done cleared on un-reveal");
  } finally {
    await browser.close();
  }
});

test("F5 no-JS fallback: the page reads as a clean answer sheet", guard, async () => {
  if (!chromium) return;
  const url = emitWeek();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(url);
    assert.equal(await page.locator("html").getAttribute("class"), "no-js", "stays no-js without JS");
    assert.ok(await page.locator("#pa1").isVisible(), "answers visible with JS off");
    assert.ok(!(await page.locator(".phint").first().isVisible()), "tap hint hidden");
    assert.ok(!(await page.locator(".prog").isVisible()), "progress row hidden");
  } finally {
    await browser.close();
  }
});

test("F6 responsive: no horizontal body scroll at 320 / 390 / 1440", guard, async () => {
  if (!chromium) return;
  const url = emitWeek();
  const browser = await chromium.launch();
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(url);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.ok(!overflow, `no horizontal overflow at ${width}px`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

// BETA FIX (2): a pathological unbroken token in every text-bearing container (coaching
// box, vocab quote + meaning, grammar said/fix/why, moment, topic) must NOT force
// horizontal scroll at 320 — the defensive overflow-wrap rules break it. This is the
// regression guard for the "scrollWidth 343 vs 320" overflow the beta panel caught.
function stressWeek() {
  const LONG = "supercalifragilisticexpialidocious".repeat(4); // 136 chars, no spaces
  const w = goldenWeek();
  w.classes[0] = {
    ...w.classes[0],
    topic: LONG,
    tutor: LONG, // a lone long tutor name renders into the header .mk .sub (finding 7)
    moment: { text: LONG, quotes: [] },
    tutorFocus: { aiFeedback: LONG, tutorNotes: LONG, tutorNotesZh: LONG, nextFocus: LONG },
  };
  w.vocabulary[0] = { ...w.vocabulary[0], term: LONG, meaning: LONG, quote: LONG };
  w.grammarGroups[0] = {
    ...w.grammarGroups[0],
    items: [{ ...w.grammarGroups[0].items[0], said: LONG, fix: LONG, why: LONG }, ...w.grammarGroups[0].items.slice(1)],
  };
  return w;
}

function emitStress() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-stress-"));
  const file = path.join(dir, "week.html");
  fs.writeFileSync(file, renderWeek(stressWeek()));
  return "file://" + file;
}

test("F6 defensive: a 136-char unbroken token in every field still never overflows at 320 / 390 / 1440", guard, async () => {
  if (!chromium) return;
  const url = emitStress();
  const browser = await chromium.launch();
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(url);
      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      assert.ok(scrollW <= clientW + 1, `no overflow at ${width}px (scrollWidth ${scrollW} vs clientWidth ${clientW})`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
