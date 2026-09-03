// src/compose.js — WeekVM block composition helpers (TECH §10 who-fills-what).
//
// Pure text/shape composition split out of src/build.js so the builder keeps only the
// two integrity gates, the Σ placement and the VM assembly. Nothing here consults the
// quote-guard or the Σ set directly — the review guard is INJECTED by the builder — and
// nothing here has side effects:
//
//   humanizePattern      — a grammar-habit heading from the summarizer's label
//   tutorFocusOf (+ dedupeFocusSignoff) — classes[].tutorFocus from Cambly's own coaching text
//   composeReview / composeLevel / composePlan — the optional v2 blocks (RULES 9–11)
//   nextWeekLabel        — the plan's builder-derived week label
//
// Every function is a pure function of its inputs. Rejections are reported through the
// builder's `logReject` so they land in build.rejects like every other drop.

import { weekWindow, weekIdToStartMs, MS_DAY } from "./week.js";
import { normalizeQuote } from "./quote.js";
import {
  stripWorksheet,
  coachNotes,
  BANDS,
  LEVEL_DIMENSIONS,
  CONFIDENCE_LEVELS,
  PLAN_DAYS,
  LEVEL_ADVICE_MAX,
  bandIndexOf,
} from "./coach.js";

/** True for a non-empty, non-whitespace string (shared with the builder). */
export const hasStr = (v) => typeof v === "string" && v.trim() !== "";

const arr = (v) => (Array.isArray(v) ? v : []);

// ── grammar heading ──────────────────────────────────────────────────────────────

const PATTERN_FALLBACK = "Other fixes";

/**
 * A human-readable grammar-habit heading (beta finding 3). A good pattern passes through
 * UNCHANGED ("Past tense", "Subject-verb agreement", "must/try forms"). The degenerate
 * labels the summarizer sometimes emits are repaired: a punctuation-only / empty label
 * ("." , "") → the fallback; a slash-wrapped, hyphen/underscore-slug, or camelCase label
 * ("/tense-with-past-time/", "PAST-TENSE-ERRORS", "pastTense", "past-Tense") → slashes
 * become " & " concept separators, camelCase humps and slug separators become spaces, the
 * result is lower-cased and its first letter capitalized. Case-insensitive so ALL-CAPS and
 * mixed-case slugs normalize too (finding 6). Never returns "." or an empty heading.
 */
export function humanizePattern(pattern) {
  const raw = (typeof pattern === "string" ? pattern : "").trim();
  if (raw.replace(/[^\p{L}\p{N}]/gu, "") === "") return PATTERN_FALLBACK;
  const wrapped = raw.startsWith("/") || raw.endsWith("/");
  const hyphenSlug = /^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+$/u.test(raw);
  const camelCase = /^\p{Ll}[\p{L}\p{N}]*\p{Lu}[\p{L}\p{N}]*$/u.test(raw);
  if (!wrapped && !hyphenSlug && !camelCase) return pattern; // already human — leave verbatim
  const out = raw
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" & ")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2") // split camelCase humps
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (out === "") return PATTERN_FALLBACK;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// ── classes[].tutorFocus ─────────────────────────────────────────────────────────

/**
 * finalAIFeedback → the coach-summary prose string, verbatim. Recent lessons carry an
 * object of prose sections (whatYouDidWell / whatWeCanWorkOn / ideasForPractice); the
 * summary section surfaced as the coach summary is `whatYouDidWell`. Older shapes may
 * carry a plain string. Anything with no usable summary prose → null. We deliberately do
 * NOT fall back to an arbitrary Object.values() section: a criticism-oriented section
 * (e.g. whatWeCanWorkOn) surfaced under the positive coach-summary slot is a semantic
 * mismatch, so only the summary-style key is allowed. A returned value is always a
 * verbatim slice of Cambly's own text (never synthesized), so it is not quote-guarded.
 */
const AI_FEEDBACK_SUMMARY_KEYS = ["whatYouDidWell"];

function aiFeedbackProse(v) {
  if (typeof v === "string") return v.trim() ? v : null;
  if (v && typeof v === "object") {
    for (const key of AI_FEEDBACK_SUMMARY_KEYS) {
      if (typeof v[key] === "string" && v[key].trim()) return v[key];
    }
  }
  return null;
}

