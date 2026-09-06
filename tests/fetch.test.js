// tests/fetch.test.js — U-AX: auth-expiry detection + fetcher isolation/retry (TECH §3, Q2 U-AX ①–⑦).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isAuthExpired,
  fetchEndpoint,
  fetchLesson,
  fetchListing,
  paginateListing,
  buildCookieHeader,
  resolveUserAgent,
  authHeaders,
  isLessonRawComplete,
  listCompleteRawLessons,
  AuthExpiredError,
  FetchFailedError,
  FALLBACK_UA,
} from "../src/fetch.js";
import { weekIdOf } from "../src/week.js";

const noSleep = async () => {};
const FAST = { sleep: noSleep, backoff: [0, 0, 0] };

/** A fake Response with the two members fetchEndpoint reads. */
function res(status, body) {
  return { status, text: async () => body };
}

/** A fetch stub that records calls and returns a scripted sequence or a constant. */
function fakeFetch(scriptOrFn) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof scriptOrFn === "function") return scriptOrFn(url, i++, init);
    const r = scriptOrFn[Math.min(i, scriptOrFn.length - 1)];
    i++;
    return r;
  };
  fn.calls = calls;
  return fn;
}

// ── U-AX: the normative predicate ───────────────────────────────────────────

test("U-AX① 401 → auth-expired", () => {
  assert.equal(isAuthExpired(401, '{"ok":true}'), true);
});
test("U-AX② 403 → auth-expired", () => {
  assert.equal(isAuthExpired(403, "{}"), true);
});
test("U-AX③ 200 with body starting '<' (login HTML) → auth-expired", () => {
  assert.equal(isAuthExpired(200, "<!DOCTYPE html><html>login</html>"), true);
});
test("U-AX④ leading-whitespace HTML is still caught (trim)", () => {
  assert.equal(isAuthExpired(200, "  \n\t <html></html>"), true);
});
test("U-AX⑤ 200 with valid JSON passes", () => {
  assert.equal(isAuthExpired(200, '{"result":[]}'), false);
});
test("U-AX⑥ other error statuses with non-HTML body are NOT auth-expired", () => {
  assert.equal(isAuthExpired(500, "{}"), false);
  assert.equal(isAuthExpired(404, ""), false);
  assert.equal(isAuthExpired(429, '{"error":"rate"}'), false);
});
test("U-AX⑥b a 5xx served as an HTML error/challenge page is transient, NOT auth-expired", () => {
  assert.equal(isAuthExpired(503, "<html><body>Bad Gateway</body></html>"), false);
  assert.equal(isAuthExpired(502, "  <!DOCTYPE html><title>maintenance</title>"), false);
  assert.equal(isAuthExpired(500, "<html>error</html>"), false);
});

// ── fetchEndpoint: auth expiry is immediate & non-transient ──────────────────

test("fetchEndpoint throws AuthExpiredError immediately on 401 (no retry)", async () => {
  const fetchImpl = fakeFetch([res(401, "nope")]);
  await assert.rejects(
    () => fetchEndpoint("http://x/api", { fetchImpl, ...FAST, label: "e" }),
    (e) => e instanceof AuthExpiredError && e.authExpired === true,
  );
  assert.equal(fetchImpl.calls.length, 1, "auth expiry is not retried");
});

test("fetchEndpoint treats mid-run HTML as auth-expired", async () => {
  const fetchImpl = fakeFetch([res(200, "<html>login</html>")]);
  await assert.rejects(
    () => fetchEndpoint("http://x/api", { fetchImpl, ...FAST }),
    AuthExpiredError,
  );
});

// ── fetchEndpoint: transient handling ────────────────────────────────────────

