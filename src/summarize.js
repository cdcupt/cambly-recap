// src/summarize.js — weekly summarizer (TECH §3 "summarizer", §10 who-fills-what).
//
// One OpenAI structured-output call per week. The LLM is deliberately confined to
// the *narrow* wire schema below — it may only choose, group, explain and quote.
// Every number, date, name and correction text is builder-derived (src/build.js),
// so a hallucinated statistic or correction is structurally impossible.
//
// Node 22 native fetch, zero npm dependencies. The api.openai.com host is an env
// seam (OPENAI_BASE_URL) so tests point it at a mock server.

import { weekWindow } from "./week.js";
import { coachNotes, BANDS, LEVEL_DIMENSIONS, CONFIDENCE_LEVELS, PLAN_DAYS } from "./coach.js";

/** Production defaults for the env seams; read at call time so tests can inject. */
export function openaiBase() {
  return process.env.OPENAI_BASE_URL || "https://api.openai.com";
}
export function openaiModel() {
  return process.env.OPENAI_MODEL || "gpt-5.1";
}
export function openaiKey() {
  return process.env.OPENAI_API_KEY || "";
}

export const DEFAULT_BACKOFF_MS = [2000, 8000, 30000];
export const DEFAULT_RETRIES = 3;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OpenAI transport/status failure that survived all retries → the run's fetch-failed outcome. */
export class OpenAIError extends Error {
  constructor(message, { status, attempts } = {}) {
    super(message);
    this.name = "OpenAIError";
    this.stage = "summarize";
    this.status = status;
    this.attempts = attempts;
  }
}

/** The model answered, but its JSON did not satisfy the strict wire schema (×retries). */
export class SchemaInvalidError extends Error {
  constructor(message, { errors, attempts } = {}) {
    super(message);
    this.name = "SchemaInvalidError";
    this.stage = "summarize";
    this.errors = errors;
    this.attempts = attempts;
  }
}

// ── Wire schema — the ONLY fields the LLM is allowed to emit (§10 who-fills-what) ──
//
// Strict JSON-schema mode: every property is required, additionalProperties:false,
// nullable fields expressed as a ["type","null"] union. No numbers, dates, tutor,
// or per-class stats appear here — those are builder-core. The only verbatim text the
// LLM authors about the STUDENT (a derived grammar `said`, a review quote) is guarded
// against the transcript by the builder before it can render.

const STR = { type: "string" };
const NSTR = { type: ["string", "null"] };
const BAND = { type: "string", enum: [...BANDS] };

/** Strict object helper: every listed property required, nothing else allowed. */
function obj(properties) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

const CLASS_ITEM = obj({
  lessonId: STR,
  // RULE 12 — a specific 3–7 word title; the builder uses it only for a generic topic.
  title: STR,
  moment: obj({ text: STR, quotes: { type: "array", items: STR } }),
  tutorNote: NSTR,
});

const VOCAB_ITEM = obj({
  term: STR,
  meaning: STR,
  quote: STR,
  quoteBy: { type: "string", enum: ["student", "tutor"] },
  lessonId: STR,
  fromCorrectionId: NSTR,
  // RULE 8 — a model sentence, shown by the builder only if no clean verbatim usage survives.
  example: NSTR,
});

// RULE 6 — an item is EITHER Cambly-anchored (correctionId set; said/fix/lessonId null,
// filled from the record) OR transcript-derived (correctionId null; said/fix/lessonId set).
const GRAMMAR_GROUP = obj({
  pattern: STR,
  rule: NSTR,
  items: {
    type: "array",
    items: obj({ correctionId: NSTR, said: NSTR, fix: NSTR, why: STR, lessonId: NSTR }),
  },
});

const REVIEW = obj({
  summary: STR,
  wentWell: { type: "array", items: obj({ point: STR, quote: NSTR, lessonId: NSTR }) },
  needsWork: { type: "array", items: obj({ issue: STR, fix: STR, quote: NSTR, lessonId: NSTR }) },
});

const LEVEL = obj({
  overall: BAND,
  confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
  dimensions: {
    type: "array",
    items: obj({ name: { type: "string", enum: [...LEVEL_DIMENSIONS] }, band: BAND, evidence: STR }),
  },
  summary: STR,
  advice: { type: "array", items: obj({ title: STR, detail: STR }) },
});