/** Normalize a line for sign-off duplicate detection: letters/digits/space, lower-case. */
function signoffKey(s) {
  return normalizeQuote(typeof s === "string" ? s : "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SIGNOFF_MIN = 12; // avoid stripping a short line that is only incidentally a substring

/**
 * Show the tutor's closing line ONCE (beta finding 2). The class card already surfaces the
 * moment/highlight and the tutor note; when a coaching line in the Focus box repeats that
 * same sign-off it is stripped from the Focus box (the class highlight stays authoritative).
 * Comparison is punctuation/emoji-insensitive containment with a min-length guard so a short
 * genuine line is never removed. Returns tutorFocus with any duplicate lines cleared.
 */
export function dedupeFocusSignoff(tf, highlights) {
  if (!tf || typeof tf !== "object") return tf;
  const others = highlights.map(signoffKey).filter((s) => s.length >= SIGNOFF_MIN);
  if (others.length === 0) return tf;
  const strip = (text) => {
    if (typeof text !== "string" || text.trim() === "") return text;
    const kept = text
      .split("\n")
      .filter((line) => {
        const n = signoffKey(line);
        if (n.length < SIGNOFF_MIN) return true; // too short to be a sign-off duplicate
        return !others.some((o) => o === n || o.includes(n) || n.includes(o));
      })
      .join("\n")
      .replace(/\s+$/u, "");
    return kept.trim() === "" ? null : kept;
  };
  return { ...tf, aiFeedback: strip(tf.aiFeedback), tutorNotes: strip(tf.tutorNotes) };
}

/**
 * Per-class coaching block (WeekVM.tutorFocus, §10 contract addition), lifted VERBATIM
 * from the lesson's normalized ai_tutor feedback: the AI coach summary, the tutor's
 * prose note, its Chinese translation, and the suggested next focus. This is Cambly's
 * own text — NOT a learner-error claim — so it is never routed through the quote-guard.
 * Returns null for lessons with no ai_tutor feedback (the older data shape).
 */
export function tutorFocusOf(lesson) {
  const f = lesson.aiTutorFeedback;
  if (!f || typeof f !== "object") return null;
  return {
    // Worksheet/exercise tails are stripped so the Focus box shows coaching prose only.
    aiFeedback: stripWorksheet(aiFeedbackProse(f.finalAIFeedback)),
    // Cambly's whatWeCanWorkOn — STRICT strip: a pasted vocabulary worksheet (emoji title
    // first) is not coaching and becomes null rather than a "Work on" line of drill text.
    workOn: coachNotes(f).workOn,
    tutorNotes: stripWorksheet(f.tutorNotes ?? null),
    tutorNotesZh: f.tutorNotesTranslated ?? null,
    nextFocus: f.finalSuggestedNextLesson ?? null,
  };
}

// ── review / level / plan composition (RULES 9–11) ───────────────────────────────

const REVIEW_WENT_WELL_MAX = 4;
const REVIEW_NEEDS_WORK_MAX = 6;
const PLAN_ITEMS_MAX = 7;
const PLAN_ASK_MAX = 3;

/**
 * WeekVM.review from the wire block. The summary is required (else the block is omitted
 * and logged). Each point/issue keeps its optional verbatim quote only when the guard
 * matches it in the cited lesson — any side for wentWell, student side for needsWork; a
 * miss NULLS the quote and keeps the item. Blank items are dropped; lists are capped.
 * @param {object} wireReview
 * @param {{guard:Function, corpusFor:Function, byLesson:Map, logReject:Function}} ctx the builder's gate seams
 * @returns {object|undefined} undefined ⇒ no `review` key on the VM
 */
export function composeReview(wireReview, { guard, corpusFor, byLesson, logReject }) {
  if (!wireReview || typeof wireReview !== "object") return undefined;
  if (!hasStr(wireReview.summary)) {
    logReject({ type: "review", dropped: true, section: "review", reason: "empty summary → review omitted" });
    return undefined;
  }
  const guardedQuote = (item, side) => {
    const lessonId = byLesson.has(item.lessonId) ? item.lessonId : null;
    if (!hasStr(item.quote)) return { quote: null, lessonId };
    if (lessonId === null) {
      logReject({ type: "quote-guard", dropped: false, section: "review", quote: item.quote, quoteBy: side, reason: "lessonId not in this week → quote nulled" });
      return { quote: null, lessonId };
    }
    const ok = guard(item.quote, corpusFor(lessonId), side, { section: "review", lessonId, dropped: false });
    return { quote: ok ? item.quote : null, lessonId };
  };
  const wentWell = arr(wireReview.wentWell)
    .filter((w) => w && hasStr(w.point))
    .slice(0, REVIEW_WENT_WELL_MAX)
    .map((w) => ({ point: w.point, ...guardedQuote(w, "any") }));
  const needsWork = arr(wireReview.needsWork)
    .filter((n) => n && hasStr(n.issue) && hasStr(n.fix))
    .slice(0, REVIEW_NEEDS_WORK_MAX)
    .map((n) => ({ issue: n.issue, fix: n.fix, ...guardedQuote(n, "student") }));
  return { summary: wireReview.summary, wentWell, needsWork };
}

/**
 * WeekVM.level from the wire block. `overall` must be a known band and `summary` non-empty
 * (else omitted + logged); an unknown confidence falls back to "low"; dimensions are
 * normalised to EXACTLY the five canonical names in canonical order (a missing or invalid
 * one inherits the overall band with empty evidence, logged); advice keeps up to three
 * valid items and is never padded with invented text.
 * @returns {object|undefined} undefined ⇒ no `level` key on the VM
 */
export function composeLevel(wireLevel, { logReject }) {
  if (!wireLevel || typeof wireLevel !== "object") return undefined;
  const overallIdx = bandIndexOf(wireLevel.overall);
  if (overallIdx === -1 || !hasStr(wireLevel.summary)) {
    const reason =
      overallIdx === -1
        ? `unknown band ${JSON.stringify(wireLevel.overall ?? null)} → level omitted`
        : "empty summary → level omitted";
    logReject({ type: "level", dropped: true, section: "level", reason });
    return undefined;
  }
  const confidence = CONFIDENCE_LEVELS.includes(wireLevel.confidence) ? wireLevel.confidence : "low";
  const wireDims = arr(wireLevel.dimensions).filter((d) => d && typeof d === "object");
  const dimensions = LEVEL_DIMENSIONS.map((name) => {
    const d = wireDims.find(
      (x) => typeof x.name === "string" && x.name.trim().toLowerCase() === name && bandIndexOf(x.band) !== -1,
    );
    if (!d) {
      logReject({ type: "level", dropped: false, section: "level", reason: `dimension "${name}" missing or invalid → inherits the overall band` });
      return { name, band: BANDS[overallIdx], bandIndex: overallIdx, evidence: "" };
    }
    return { name, band: d.band, bandIndex: bandIndexOf(d.band), evidence: typeof d.evidence === "string" ? d.evidence : "" };
  });
  const advice = arr(wireLevel.advice)
    .filter((a) => a && hasStr(a.title) && hasStr(a.detail))
    .slice(0, LEVEL_ADVICE_MAX)
    .map((a) => ({ title: a.title, detail: a.detail }));
  return { overall: BANDS[overallIdx], bandIndex: overallIdx, confidence, dimensions, summary: wireLevel.summary, advice };
}

/**
 * Display label of the week AFTER the given window — the plan is for next week. Derived
 * from the weekId alone (CST Monday + 7 days) so it never depends on a caller's endMs.
 * @param {{weekId:string}} window
 * @returns {string} e.g. "Sep 7–13"
 */
export function nextWeekLabel(window) {
  return weekWindow(weekIdToStartMs(window.weekId) + 7 * MS_DAY).weekLabel;
}

/**
 * WeekVM.plan from the wire block. `focus` and at least one valid item are required (else
 * omitted + logged); an item needs a known day label and a task (blank/unknown ones are
 * dropped + logged); lists are capped; `weekLabel` is builder-derived for the next week.
 * @returns {object|undefined} undefined ⇒ no `plan` key on the VM
 */
export function composePlan(wirePlan, window, { logReject }) {
  if (!wirePlan || typeof wirePlan !== "object") return undefined;
  const rawItems = arr(wirePlan.items);
  const valid = rawItems.filter((it) => it && PLAN_DAYS.includes(it.day) && hasStr(it.task));
  if (valid.length < rawItems.length) {
    logReject({ type: "plan", dropped: false, section: "plan", reason: `${rawItems.length - valid.length} plan item(s) with an unknown day or empty task dropped` });
  }
  const items = valid
    .slice(0, PLAN_ITEMS_MAX)
    .map((it) => ({ day: it.day, task: it.task, why: typeof it.why === "string" ? it.why : "" }));
  if (!hasStr(wirePlan.focus) || items.length === 0) {
    const reason = !hasStr(wirePlan.focus) ? "empty focus → plan omitted" : "no valid items → plan omitted";
    logReject({ type: "plan", dropped: true, section: "plan", reason });
    return undefined;
  }
  const askTutor = arr(wirePlan.askTutor).filter(hasStr).slice(0, PLAN_ASK_MAX);
  return { weekLabel: nextWeekLabel(window), focus: wirePlan.focus, items, askTutor };
}
