// tests/mail.test.js — I-ML: mailer dry-run + Resend send (TECH §3 mailer, §7, I-ML).
//
// renderEmail is pure (the "dry-run") so all four templates are asserted with no
// network. sendEmail is exercised through the real RESEND_BASE_URL env seam against
// a node:http mock on 127.0.0.1 — no network, backoff injected as 0 ms.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  renderEmail,
  sendEmail,
  RECOVERY_COMMANDS,
  OUTCOME,
} from "../src/mail.js";

const FAST = { sleep: async () => {}, backoff: [0, 0, 0], retries: 3 };

function publishedCtx(over = {}) {
  return {
    weekId: "2026-05-25",
    weekLabel: "May 25 – 31",
    stats: { classes: 3, minutes: 90, corrections: 28, expressions: 9 },
    weekUrl: "https://example.com/weeks/2026-05-25.html",
    indexUrl: "https://example.com/",
    backfilledCount: 0,
    degraded: [],
    ...over,
  };
}

// ── I-ML-① published ──────────────────────────────────────────────────────────────
test("I-ML① published email: stat line, deep link, no extra lines when clean", () => {
  const { subject, text } = renderEmail(OUTCOME.PUBLISHED, publishedCtx());
  assert.equal(subject, "📗 Cambly recap: Week of May 25 – 31 — 3 classes, 28 corrections");
  assert.match(text, /3 classes · 90 minutes · 28 corrections · 9 expressions/);
  assert.match(text, /https:\/\/example\.com\/weeks\/2026-05-25\.html/);
  assert.doesNotMatch(text, /backfilled/);
  assert.doesNotMatch(text, /Partial data/);
});

test("I-ML① published email: backfilled + partial-data lines appear when applicable", () => {
  const { text } = renderEmail(
    OUTCOME.PUBLISHED,
    publishedCtx({ backfilledCount: 2, degraded: ["user_lesson_stats"] }),
  );
  assert.match(text, /Also backfilled: 2 missed weeks\./);
  assert.match(text, /Partial data: user_lesson_stats degraded/);
});

test("published subject singularizes one class / one correction", () => {
  const { subject } = renderEmail(
    OUTCOME.PUBLISHED,
    publishedCtx({ stats: { classes: 1, minutes: 30, corrections: 1, expressions: 0 } }),
  );
  assert.equal(subject, "📗 Cambly recap: Week of May 25 – 31 — 1 class, 1 correction");
});

