// src/mail.js — mailer (TECH §3 "mailer", §7 failure matrix, I-ML).
//
// One email per run, every outcome (PRD §4: silent failure is a bug). Sent to the
// Resend HTTPS API from inside the container (sending from inside the container
// avoids host-level egress restrictions). The api.resend.com host is an env seam
// (RESEND_BASE_URL) so tests point it at a mock.
//
// Node 22 native fetch, zero npm dependencies. renderEmail() is a pure function —
// the mailer "dry-run" (I-ML) simply renders all four templates without sending.

import crypto from "node:crypto";

/** Production defaults for the env seams; read at call time so tests can inject. */
export function resendBase() {
  return process.env.RESEND_BASE_URL || "https://api.resend.com";
}
export function resendKey() {
  return process.env.RESEND_API_KEY || "";
}
/** Resend "From" address, e.g. "Cambly Recap <recap@your-domain.example.com>". */
export function mailFrom() {
  return process.env.MAIL_FROM || "";
}
export function mailTo() {
  return process.env.MAIL_TO || "";
}
/** Public site base for deep links (set SITE_URL to your host; no trailing slash). */
export function siteUrl() {
  return (process.env.SITE_URL || "https://example.com").replace(/\/$/, "");
}

export const DEFAULT_BACKOFF_MS = [2000, 8000, 30000];
export const DEFAULT_RETRIES = 3;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The four PRD outcomes — the single vocabulary shared by run.js, mail.js and healthz. */
export const OUTCOME = Object.freeze({
  PUBLISHED: "published",
  NO_CLASSES: "no-classes",
  AUTH_EXPIRED: "auth-expired",
  FETCH_FAILED: "fetch-failed",
});

/**
 * The two recovery steps — the single source of truth (TECH §3 run wrapper). run.js
 * copies this array verbatim into site-state.recoveryCommands (the banner renders it)
 * AND the auth-expired email body renders it, so the alert copy and the on-page banner
 * copy can never drift (S5 · I-ML-③).
 */
export const RECOVERY_COMMANDS = Object.freeze([
  "Re-harvest your Cambly session in a browser and save cambly-state.json (see the README).",
  "Copy cambly-state.json to the server, then re-run the generator.",
]);

// ── small HTML escaper for the html part (the text part is sent verbatim) ────────
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function textToHtml(lines) {
  return lines.map((l) => `<p>${esc(l)}</p>`).join("\n");
}

// ── the four outcome templates ───────────────────────────────────────────────────

/** The week's CEFR band when the run passed one (`ctx.level = vm.level`), else null. */
function levelBand(ctx) {
  const l = ctx && ctx.level;
  return l && typeof l.overall === "string" && l.overall.trim() ? l : null;
}

function publishedEmail(ctx) {
  const s = ctx.stats || {};
  const level = levelBand(ctx);
  const subject =
    `📗 Cambly recap: Week of ${ctx.weekLabel} — ` +
    `${plural(s.classes ?? 0, "class", "classes")}, ${plural(s.corrections ?? 0, "correction", "corrections")}` +
    (level ? ` · level ${level.overall}` : "");
  const lines = [
    `Your Cambly recap for the week of ${ctx.weekLabel} is ready.`,
    `${s.classes ?? 0} classes · ${s.minutes ?? 0} minutes · ${s.corrections ?? 0} corrections · ${s.expressions ?? 0} expressions`,
  ];
  if (level) {
    const conf = typeof level.confidence === "string" && level.confidence ? ` (${level.confidence} confidence)` : "";
    lines.push(`Estimated level this week: ${level.overall}${conf}`);
  }
  lines.push(`Read it: ${ctx.weekUrl}`);
  if ((ctx.backfilledCount ?? 0) > 0) {
    lines.push(`Also backfilled: ${plural(ctx.backfilledCount, "missed week", "missed weeks")}.`);
  }
  if (Array.isArray(ctx.degraded) && ctx.degraded.length) {
    lines.push(`Partial data: ${ctx.degraded.join(", ")} degraded — some sections may be short.`);
  }
  return { subject, lines };
}

function noClassesEmail(ctx) {
  return {
    subject: "📭 No Cambly classes last week",
    lines: [
      `No Cambly classes were found for the week of ${ctx.weekLabel}.`,
      "The week is logged as empty and your archive is unchanged — never silent.",
      `See every week: ${ctx.indexUrl}`,
    ],
  };
}

