// tests/render-site.test.js — the renderer path end to end (Q2 U-RN ②⑤⑦⑩ +
// I-GR byte-stability + I-HZ ordering). buildSite reads data/, gates every week,
// renders into a staging dir, promotes it atomically, and writes healthz.json
// last. Temp dirs only — no repo or real-data writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSite } from "../src/render/site.js";
import { goldenWeek, emptyWeek, weekWith, staleSiteState, healthySiteState } from "./render-fixtures.js";

const NOW = Date.UTC(2026, 5, 1, 23, 30, 0); // Mon 07:30 CST

function scaffold(weeks, siteState) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-render-"));
  const dataDir = path.join(root, "data");
  const siteDir = path.join(root, "site");
  fs.mkdirSync(path.join(dataDir, "weeks"), { recursive: true });
  for (const w of weeks) {
    fs.writeFileSync(path.join(dataDir, "weeks", `${w.weekId}.json`), JSON.stringify(w));
  }
  if (siteState) {
    fs.writeFileSync(path.join(dataDir, "site-state.json"), JSON.stringify(siteState));
  }
  return { root, dataDir, siteDir };
}

test("buildSite: emits index + one page per non-empty week, healthz.json, no stray stage", () => {
  const { dataDir, siteDir } = scaffold([goldenWeek(), emptyWeek()], healthySiteState());
  const res = buildSite({ dataDir, siteDir, nowMs: NOW });

  assert.ok(fs.existsSync(path.join(siteDir, "index.html")), "index emitted");
  assert.ok(fs.existsSync(path.join(siteDir, "weeks", "2026-05-25.html")), "non-empty week page emitted");
  assert.ok(!fs.existsSync(path.join(siteDir, "weeks", "2026-06-08.html")), "empty week has no page");
  assert.ok(fs.existsSync(path.join(siteDir, "healthz.json")), "healthz emitted");
  assert.ok(!fs.existsSync(path.join(siteDir, ".stage")), "stage dir swept after swap");
  assert.deepEqual(res.weekPages, ["2026-05-25"]);
  assert.ok(res.indexBytes < 200 * 1024, "index within page budget");
});

test("buildSite: emits a static, personal-data-free not-found.html linking home (BETA FIX 4)", () => {
  const { dataDir, siteDir } = scaffold([goldenWeek()], staleSiteState());
  buildSite({ dataDir, siteDir, nowMs: NOW });

  const nf = path.join(siteDir, "not-found.html");
  assert.ok(fs.existsSync(nf), "not-found.html emitted at the site root");
  const html = fs.readFileSync(nf, "utf8");
  // self-contained shell like every other page
  assert.match(html, /^<!doctype html>/, "self-contained document");
  assert.ok(html.includes("Page not"), "on-brand not-found headline");
  // absolute root-relative link home (served for arbitrary request paths)
  assert.ok(html.includes('href="/index.html"'), "root-relative link back to the index");
  // ZERO personal content: no week data, and NOT even the stale-auth banner (auth-exempt page)
  assert.ok(!html.includes("Week of"), "no week content leaks onto the 404");
  assert.ok(!html.includes('role="alert"'), "no auth banner (no personal recovery commands) on the 404");
  // no external resources (favicon is an inline data-URI)
  assert.ok(!/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(html), "no external resource references");
});

test("U-RN-⑤ multi-week emit: three new week JSONs → three pages + three index rows in one pass", () => {
  const weeks = [
    weekWith("2026-05-11", "May 11 – 17, 2026", 2),
    weekWith("2026-05-18", "May 18 – 24, 2026", 3),
    goldenWeek(),
  ];
  const { dataDir, siteDir } = scaffold(weeks, healthySiteState());
  const res = buildSite({ dataDir, siteDir, nowMs: NOW });

  assert.deepEqual(res.weekPages.sort(), ["2026-05-11", "2026-05-18", "2026-05-25"]);
  for (const id of res.weekPages) {
    assert.ok(fs.existsSync(path.join(siteDir, "weeks", `${id}.html`)), `${id} page`);
  }
  const index = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");
  assert.equal((index.match(/class="wrow"/g) || []).length, 3, "three archive rows");
});

