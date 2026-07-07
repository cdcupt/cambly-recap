// tests/render-index.test.js — U-RN edges on the index page (Q2 U-RN ②⑥⑫)
// plus derived totals, reverse-chron ordering, and the banner on the index too.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderIndex } from "../src/render/index.js";
import {
  goldenWeek,
  emptyWeek,
  weekWith,
  staleSiteState,
  healthySiteState,
} from "./render-fixtures.js";

test("renderIndex: reverse-chron rows, derived totals summed across weeks", () => {
  const weeks = [
    weekWith("2026-05-11", "May 11 – 17, 2026", 3),
    weekWith("2026-05-18", "May 18 – 24, 2026", 5),
    goldenWeek(), // 2026-05-25, stats.corrections = renderedGrammar = 2
  ];
  const html = renderIndex(weeks, { siteState: healthySiteState() });

  // newest first
  const a = html.indexOf("Week of May 25");
  const b = html.indexOf("Week of May 18");
  const c = html.indexOf("Week of May 11");
  assert.ok(a < b && b < c, "rows in reverse-chron order");
  // totals: 3 weeks · (1+1+2)=4 classes · (60+60+90)=210 min · (3+5+2)=10 corrections
  assert.match(html, /<i>3 weeks<\/i><i>4 classes<\/i><i>210 min<\/i><i>10 corrections<\/i>/);
});

test("U-RN-② empty week is a non-clickable <span>, muted, and links to no page", () => {
  const html = renderIndex([goldenWeek(), emptyWeek()], { siteState: healthySiteState() });
  assert.match(
    html,
    /<li class="empty"><span class="wrow"><span class="wl"><b>Week of Jun 8 – 14, 2026 — no classes this week<\/b><\/span><\/span><\/li>/,
  );
  assert.ok(!html.includes('href="weeks/2026-06-08.html"'), "empty week has no page link");
});

test("U-RN-⑥ ● NEW badge lands on the latest non-empty week only", () => {
  // newest week is empty → badge must move back to the newest non-empty
  const weeks = [goldenWeek(), emptyWeek("2026-06-08", "Jun 8 – 14, 2026")];
  const html = renderIndex(weeks, { siteState: healthySiteState() });
  assert.equal((html.match(/class="new"/g) || []).length, 1, "exactly one NEW badge");
  // it belongs to the non-empty May 25 row, not the empty Jun 8 row
  assert.match(html, /Week of May 25 – 31, 2026<span class="new">NEW<\/span>/);
  assert.ok(!/Jun 8 – 14[^<]*<span class="new">/.test(html), "empty newest week has no NEW");
});

test("U-RN-⑫ exactly one published week → first-run intro renders (never an empty shell)", () => {
  const one = renderIndex([goldenWeek(), emptyWeek()], { siteState: healthySiteState() });
  assert.ok(one.includes('class="firstrun'), "intro present with a single non-empty week");

  const many = renderIndex(
    [goldenWeek(), weekWith("2026-05-18", "May 18 – 24, 2026", 2)],
    { siteState: healthySiteState() },
  );
  assert.ok(!many.includes('class="firstrun'), "no intro once two weeks exist");
});

test("renderIndex: latest non-empty row gets li.latest + accent border class", () => {
  const html = renderIndex(
    [goldenWeek(), weekWith("2026-05-18", "May 18 – 24, 2026", 2)],
    { siteState: healthySiteState() },
  );
  assert.match(html, /<li class="latest"><a class="wrow" href="weeks\/2026-05-25.html">/);
});

test("renderIndex: stale banner appears on the index with role=alert + both commands", () => {
  const html = renderIndex([goldenWeek()], { siteState: staleSiteState() });
  assert.ok(html.includes('role="alert"'), "banner on index");
  assert.ok(html.includes("<code>Re-harvest your Cambly session in a browser and save cambly-state.json (see the README).</code>"));
  assert.ok(html.includes("<code>Copy cambly-state.json to the server, then re-run the generator.</code>"));
});

test("renderIndex: healthy state emits zero banner markup", () => {
  const html = renderIndex([goldenWeek()], { siteState: healthySiteState() });
  assert.ok(!html.includes('role="alert"'));
  assert.ok(!html.includes('class="banner"'));
});

test("renderIndex: body carries the ix modifier and a single h1", () => {
  const html = renderIndex([goldenWeek()], {});
  assert.ok(html.includes('<body class="mk ix">'));
  assert.equal((html.match(/<h1>/g) || []).length, 1);
});

test("clean-week framing: a 0-fix week reads 'Clean week ✓'; a fixed week keeps 'N fixes'", () => {
  const clean = weekWith("2026-05-11", "May 11 – 17, 2026", 0); // stats.corrections = 0
  const fixed = weekWith("2026-05-18", "May 18 – 24, 2026", 5); // stats.corrections = 5
  const html = renderIndex([clean, fixed], { siteState: healthySiteState() });
  assert.match(html, /<span class="wc">Clean week ✓<\/span>/, "0-fix week reframed to a clean-week label");
  assert.match(html, /<span class="wc">5 fixes<\/span>/, "non-zero week keeps the honest count");
  assert.ok(!html.includes(">0 fixes<"), "no '0 fixes' pill reads as scoring zero of a good thing");
});

test("index subtitle is a non-committal cadence, with no publish day/time to contradict the week stamp", () => {
  const html = renderIndex([goldenWeek()], { siteState: healthySiteState() });
  assert.match(html, /<p class="sub">Refreshed after each week of classes\.<\/p>/);
  assert.ok(!/Monday 07:30|Auto-published/.test(html), "no committed publish day/time in the subtitle");
});
