// src/normalize.js — normalizer (TECH §3 "normalizer", §2 normalized_lesson).
//
// Merges the raw endpoint files into one normalized lesson: unwraps the
// {result: …} envelope and Mongo-style $date/$oid wrappers, tags transcript lines
// with speaker student|tutor by comparing userId to $CAMBLY_UID, and lifts
// corrections to {id, said, fix, why, category, ts}. Pure function of the raw
// files — deterministic and fully covered by fixture tests.

import fs from "node:fs";
import path from "node:path";
import { camblyUid } from "./fetch.js";
import { weekIdOf, weekdayOf, cstIso } from "./week.js";

/** Strip the Cambly {result: …} envelope when present. */
export function unwrap(o) {
  return o && typeof o === "object" && !Array.isArray(o) && "result" in o ? o.result : o;
}

/** Unwrap a Mongo $oid wrapper. */
export function unwrapOid(v) {
  return v && typeof v === "object" && "$oid" in v ? v.$oid : v;
}

/** Unwrap a Mongo $date wrapper (epoch ms). */
export function unwrapDate(v) {
  return v && typeof v === "object" && "$date" in v ? v.$date : v;
}

function asArray(o) {
  const u = unwrap(o);
  return Array.isArray(u) ? u : [];
}

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A non-empty trimmed-nonblank string, else null (verbatim value preserved, not trimmed). */
function strOrNull(v) {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Transcript turns → [{text, ts, speaker}], speaker resolved against the student UID. */
export function normalizeTranscript(lessonTranscript, uid) {
  const doc = unwrap(lessonTranscript);
  const turns = doc && Array.isArray(doc.transcript)
    ? doc.transcript
    : Array.isArray(doc)
      ? doc
      : [];
  // Guard each turn: a null/non-object member (e.g. a soft-deleted turn arriving as
  // null in the array) must be skipped, not crash the whole week build at the API
  // boundary — mirrors the object guard in normalizeAiTutorFeedback.
  return turns
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      text: typeof t.text === "string" ? t.text : "",
      ts: num(t.startOffsetSeconds ?? t.ts),
      speaker: t.userId === uid ? "student" : "tutor",
    }));
}

// JSON-structure tokens that only surface when a serialized object bleeds into a text
// field (beta finding 1). Human correction/coaching prose never contains a `}]},{` splice,
// a compact `":"` key/value pair, or a leading `[{` — so their presence marks the field
// corrupt. Straight-quote JSON only; curly-quoted dialogue in real speech cannot match.
const JSON_ARTIFACT = /\}\s*\]\s*\}\s*,\s*\{|":"|\[\{|\}\s*\]\s*\}/;

/**
 * Strip a JSON-serialization artifact out of a correction text field (said / fix / why).
 * When a nested corrective-feedback object is accidentally string-concatenated instead of a
 * single field, a fragment like `}]},{`, a compact `":"`, or a leading `[{` bleeds into the
 * human text (beta finding 1: three grammar `why` spans leaked `}]},{`). We keep only the
 * clean prose BEFORE the first such token, drop any dangling JSON punctuation the cut leaves
 * behind, and return null when nothing clean survives — so the field is omitted, never
 * rendered as garbage. A field with no artifact is returned verbatim; a non-string passes
 * through untouched. Idempotent and shared with the builder's grammar assembly.
 */