test("U-RN-⑦ footer prev/next skip empty weeks", () => {
  const weeks = [
    weekWith("2026-05-11", "May 11 – 17, 2026", 2),
    emptyWeek("2026-05-18", "May 18 – 24, 2026"),
    weekWith("2026-05-25", "May 25 – 31, 2026", 2),
  ];
  const { dataDir, siteDir } = scaffold(weeks, healthySiteState());
  buildSite({ dataDir, siteDir, nowMs: NOW });

  const older = fs.readFileSync(path.join(siteDir, "weeks", "2026-05-11.html"), "utf8");
  const newer = fs.readFileSync(path.join(siteDir, "weeks", "2026-05-25.html"), "utf8");
  // older week's "next" jumps over the empty 05-18 straight to 05-25
  assert.ok(older.includes('href="2026-05-25.html">Week of May 25 – 31, 2026 →'), "next skips empty");
  assert.ok(!older.includes('2026-05-18.html'), "no link to the empty week");
  // newest week's "prev" jumps back over the empty week to 05-11
  assert.ok(newer.includes('href="2026-05-11.html">← Week of May 11 – 17, 2026'), "prev skips empty");
});

test("I-GR byte-stable: two runs over the same data produce an identical tree", () => {
  const weeks = [goldenWeek(), emptyWeek(), weekWith("2026-05-18", "May 18 – 24, 2026", 2)];
  const first = scaffold(weeks, healthySiteState());
  buildSite({ dataDir: first.dataDir, siteDir: first.siteDir, nowMs: NOW });
  const snapA = snapshot(first.siteDir);

  // a second run on the same box
  buildSite({ dataDir: first.dataDir, siteDir: first.siteDir, nowMs: NOW });
  const snapB = snapshot(first.siteDir);

  assert.deepEqual(snapB, snapA, "re-render is idempotent + byte-stable");
});

test("U-RN-⑩ a doctored Σ aborts the run and leaves the previously published site intact", () => {
  const { dataDir, siteDir } = scaffold([goldenWeek()], healthySiteState());
  buildSite({ dataDir, siteDir, nowMs: NOW });
  const goodIndex = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");

  // corrupt the week file so the Σ re-assert fails, then re-run
  const doctored = goldenWeek({ stats: { classes: 2, minutes: 90, corrections: 99, expressions: 2 } });
  fs.writeFileSync(path.join(dataDir, "weeks", "2026-05-25.json"), JSON.stringify(doctored));

  assert.throws(() => buildSite({ dataDir, siteDir, nowMs: NOW }), /Σ mismatch/);
  assert.equal(fs.readFileSync(path.join(siteDir, "index.html"), "utf8"), goodIndex, "old site untouched");
  assert.ok(!fs.existsSync(path.join(siteDir, ".stage")), "no half-written stage left behind");
});

test("I-HZ healthz reflects a completed publish: ok:true + correct facts", () => {
  const weeks = [goldenWeek(), emptyWeek(), weekWith("2026-05-18", "May 18 – 24, 2026", 2)];
  const { dataDir, siteDir } = scaffold(weeks, healthySiteState());
  const res = buildSite({ dataDir, siteDir, nowMs: NOW });

  const hz = JSON.parse(fs.readFileSync(path.join(siteDir, "healthz.json"), "utf8"));
  assert.equal(hz.ok, true);
  assert.equal(hz.lastOutcome, "published");
  assert.equal(hz.weeksTotal, 3, "counts every week incl. empty");
  assert.equal(hz.latestWeekId, "2026-06-08", "newest week id (the empty stub)");
  assert.equal(hz.lessonsThisWeek, 0, "newest week is empty → zero lessons");
  assert.deepEqual(res.facts, {
    latestWeekId: "2026-06-08",
    weeksTotal: 3,
    lessonsThisWeek: 0,
    rejectedCount: 0,
  });
});

test("buildSite: a stale site-state paints the banner on every emitted page", () => {
  const { dataDir, siteDir } = scaffold([goldenWeek(), weekWith("2026-05-18", "May 18 – 24, 2026", 2)], staleSiteState());
  buildSite({ dataDir, siteDir, nowMs: NOW });
  for (const f of ["index.html", "weeks/2026-05-25.html", "weeks/2026-05-18.html"]) {
    const html = fs.readFileSync(path.join(siteDir, f), "utf8");
    assert.ok(html.includes('role="alert"'), `${f} carries the banner`);
  }
  const hz = JSON.parse(fs.readFileSync(path.join(siteDir, "healthz.json"), "utf8"));
  assert.equal(hz.ok, false, "auth-expired → red");
  assert.equal(hz.authStale, true);
});

// Deterministic tree snapshot (relative path → bytes) for the byte-stability check.
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else if (r !== "healthz.json") out[r] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return out;
}