// ── I-ML-② no-classes ─────────────────────────────────────────────────────────────
test("I-ML② no-classes email: explicit empty note + index link", () => {
  const { subject, text } = renderEmail(OUTCOME.NO_CLASSES, publishedCtx({ weekLabel: "Jun 8 – 14" }));
  assert.equal(subject, "📭 No Cambly classes last week");
  assert.match(text, /No Cambly classes were found for the week of Jun 8 – 14\./);
  assert.match(text, /https:\/\/example\.com\//);
});

// ── I-ML-③ auth-expired — email copy = banner constant, byte-equal ────────────────
test("I-ML③ auth-expired email carries BOTH recovery commands byte-equal to the banner constant", () => {
  const { subject, text } = renderEmail(OUTCOME.AUTH_EXPIRED, { authStaleSince: "2026-07-06" });
  assert.equal(subject, "🔑 Cambly session expired — recap paused");
  // Byte-equality with the single source of truth the banner renders.
  assert.ok(text.includes(RECOVERY_COMMANDS[0]), "email must contain command ① verbatim");
  assert.ok(text.includes(RECOVERY_COMMANDS[1]), "email must contain command ② verbatim");
  assert.equal(RECOVERY_COMMANDS[0], "Re-harvest your Cambly session in a browser and save cambly-state.json (see the README).");
  assert.equal(RECOVERY_COMMANDS[1], "Copy cambly-state.json to the server, then re-run the generator.");
  assert.match(text, /expired \(2026-07-06\)/);
  assert.match(text, /archive stays readable/);
});

// ── I-ML-④ fetch-failed — stage + error + attempts ───────────────────────────────
test("I-ML④ fetch-failed email: stage, error class + message, attempt count", () => {
  const { subject, text } = renderEmail(OUTCOME.FETCH_FAILED, {
    stage: "summarize",
    errorName: "OpenAIError",
    errorMessage: "OpenAI HTTP 500",
    attempts: 3,
  });
  assert.equal(subject, "⚠️ Cambly recap failed (stage: summarize)");
  assert.match(text, /failed at the summarize stage after 3 attempts\./);
  assert.match(text, /Error: OpenAIError: OpenAI HTTP 500/);
  assert.match(text, /site is unchanged/);
});

test("renderEmail throws on an unknown outcome", () => {
  assert.throws(() => renderEmail("bogus", {}), /unknown outcome/);
});

// ── sendEmail against a mock Resend ───────────────────────────────────────────────
async function startResend(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const idx = requests.length;
      requests.push({ url: req.url, body: raw });
      const { status, body } = handler(idx, raw);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

test("sendEmail: 200 → ok:true with the returned id, exactly one request", async () => {
  const mock = await startResend(() => ({ status: 200, body: JSON.stringify({ id: "email-abc" }) }));
  try {
    const r = await sendEmail(OUTCOME.PUBLISHED, publishedCtx(), {
      base: mock.base,
      apiKey: "k",
      from: "a@b.co",
      to: "c@d.co",
      ...FAST,
    });
    assert.equal(r.ok, true);
    assert.equal(r.id, "email-abc");
    assert.equal(r.attempts, 1);
    assert.equal(mock.requests.length, 1);
    // The POST body carries the rendered subject/text/from/to.
    const sent = JSON.parse(mock.requests[0].body);
    assert.equal(sent.from, "a@b.co");
    assert.equal(sent.to, "c@d.co");
    assert.match(sent.subject, /📗 Cambly recap/);
  } finally {
    await mock.close();
  }
});

// ── I-ML-⑤ Resend 5xx ×3 → outcome stands, emailOk:false, never throws ───────────
test("I-ML⑤ Resend 5xx ×3 → ok:false after 3 attempts, no throw", async () => {
  const mock = await startResend(() => ({ status: 500, body: "{}" }));
  try {
    const r = await sendEmail(OUTCOME.AUTH_EXPIRED, { authStaleSince: "2026-07-06" }, {
      base: mock.base,
      apiKey: "k",
      from: "a@b.co",
      to: "c@d.co",
      ...FAST,
    });
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 3);
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});

test("sendEmail sends a stable Idempotency-Key held constant across retries (so a retried POST dedupes)", async () => {
  const keys = [];
  const server = http.createServer((req, res) => {
    keys.push(req.headers["idempotency-key"]);
    // 500, 500, then 200 → three POSTs, all carrying the same key.
    res.writeHead(keys.length < 3 ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "email-x" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await sendEmail(OUTCOME.PUBLISHED, publishedCtx(), { base, apiKey: "k", from: "a@b.co", to: "c@d.co", ...FAST });
    assert.equal(r.ok, true);
    assert.equal(keys.length, 3);
    assert.ok(keys[0], "an Idempotency-Key header is sent");
    assert.equal(keys[0], keys[1]); // same key across retries → Resend de-duplicates server-side
    assert.equal(keys[1], keys[2]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("sendEmail: transport error (no server) → ok:false, never throws", async () => {
  // Port 1 is unbound → connection refused on every attempt.
  const r = await sendEmail(OUTCOME.FETCH_FAILED, { stage: "fetch", errorName: "E", errorMessage: "m", attempts: 3 }, {
    base: "http://127.0.0.1:1",
    apiKey: "k",
    from: "a@b.co",
    to: "c@d.co",
    ...FAST,
  });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
});