const PLAN = obj({
  focus: STR,
  items: { type: "array", items: obj({ day: { type: "string", enum: [...PLAN_DAYS] }, task: STR, why: STR }) },
  askTutor: { type: "array", items: STR },
});

const PHRASING_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["said", "better", "why", "lessonId", "fromCorrectionId"],
  properties: {
    said: { type: "string" },
    better: { type: "string" },
    why: { type: "string" },
    lessonId: { type: "string" },
    fromCorrectionId: { type: ["string", "null"] },
  },
};

const PRACTICE_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["format", "prompt", "cue", "answer", "why", "sourceIds"],
  properties: {
    format: { type: "string", enum: ["FILL_THE_GAP", "CORRECT_IT", "SAY_IT_BETTER"] },
    prompt: { type: "string" },
    cue: { type: ["string", "null"] },
    answer: { type: "string" },
    why: { type: "string" },
    sourceIds: { type: "array", items: { type: "string" } },
  },
};

/** The strict wire schema (fresh object each call so a caller can never mutate the shared one). */
export function wireSchema() {
  return structuredClone(
    obj({
      classes: { type: "array", items: CLASS_ITEM },
      vocabulary: { type: "array", items: VOCAB_ITEM },
      grammarGroups: { type: "array", items: GRAMMAR_GROUP },
      phrasing: { type: "array", items: PHRASING_ITEM },
      practice: { type: "array", items: PRACTICE_ITEM },
      review: REVIEW,
      level: LEVEL,
      plan: PLAN,
    }),
  );
}

/**
 * The schema the LOCAL re-validate applies to a 2xx response. Identical to the strict
 * request schema except that the recap-v2 additions are optional here: the top-level
 * review / level / plan blocks, classes[].title, vocabulary[].example and the derived-item
 * fields said / fix / lessonId on grammar items. OpenAI's strict mode already guarantees
 * the model emits them; locally, a legacy-shaped wire (an older replay, a test double)
 * still builds because the builder treats every one of those fields as optional. Types,
 * enums and additionalProperties:false stay fully enforced.
 */
export function acceptanceSchema() {
  const s = wireSchema();
  const relax = (node, keys) => {
    node.required = node.required.filter((k) => !keys.includes(k));
  };
  relax(s, ["review", "level", "plan"]);
  relax(s.properties.classes.items, ["title"]);
  relax(s.properties.vocabulary.items, ["example"]);
  relax(s.properties.grammarGroups.items.properties.items.items, ["said", "fix", "lessonId"]);
  return s;
}

// ── Minimal JSON-schema-subset validator (type/enum/required/properties/items) ──

/**
 * Validate `value` against the wire-schema subset. Returns an array of human error
 * strings (empty ⇒ valid). Supports: type (string | ["t","null"]), enum, required,
 * properties, additionalProperties:false, items.
 */