test("fetchEndpoint retries a transient 500 three times then returns a __status stub (non-fatal)", async () => {
  const fetchImpl = fakeFetch([res(500, "{}")]);
  const r = await fetchEndpoint("http://x/api", { fetchImpl, ...FAST, fatal: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { __status: 500 });
  assert.equal(fetchImpl.calls.length, 3);
});

test("a 5xx HTML error page is retried (not treated as auth-expiry) then stubbed (non-fatal)", async () => {
  const fetchImpl = fakeFetch([res(503, "<html>gateway</html>")]);
  const r = await fetchEndpoint("http://x/api", { fetchImpl, ...FAST, fatal: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { __status: 503 });
  assert.equal(fetchImpl.calls.length, 3, "retried, not aborted as auth-expiry");
});

test("fetchEndpoint on a fatal endpoint throws FetchFailedError after 3 tries", async () => {
  const fetchImpl = fakeFetch([res(503, "{}")]);
  await assert.rejects(
    () => fetchEndpoint("http://x/api", { fetchImpl, ...FAST, fatal: true }),
    (e) => e instanceof FetchFailedError && e.status === 503,
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test("fetchEndpoint retries a network error then stubs (non-fatal)", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("ECONNRESET");
  });
  const r = await fetchEndpoint("http://x/api", { fetchImpl, ...FAST, fatal: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { __status: 0 });
  assert.equal(fetchImpl.calls.length, 3);
});

test("fetchEndpoint recovers on a retry (500 then 200)", async () => {
  const fetchImpl = fakeFetch([res(500, "{}"), res(200, '{"result":[1,2]}')]);
  const r = await fetchEndpoint("http://x/api", { fetchImpl, ...FAST });
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { result: [1, 2] });
  assert.equal(fetchImpl.calls.length, 2);
});

test("fetchEndpoint returns parsed JSON on 200", async () => {
  const fetchImpl = fakeFetch([res(200, '{"a":1}')]);
  const r = await fetchEndpoint("http://x/api", { fetchImpl, ...FAST });
  assert.deepEqual(r.json, { a: 1 });
  assert.equal(r.body, '{"a":1}');
});

// ── Cookie / UA assembly ─────────────────────────────────────────────────────

test("buildCookieHeader includes only cambly.com cookies", () => {
  const state = {
    cookies: [
      { name: "session", value: "S", domain: "www.cambly.com" },
      { name: "cf_clearance", value: "C", domain: ".cambly.com" },
      { name: "csrfToken", value: "T", domain: "cambly.com" },
      { name: "ga", value: "X", domain: ".google.com" },
    ],
  };
  const header = buildCookieHeader(state);
  assert.equal(header, "session=S; cf_clearance=C; csrfToken=T");
  assert.ok(!header.includes("ga="));
});

test("buildCookieHeader tolerates a missing/empty cookies array", () => {
  assert.equal(buildCookieHeader({}), "");
  assert.equal(buildCookieHeader(null), "");
});

test("resolveUserAgent uses the state _ua when present", () => {
  const ua = "Mozilla/5.0 (EarnedBrowser) Chrome/999";
  assert.equal(resolveUserAgent({ _ua: ua }), ua);
});

test("resolveUserAgent falls back to the pinned UA and warns when _ua is absent", () => {
  let warned = "";
  const ua = resolveUserAgent({}, { warn: (m) => (warned = m) });
  assert.equal(ua, FALLBACK_UA);
  assert.match(warned, /_ua/);
});

test("authHeaders composes Cookie + User-Agent", () => {
  const h = authHeaders({ cookies: [{ name: "session", value: "S", domain: "cambly.com" }], _ua: "UA/1" });
  assert.equal(h.Cookie, "session=S");
  assert.equal(h["User-Agent"], "UA/1");
});

// ── fetchLesson: per-endpoint isolation & degradation ────────────────────────

test("fetchLesson isolates a dead non-listing endpoint into a stub + degraded list", async () => {
  // corrective_feedback_corrections always 500; everything else 200.
  const fetchImpl = fakeFetch((url) =>
    url.includes("corrective_feedback_corrections") ? res(500, "{}") : res(200, '{"result":[]}'),
  );
  const { files, degraded } = await fetchLesson("lid1", {
    base: "http://mock",
    uid: "u",
    ...FAST,
    fetchImpl,
  });
  assert.deepEqual(degraded, ["corrective_feedback_corrections"]);
  assert.deepEqual(files.corrective_feedback_corrections, { __status: 500 });
  assert.deepEqual(files.lesson_transcript, { result: [] });
});

test("U-AX⑦ HTML on a per-lesson endpoint mid-run aborts the whole lesson fetch", async () => {
  const fetchImpl = fakeFetch(() => res(200, "<html>login</html>"));
  await assert.rejects(
    () => fetchLesson("lid1", { base: "http://mock", uid: "u", ...FAST, fetchImpl }),
    AuthExpiredError,
  );
});

// ── fetchListing / paginateListing ───────────────────────────────────────────

test("fetchListing keeps only done lessons and is fatal on failure", async () => {
  const fetchImpl = fakeFetch([
    res(200, JSON.stringify({ result: [{ id: "a", state: "done" }, { id: "b", state: "canceled" }] })),
  ]);
  const lessons = await fetchListing({ base: "http://mock", uid: "u", ...FAST, fetchImpl });
  assert.deepEqual(lessons.map((l) => l.id), ["a"]);
});

test("fetchListing throws (fatal) when the listing endpoint stays down", async () => {
  const fetchImpl = fakeFetch([res(500, "{}")]);
  await assert.rejects(
    () => fetchListing({ base: "http://mock", uid: "u", ...FAST, fetchImpl }),
    FetchFailedError,
  );
});

test("paginateListing walks maxScheduledStartAt back to the first-week floor", async () => {
  const floor = 1000;
  const pages = [
    [{ id: "p3", state: "done", scheduledStartAt: { $date: 3000 } }],
    [{ id: "p2", state: "done", scheduledStartAt: { $date: 2000 } }],
    [{ id: "p1", state: "done", scheduledStartAt: { $date: 900 } }], // below floor → excluded
  ];
  let page = 0;
  const fetchImpl = fakeFetch(() => res(200, JSON.stringify({ result: pages[Math.min(page++, pages.length - 1)] })));
  const lessons = await paginateListing({
    base: "http://mock",
    uid: "u",
    now: 4000,
    firstWeekStartMs: floor,
    ...FAST,
    fetchImpl,
  });
  const ids = lessons.map((l) => l.id).sort();
  assert.deepEqual(ids, ["p2", "p3"]);
});

// ── Idempotence at the fetch level ───────────────────────────────────────────

test("isLessonRawComplete is true only with a transcript and no __status stubs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cambly-raw-"));
  try {
    // No transcript yet → incomplete
    assert.equal(isLessonRawComplete(dir), false);

    fs.writeFileSync(path.join(dir, "lesson_transcript.json"), JSON.stringify({ transcript: [] }));
    fs.writeFileSync(path.join(dir, "user_lesson_stats.json"), JSON.stringify({ result: [] }));
    assert.equal(isLessonRawComplete(dir), true);

    // A stub anywhere marks it incomplete (must be re-fetched)
    fs.writeFileSync(path.join(dir, "talon_chats.json"), JSON.stringify({ __status: 500 }));
    assert.equal(isLessonRawComplete(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Offline inventory (--rebuild) ────────────────────────────────────────────

test("listCompleteRawLessons lists only complete, dated raw dirs with their CST weekId", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cambly-rawlist-"));
  const mk = (lid, files) => {
    const dir = path.join(dataDir, "raw", lid);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(body));
  };
  const START = 1778639400000; // Wed 2026-05-13 10:30 CST → week 2026-05-11
  try {
    // Arrange
    mk("L-ok", { "_lesson.json": { id: "L-ok", scheduledStartAt: { $date: START } }, "lesson_transcript.json": { transcript: [] } });
    mk("L-stub", { "_lesson.json": { id: "L-stub", scheduledStartAt: { $date: START } }, "lesson_transcript.json": { transcript: [] }, "talon_chats.json": { __status: 500 } });
    mk("L-undated", { "_lesson.json": { id: "L-undated" }, "lesson_transcript.json": { transcript: [] } });
    mk("L-nolisting", { "lesson_transcript.json": { transcript: [] } });
    mk("L-notranscript", { "_lesson.json": { id: "L-notranscript", scheduledStartAt: { $date: START } } });
    fs.writeFileSync(path.join(dataDir, "raw", ".DS_Store"), "junk");

    // Act
    const out = listCompleteRawLessons(dataDir);

    // Assert
    assert.deepEqual(out, [{ lessonId: "L-ok", dir: path.join(dataDir, "raw", "L-ok"), startMs: START, weekId: weekIdOf(START) }]);
    assert.equal(out[0].weekId, "2026-05-11");
    assert.deepEqual(listCompleteRawLessons(path.join(dataDir, "nowhere")), [], "a missing raw dir is an empty inventory");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