export function cleanCorrectionText(value) {
  if (typeof value !== "string") return value;
  const at = value.search(JSON_ARTIFACT);
  if (at === -1) return value; // clean → verbatim
  const kept = value.slice(0, at).replace(/[\s"'[\]{}:,]+$/u, "").trim();
  return kept === "" ? null : kept;
}

/**
 * Corrective-feedback records → the Σ-set shape [{id, said, fix, why, category, ts}].
 * A record with neither `id` nor `_id.$oid` gets a stable synthesized fallback id
 * (`${lessonId}#${index}`) so it still joins the Σ set — otherwise the builder's
 * id-keyed correctionIndex would silently drop it and undercount corrections.
 * said/fix/why are cleaned at this boundary so only human text reaches the on-disk
 * normalized lesson, the LLM bundle, and the rendered grammar rows (beta finding 1).
 */
export function normalizeCorrections(corrections, { lessonId } = {}) {
  // Guard each element: a null/non-object member (e.g. a soft-deleted correction
  // arriving as null) must be dropped, not crash the whole week build — mirrors the
  // object guard in normalizeAiTutorFeedback. The fallback id stays index-stable
  // because filtering happens before the id-keyed Σ index is built downstream.
  return asArray(corrections)
    .filter((c) => c && typeof c === "object")
    .map((c, i) => ({
      id: c.id || unwrapOid(c._id) || `${lessonId ?? "lesson"}#${i}`,
      said: cleanCorrectionText(c.sentence ?? null),
      fix: cleanCorrectionText(c.correction ?? null),
      why: cleanCorrectionText(c.reasoning ?? null),
      category: c.category ?? null,
      ts: num(c.startOffsetSeconds),
    }));
}

/** Talon chat messages → [{text, from}], from resolved against the student UID. */
export function normalizeChat(talonChats, uid) {
  // Guard each element: skip a null/non-object member rather than crash — same
  // null-safety as the transcript/corrections guards and normalizeAiTutorFeedback.
  return asArray(talonChats)
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      text: m.message ?? m.text ?? "",
      from: m.userId === uid ? "student" : "tutor",
    }));
}

/** wpm / talkRatio / uniqueWords from user_lesson_stats. */
export function normalizeStats(userLessonStats) {
  const u = unwrap(userLessonStats);
  const s = Array.isArray(u) ? u[0] : u && typeof u === "object" ? u : null;
  if (!s) return { wpm: null, talkRatio: null, uniqueWords: null };
  return {
    wpm: num(s.wordsPerMinute ?? s.wpm),
    talkRatio: num(s.talkRatio),
    uniqueWords: num(s.uniqueWords),
  };
}

/** Encouragement / tutor-note lines from the feedback endpoints, order-preserving, de-duped. */
export function collectTutorNotes(raw) {
  const notes = [];
  const push = (s) => {
    if (typeof s === "string" && s.trim() && !notes.includes(s)) notes.push(s);
  };
  for (const f of asArray(raw.ai_tutor_student_feedbacks)) push(f.tutorNotes);
  for (const f of asArray(raw.tutor_student_feedbacks)) {
    push(f.note ?? f.comment ?? f.text ?? f.tutorNotes);
  }
  return notes;
}

/**
 * The AI-tutor coaching block from ai_tutor_student_feedbacks[0], surfaced verbatim so
 * downstream can build WeekVM.tutorFocus. This is Cambly's OWN text (a coach summary,
 * tutor prose, its Chinese translation, and the suggested next focus) — NOT a
 * learner-error claim — so it is never quote-guarded. Returns null when the lesson has
 * no such feedback (older lessons predate this data shape) or carries no usable field.
 * `finalAIFeedback` may be an object (recent) or a string; passed through untouched for
 * downstream shaping.
 */
export function normalizeAiTutorFeedback(raw) {
  const f = asArray(raw.ai_tutor_student_feedbacks)[0];
  if (!f || typeof f !== "object") return null;
  const feedback = {
    finalAIFeedback: f.finalAIFeedback ?? null,
    tutorNotes: strOrNull(f.tutorNotes),
    tutorNotesTranslated: strOrNull(f.tutorNotesTranslated),
    finalSuggestedNextLesson: strOrNull(f.finalSuggestedNextLesson),
  };
  const hasAny =
    feedback.finalAIFeedback !== null ||
    feedback.tutorNotes !== null ||
    feedback.tutorNotesTranslated !== null ||
    feedback.finalSuggestedNextLesson !== null;
  return hasAny ? feedback : null;
}

/**
 * Class duration in minutes. Recent lessons_v2 listing entries carry an int
 * `scheduledMinutes` (e.g. 60); older shapes used durationMinutes/minutes/duration.
 * Last resort: round the scheduledStartAt→scheduledEndAt span (both {$date: ms}).
 */
function resolveMinutes(lesson) {
  const direct = num(
    lesson.scheduledMinutes ?? lesson.durationMinutes ?? lesson.minutes ?? lesson.duration,
  );
  if (direct !== null) return direct;
  const start = unwrapDate(lesson.scheduledStartAt);
  const end = unwrapDate(lesson.scheduledEndAt);
  if (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start
  ) {
    return Math.round((end - start) / 60000);
  }
  return null;
}