export function validateAgainstSchema(value, schema, path = "$") {
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];

  const matches = types.some((t) => {
    if (t === "null") return value === null;
    if (t === "array") return Array.isArray(value);
    if (t === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (t === "string") return typeof value === "string";
    if (t === "integer") return typeof value === "number" && Number.isInteger(value);
    if (t === "number") return typeof value === "number";
    if (t === "boolean") return typeof value === "boolean";
    return false;
  });
  if (!matches) {
    errors.push(`${path}: expected ${types.join("|")}, got ${value === null ? "null" : typeof value}`);
    return errors; // no point descending on a type mismatch
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (types.includes("object") && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, val] of Object.entries(value)) {
      const sub = schema.properties && schema.properties[key];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property`);
        continue;
      }
      errors.push(...validateAgainstSchema(val, sub, `${path}.${key}`));
    }
  }

  if (types.includes("array") && Array.isArray(value) && schema.items) {
    value.forEach((el, i) => errors.push(...validateAgainstSchema(el, schema.items, `${path}[${i}]`)));
  }

  return errors;
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

export const RULES = [
  "You are the recap writer and speaking coach for a weekly English-tutoring digest. You",
  "receive the student's real Cambly lessons for one week: verbatim transcripts (speaker-",
  "tagged, merged into whole turns), the tutor's typed chat, the tutor's corrective-feedback",
  "records (each with a stable id), and Cambly's own coach notes per class. Produce ONLY",
  "the JSON object described by the response schema.",
  "",
  "Hard rules — every one is later machine-verified; a violation drops the item:",
  "1. NEVER invent content. You may only choose, group, explain, and quote lines that",
  "   actually appear in the supplied transcripts, chat, or feedback.",
  "2. Every quote field (each classes[].moment.quotes entry, every vocabulary.quote,",
  "   every phrasing.said, every derived grammar said, every review quote) MUST be copied",
  "   character-for-character from a single supplied line — never stitched across two",
  "   turns, never paraphrased (capitalising the first word is tolerated). quoteBy must name",
  "   the speaker who actually said it (student or tutor). For a vocabulary item, choose as",
  "   its quote a natural line that actually CONTAINS the term (a real usage) — not a",
  "   dictionary definition, a question about the word, or an ASR-garbled form.",
  "3. Every correction id must be placed EXACTLY ONCE across the whole output — as a",
  "   grammarGroups item (correctionId), or as one vocabulary.fromCorrectionId, or as one",
  "   phrasing.fromCorrectionId. A correction that teaches both a word and a phrasing goes",
  "   in exactly one section. vocabulary and phrasing carry at most one fromCorrectionId.",
  "   For a Cambly-anchored grammar item return correctionId + why with said/fix/lessonId",
  "   null — the corrected wording is filled from the record, so do not restate it.",
  "4. Group grammar by the recurring pattern behind the mistakes; label each group with a",
  "   short, human-readable title (e.g. \"Past tense\", \"Purpose & infinitives\") — never a",
  "   slug, code token, or bare punctuation — and give each group a one-line, plain-words",
  "   rule a learner can remember.",
  "5. Emit exactly 8 practice items (FILL_THE_GAP | CORRECT_IT | SAY_IT_BETTER) built from",
  "   this week's real material — the grammar corrections AND the vocabulary and phrasing you",
  "   surfaced above. A week with no corrections still gets 8 items drawn from its vocabulary",
  "   and phrasing. Use ____ to mark the gap in a prompt and **x** to mark the highlighted",
  "   answer span. Every practice item's sourceIds must be non-empty: cite a real correction",
  "   id from the bundle when the drill comes from a correction, otherwise cite the lessonId",
  "   the material came from (transcript-derived drills cite the lessonId).",
  "6. Grammar from the transcript. When Cambly supplies few or no correction records, spot",
  "   real grammar errors in the STUDENT's own spontaneous speech — never in a read-aloud",
  "   passage, never ASR garble. For each: said = the SHORTEST verbatim student span (at most",
  "   25 words) that contains the error, copied character-for-character from ONE supplied line",
  "   (case may differ); fix = the minimal correction (same meaning, same words otherwise);",
  "   why = one plain-words line; correctionId null; lessonId set. At most 12 derived items,",
  "   grouped into at most 5 recurring patterns (e.g. \"Articles\", \"Past tense\", \"Plural -s\",",
  "   \"Word order\"), most frequent first. Cambly-anchored items keep their correctionId with",
  "   said/fix/lessonId null.",
  "7. Phrasing: at most 8 items; said is the shortest verbatim span (at most 25 words) that",
  "   carries the issue; better keeps the student's meaning; skip anything already covered",
  "   by a grammar item.",
  "8. Vocabulary: 6–10 items, including words the tutor typed in chat. quote must contain the",
  "   term (a real usage). If no supplied line uses the term naturally, still emit quote as",
  "   the closest line but ALSO give example — a short natural model sentence (at most 14",
  "   words) using the term; otherwise example is null. The builder shows example only when",
  "   the quote is not a clean usage. meaning: at most 12 learner-friendly words.",
  "9. Review: summary = 3–5 sentences about THIS week (topics, what improved, the 1–2 biggest",
  "   issues). wentWell = 2–4 points, each with an optional verbatim quote (either speaker)",
  "   and its lessonId. needsWork = 3–6 items: issue (short label + one clause), fix (what to",
  "   do instead, at most 25 words), an optional verbatim STUDENT quote and its lessonId. Draw",
  "   on the Cambly coach notes and the tutors' suggested next lessons where they agree with",
  "   the transcript evidence.",
  "10. Level (CEFR): judge SPONTANEOUS speech only (ignore read-aloud passages). Use the CEFR",
  "   qualitative aspects of spoken language — range (vocabulary/structures available),",
  "   accuracy (grammar control, error density, whether errors impede meaning), fluency (pace,",
  "   pauses, self-repair; the wpm/talk stats are evidence, not a verdict), interaction",
  "   (initiating, responding, asking, turn-taking), coherence (linking ideas, organising longer",
  "   turns). Band descriptors, condensed: A2 = short simple turns, frequent basic errors, needs",
  "   support; B1 = keeps going on familiar topics, reasonably accurate simple structures,",
  "   noticeable errors under pressure, simple connectors; B1+ = B1 with longer turns and wider",
  "   vocabulary but systematic slips (articles, tense, agreement); B2 = clear detailed turns on",
  "   abstract/technical topics, good control with occasional non-systematic slips, natural",
  "   pace, flexible interaction; B2+ = B2 with few errors and idiomatic range; C1 = fluent,",
  "   spontaneous, precise, errors rare. Give exactly one entry per dimension (range, accuracy,",
  "   fluency, interaction, coherence) with ONE line of concrete evidence each, an overall",
  "   holistic band, confidence (low if fewer than 3 classes or mostly read-aloud), a 2–3",
  "   sentence summary (why this band; what separates it from the next band), and exactly 3",
  "   advice items (title + detail, at most 40 words) targeted at reaching the next band.",
  "11. Plan: a concrete 7-day plan for the week AFTER this one. focus = one sentence; 5–7 items",
  "   (day Mon..Sun or \"Daily\"; task at most 25 words, doable in 10–20 minutes, grounded in",
  "   THIS week's errors, vocabulary and tutor suggestions; why at most 15 words); 2–3 askTutor",
  "   requests for the next class (e.g. \"Ask Niki to stop you on every missing article\").",
  "12. Titles: classes[].title = a specific 3–7 word title of what the class was about (e.g.",
  "   \"Lunch breaks & indoor workdays\"), never \"Pro Lesson\" or another generic label.",
].join("\n");

/** Transcript listing: merged `segments` when the normalizer supplied them, else raw lines. */
function speakerTranscript(lesson) {
  const lines = Array.isArray(lesson.segments) && lesson.segments.length ? lesson.segments : lesson.transcript || [];
  if (!lines.length) return "  (none)";
  return lines.map((t, i) => `  [${i + 1}] (${t.speaker}) ${t.text}`).join("\n");
}

/** The Cambly coach's notes for one class, worksheet-stripped (strict for the drill-prone fields). */
function coachLines(lesson) {
  const c = coachNotes(lesson.aiTutorFeedback);
  const or = (v) => (typeof v === "string" && v.trim() ? v : "(none)");
  return [
    `Cambly coach — what went well: ${or(c.didWell)}`,
    `Cambly coach — work on: ${or(c.workOn)}`,
    `Cambly coach — practice ideas: ${or(c.practiceIdeas)}`,
    `Tutor's suggested next lesson: ${or(c.nextLesson)}`,
  ].join("\n");
}