function authExpiredEmail(ctx) {
  const since = ctx.authStaleSince ? ` (${ctx.authStaleSince})` : "";
  return {
    subject: "🔑 Cambly session expired — recap paused",
    // RECOVERY_COMMANDS rendered verbatim, each on its own line (byte-equal to the
    // banner constant — I-ML-③ asserts this).
    lines: [
      `Your Cambly session expired${since}, so this week's recap is paused.`,
      "Fix it in two steps:",
      RECOVERY_COMMANDS[0],
      RECOVERY_COMMANDS[1],
      "The archive stays readable; missed weeks backfill automatically on the next run.",
    ],
  };
}

function fetchFailedEmail(ctx) {
  const attempts = ctx.attempts != null ? ` after ${plural(ctx.attempts, "attempt", "attempts")}` : "";
  return {
    subject: `⚠️ Cambly recap failed (stage: ${ctx.stage})`,
    lines: [
      `The Cambly recap run failed at the ${ctx.stage} stage${attempts}.`,
      `Error: ${ctx.errorName}: ${ctx.errorMessage}`,
      "The site is unchanged; the next run backfills this week.",
    ],
  };
}

const TEMPLATES = {
  [OUTCOME.PUBLISHED]: publishedEmail,
  [OUTCOME.NO_CLASSES]: noClassesEmail,
  [OUTCOME.AUTH_EXPIRED]: authExpiredEmail,
  [OUTCOME.FETCH_FAILED]: fetchFailedEmail,
};

/**
 * Render (but do not send) the email for an outcome. Pure function — the mailer
 * dry-run (I-ML) calls this directly and asserts subject/body content.
 *
 * @param {string} outcome one of OUTCOME.*
 * @param {object} ctx     outcome-specific fields (see run.js mailCtx)
 * @returns {{subject:string, text:string, html:string}}
 */
export function renderEmail(outcome, ctx = {}) {
  const template = TEMPLATES[outcome];
  if (!template) throw new Error(`mail: unknown outcome "${outcome}"`);
  const { subject, lines } = template(ctx);
  return { subject, text: lines.join("\n") + "\n", html: textToHtml(lines) };
}

/**
 * Send the outcome email through the Resend API. Retry ×3 (transport error or any
 * non-2xx). NEVER throws — an email failure must not roll back a publish; the caller
 * flips healthz.emailOk:false so Gatus goes red instead (§7).
 *
 * @returns {Promise<{ok:boolean, status:number, id:string|null, attempts:number, error?:string}>}
 */
export async function sendEmail(outcome, ctx = {}, opts = {}) {
  const {
    base = resendBase(),
    apiKey = resendKey(),
    from = mailFrom(),
    to = mailTo(),
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    backoff = DEFAULT_BACKOFF_MS,
    retries = DEFAULT_RETRIES,
  } = opts;

  const { subject, text, html } = renderEmail(outcome, ctx);
  const url = `${base.replace(/\/$/, "")}/emails`;
  const body = JSON.stringify({ from, to, subject, text, html });
  // One idempotency key per logical send, constant across this call's ≤3 retry
  // attempts: a Resend 5xx-after-enqueue or a dropped 2xx response is re-POSTed with
  // the SAME key, so Resend de-duplicates server-side instead of sending a second
  // notification (keeps the "one email per run" contract, §7). Derived from the
  // rendered content so it is deterministic (not per-process-random).
  const idempotencyKey = crypto
    .createHash("sha256")
    .update(`${outcome}\n${to}\n${subject}\n${text}`)
    .digest("hex");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Idempotency-Key": idempotencyKey,
  };
  const backoffFor = (attempt) => backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { method: "POST", headers, body });
      const raw = await res.text();
      if (res.status >= 200 && res.status < 300) {
        let id = null;
        try {
          id = JSON.parse(raw).id ?? null;
        } catch {
          /* a 2xx with a non-JSON body still counts as sent */
        }
        return { ok: true, status: res.status, id, attempts: attempt };
      }
      lastError = new Error(`Resend HTTP ${res.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < retries) await sleep(backoffFor(attempt));
  }
  return { ok: false, status: 0, id: null, attempts: retries, error: lastError && lastError.message };
}