function resolveTopic(lesson, lessonPlan) {
  if (lesson.topic) return lesson.topic;
  const plan = unwrap(lessonPlan);
  if (plan && typeof plan === "object") return plan.title || plan._title || null;
  return null;
}

function resolveTutor(lesson, tutors) {
  const tid = lesson.tutorId || (Array.isArray(lesson.tutorIds) ? lesson.tutorIds[0] : null);
  const list = unwrap(tutors);
  if (Array.isArray(list) && tid) {
    const t = list.find((x) => (x.id || unwrapOid(x._id)) === tid);
    if (t) {
      return (
        t.displayName ||
        t.name ||
        [t.firstName, t.lastName].filter(Boolean).join(" ") ||
        null
      );
    }
  } else if (list && typeof list === "object" && tid && list[tid]) {
    const t = list[tid];
    return typeof t === "string" ? t : t.displayName || t.name || null;
  }
  return lesson.tutorName || null;
}

/**
 * Normalize one lesson's raw endpoint bundle into the on-disk normalized_lesson.
 *
 * @param {object} raw - { lesson (lessons_v2 listing record), tutors, lesson_transcript,
 *   talon_chats, corrective_feedback_corrections, positive_feedbacks,
 *   ai_tutor_student_feedbacks, tutor_student_feedbacks, user_lesson_stats,
 *   lesson_parts, lesson_plan }
 * @param {{uid?:string}} [opts]
 */
export function normalizeLesson(raw, { uid = camblyUid() } = {}) {
  const lesson = raw.lesson || raw._lesson || {};
  const transcriptDoc = unwrap(raw.lesson_transcript);
  const lessonId =
    lesson.id ||
    raw.lessonId ||
    (transcriptDoc && transcriptDoc.lessonId) ||
    null;

  const startEpoch = unwrapDate(lesson.scheduledStartAt);
  const hasEpoch = typeof startEpoch === "number" && Number.isFinite(startEpoch);

  return {
    lessonId,
    weekId: hasEpoch ? weekIdOf(startEpoch) : null,
    startAtCST: hasEpoch ? cstIso(startEpoch) : null,
    weekday: hasEpoch ? weekdayOf(startEpoch) : null,
    minutes: resolveMinutes(lesson),
    tutor: resolveTutor(lesson, raw.tutors),
    topic: resolveTopic(lesson, raw.lesson_plan),
    stats: normalizeStats(raw.user_lesson_stats),
    transcript: normalizeTranscript(raw.lesson_transcript, uid),
    corrections: normalizeCorrections(raw.corrective_feedback_corrections, { lessonId }),
    tutorNotes: collectTutorNotes(raw),
    aiTutorFeedback: normalizeAiTutorFeedback(raw),
    chat: normalizeChat(raw.talon_chats, uid),
  };
}

const ENDPOINT_FILES = {
  lesson_transcript: "lesson_transcript.json",
  talon_chats: "talon_chats.json",
  corrective_feedback_corrections: "corrective_feedback_corrections.json",
  positive_feedbacks: "positive_feedbacks.json",
  ai_tutor_student_feedbacks: "ai_tutor_student_feedbacks.json",
  tutor_student_feedbacks: "tutor_student_feedbacks.json",
  user_lesson_stats: "user_lesson_stats.json",
  lesson_parts: "lesson_parts.json",
  lesson_plan: "lesson_plan.json",
};

/**
 * Read a raw lesson directory and normalize it. The listing record (_lesson.json)
 * and tutors map may be passed in (they live outside the per-lesson dir in the
 * archive fixtures) or read from _lesson.json / tutors.json in the dir.
 */
export function normalizeLessonDir(dir, { fsImpl = fs, uid = camblyUid(), lesson, tutors } = {}) {
  const read = (file) => {
    try {
      return JSON.parse(fsImpl.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      return undefined;
    }
  };
  const raw = {
    lesson: lesson || read("_lesson.json") || {},
    tutors: tutors || read("tutors.json"),
  };
  for (const [key, file] of Object.entries(ENDPOINT_FILES)) raw[key] = read(file);
  return normalizeLesson(raw, { uid });
}