const READ_ALOUD_NOTE =
  'Note: in "Pro Lesson" classes the student READS AN ARTICLE ALOUD for part of the class — ' +
  "those long, formal student turns are not the student's own production. Judge level, " +
  "grammar and phrasing on spontaneous speech only.";

/** The bundle's first lines: week label, class count, tutors, and the read-aloud caveat. */
function weekHeader(lessons, weekLabel) {
  const names = [...new Set(lessons.map((l) => l.tutor).filter((t) => typeof t === "string" && t.trim()))];
  const tutors = names.length ? names.join(", ") : "unknown";
  const label =
    weekLabel ??
    (lessons.length && lessons[0].startAtCST && Number.isFinite(Date.parse(lessons[0].startAtCST))
      ? weekWindow(Date.parse(lessons[0].startAtCST)).weekLabel
      : "?");
  const n = lessons.length;
  return `## Week of ${label} — ${n} ${n === 1 ? "class" : "classes"} · tutors: ${tutors}\n${READ_ALOUD_NOTE}`;
}

/** "84 wpm · 52% talk · 593 unique words" from the lesson's Cambly stats (? when absent). */
function statsMeta(lesson) {
  const s = lesson.stats || {};
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : "?");
  return `${n(s.wpm)} wpm · ${n(s.talkRatio)}% talk · ${n(s.uniqueWords)} unique words`;
}

function correctionLines(lesson) {
  const corrections = Array.isArray(lesson.corrections) ? lesson.corrections : [];
  if (!corrections.length) return "  (none)";
  return corrections
    .map((c) => `  ${c.id} · "${c.said ?? ""}" -> "${c.fix ?? ""}" · ${c.why ?? ""}`)
    .join("\n");
}

function chatLines(lesson) {
  const chat = Array.isArray(lesson.chat) ? lesson.chat : [];
  if (!chat.length) return "  (none)";
  return chat.map((m) => `  (${m.from}) ${m.text}`).join("\n");
}

/**
 * The compact user-message bundle: a week header, then one block per lesson (meta with
 * the Cambly stats · transcript as merged turns · corrections · tutor notes · chat · the
 * Cambly coach's four notes). Pure; lessons are ordered chronologically.
 * @param {object[]} lessons normalized lessons
 * @param {{weekLabel?:string|null}} [opts] the week's display label (derived from the first lesson when absent)
 * @returns {string}
 */
export function buildWeekBundle(lessons, { weekLabel = null } = {}) {
  const ordered = [...lessons].sort((a, b) =>
    String(a.startAtCST).localeCompare(String(b.startAtCST)) ||
    String(a.lessonId).localeCompare(String(b.lessonId)),
  );
  const blocks = ordered.map((lesson, idx) => {
    const meta =
      `### Class ${idx + 1} — ${lesson.weekday ?? "?"} ${lesson.startAtCST ?? "?"} · ` +
      `${lesson.minutes ?? "?"} min · Tutor: ${lesson.tutor ?? "?"} · ` +
      `Topic: ${lesson.topic ?? "?"} · lessonId: ${lesson.lessonId} · ${statsMeta(lesson)}`;
    const tutorNotes = Array.isArray(lesson.tutorNotes) ? lesson.tutorNotes : [];
    const notes = tutorNotes.length ? tutorNotes.map((n) => `  - ${n}`).join("\n") : "  (none)";
    return [
      meta,
      "Transcript:",
      speakerTranscript(lesson),
      "Corrections (id · said -> fix · why):",
      correctionLines(lesson),
      "Tutor notes:",
      notes,
      "Chat:",
      chatLines(lesson),
      coachLines(lesson),
    ].join("\n");
  });
  return [weekHeader(ordered, weekLabel), ...blocks].join("\n\n");
}

/** A corrective re-prompt appendix listing the quotes the guard rejected on the previous try. */
export function correctiveMessage(rejections) {
  const lines = rejections.map((r) => `  - (${r.section}${r.quoteBy ? `/${r.quoteBy}` : ""}) ${JSON.stringify(r.quote)}`);
  return [
    "CORRECTION REQUIRED. On the previous attempt these quote fields were NOT verbatim",
    "matches of any supplied line and were rejected:",
    ...lines,
    "",
    "Re-emit the full JSON. For each rejected item, either copy an exact line from the",
    "bundle (correct speaker) or omit that item. Do not invent or paraphrase.",
  ].join("\n");
}

/** The exact POST body for POST {OPENAI_BASE_URL}/v1/chat/completions (I-SM ①). */
export function buildRequestBody({ bundle, model = openaiModel(), rejections = null } = {}) {
  const messages = [
    { role: "system", content: RULES },
    { role: "user", content: bundle },
  ];
  if (Array.isArray(rejections) && rejections.length) {
    messages.push({ role: "user", content: correctiveMessage(rejections) });
  }
  return {
    model,
    response_format: {
      type: "json_schema",
      json_schema: { name: "weekly_recap", strict: true, schema: wireSchema() },
    },
    messages,
  };
}

// ── The OpenAI call ────────────────────────────────────────────────────────────

/**
 * True when a 429 body is OpenAI's `insufficient_quota` — the account has no
 * credit left, as opposed to a genuine rate limit. The two arrive with the same
 * status, but only one of them can be waited out.
 *
 * Fails safe toward "not a quota error": an unparseable or unexpected body keeps
 * the existing transient/retry behaviour rather than turning a recoverable blip
 * into a hard failure.
 *
 * @param {string} body raw response text
 * @returns {boolean}
 */
function isQuotaExhausted(body) {
  try {
    const err = JSON.parse(body)?.error;
    return err?.type === "insufficient_quota" || err?.code === "insufficient_quota";
  } catch {
    return false;
  }
}

/**
 * One structured-output OpenAI call for the week, with retry + schema validation.
 *
 * Retries (default 3): a transport error or a 5xx/rate-limit-429 status is transient
 * and retried; a valid 2xx whose JSON fails the strict wire schema is retried too
 * (I-SM ③). A 429 carrying `insufficient_quota` is NOT transient — the account is out
 * of credit, so it fails immediately with a message naming billing as the cause. Any
 * other non-2xx (400/401/…) is a hard OpenAIError immediately (not transient).
 * Exhausting all attempts throws OpenAIError (transport/status) or SchemaInvalidError
 * (schema) — both map to the run's fetch-failed outcome.
 *
 * The corrective re-prompt (I-SM ④) is a *second* call by the caller with `rejections`
 * set; this function makes exactly one request per invocation.
 *
 * @returns {Promise<{wire:object, promptTokens:number, model:string, raw:object}>}
 */
export async function summarizeWeek({
  bundle,
  model = openaiModel(),
  rejections = null,
  base = openaiBase(),
  apiKey = openaiKey(),
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  backoff = DEFAULT_BACKOFF_MS,
  retries = DEFAULT_RETRIES,
} = {}) {
  const url = `${base.replace(/\/$/, "")}/v1/chat/completions`;
  const body = JSON.stringify(buildRequestBody({ bundle, model, rejections }));
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const backoffFor = (attempt) => backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0;

  let lastTransport;
  let lastSchema;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let status;
    let text;
    try {
      const res = await fetchImpl(url, { method: "POST", headers, body });
      status = res.status;
      text = await res.text();
    } catch (err) {
      lastTransport = new OpenAIError(`OpenAI transport error: ${err && err.message}`, { attempts: attempt });
      if (attempt < retries) {
        await sleep(backoffFor(attempt));
        continue;
      }
      break;
    }

    // A 429 is two different failures sharing one status code. Quota exhaustion
    // is permanent until someone pays, so retrying just burns the run and buries
    // the cause under a status code that reads as "slow down".
    if (status === 429 && isQuotaExhausted(text)) {
      throw new OpenAIError(
        "OpenAI HTTP 429 insufficient_quota — the API account is out of credit; " +
          "top up billing at platform.openai.com (retrying cannot clear this)",
        { status, attempts: attempt },
      );
    }
    // Transient server statuses → retry.
    if (status >= 500 || status === 429) {
      lastTransport = new OpenAIError(`OpenAI HTTP ${status}`, { status, attempts: attempt });
      if (attempt < retries) {
        await sleep(backoffFor(attempt));
        continue;
      }
      break;
    }
    // Any other non-2xx (400 bad request, 401 auth, …) is not transient — fail now.
    if (status < 200 || status >= 300) {
      throw new OpenAIError(`OpenAI HTTP ${status}`, { status, attempts: attempt });
    }

    // 2xx — parse the completion envelope and the model's JSON content.
    let payload;
    let wire;
    try {
      payload = JSON.parse(text);
      const content = payload?.choices?.[0]?.message?.content;
      wire = JSON.parse(content);
    } catch {
      lastSchema = new SchemaInvalidError("OpenAI response was not parseable JSON", {
        errors: ["unparseable content"],
        attempts: attempt,
      });
      if (attempt < retries) {
        await sleep(backoffFor(attempt));
        continue;
      }
      break;
    }

    const schemaErrors = validateAgainstSchema(wire, acceptanceSchema());
    if (schemaErrors.length) {
      lastSchema = new SchemaInvalidError(`OpenAI response failed wire schema (${schemaErrors.length} errors)`, {
        errors: schemaErrors,
        attempts: attempt,
      });
      if (attempt < retries) {
        await sleep(backoffFor(attempt));
        continue;
      }
      break;
    }

    return {
      wire,
      promptTokens: Number.isFinite(payload?.usage?.prompt_tokens) ? payload.usage.prompt_tokens : 0,
      model,
      raw: payload,
    };
  }

  // All attempts exhausted — surface the most specific failure we saw.
  if (lastSchema) throw lastSchema;
  throw lastTransport || new OpenAIError("OpenAI request failed", { attempts: retries });
}
