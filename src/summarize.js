// src/summarize.js — weekly summarizer (TECH §3 "summarizer", §10 who-fills-what).
//
// One OpenAI structured-output call per week. The LLM is deliberately confined to
// the *narrow* wire schema below — it may only choose, group, explain and quote.
// Every number, date, name and correction text is builder-derived (src/build.js),
// so a hallucinated statistic or correction is structurally impossible.
//
// Node 22 native fetch, zero npm dependencies. The api.openai.com host is an env
// seam (OPENAI_BASE_URL) so tests point it at a mock server.

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
// topic, per-class stats, or correction said/fix appear here — those are builder-core.

const CLASS_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["lessonId", "moment", "tutorNote"],
  properties: {
    lessonId: { type: "string" },
    moment: {
      type: "object",
      additionalProperties: false,
      required: ["text", "quotes"],
      properties: {
        text: { type: "string" },
        quotes: { type: "array", items: { type: "string" } },
      },
    },
    tutorNote: { type: ["string", "null"] },
  },
};

const VOCAB_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["term", "meaning", "quote", "quoteBy", "lessonId", "fromCorrectionId"],
  properties: {
    term: { type: "string" },
    meaning: { type: "string" },
    quote: { type: "string" },
    quoteBy: { type: "string", enum: ["student", "tutor"] },
    lessonId: { type: "string" },
    fromCorrectionId: { type: ["string", "null"] },
  },
};

const GRAMMAR_GROUP = {
  type: "object",
  additionalProperties: false,
  required: ["pattern", "rule", "items"],
  properties: {
    pattern: { type: "string" },
    rule: { type: ["string", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["correctionId", "why"],
        properties: {
          correctionId: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
};

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
  return {
    type: "object",
    additionalProperties: false,
    required: ["classes", "vocabulary", "grammarGroups", "phrasing", "practice"],
    properties: {
      classes: { type: "array", items: CLASS_ITEM },
      vocabulary: { type: "array", items: VOCAB_ITEM },
      grammarGroups: { type: "array", items: GRAMMAR_GROUP },
      phrasing: { type: "array", items: PHRASING_ITEM },
      practice: { type: "array", items: PRACTICE_ITEM },
    },
  };
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
  "You are the recap writer for a weekly English-tutoring digest. You receive the",
  "student's real Cambly lessons for one week: verbatim transcripts (speaker-tagged),",
  "the tutor's typed chat, and the tutor's corrective-feedback records (each with a",
  "stable id). Produce ONLY the JSON object described by the response schema.",
  "",
  "Hard rules — every one is later machine-verified; a violation drops the item:",
  "1. NEVER invent content. You may only choose, group, explain, and quote lines that",
  "   actually appear in the supplied transcripts, chat, or feedback.",
  "2. Every quote field (each classes[].moment.quotes entry, every vocabulary.quote,",
  "   every phrasing.said) MUST be copied character-for-character from a single supplied",
  "   line — never stitched across two turns, never paraphrased. quoteBy must name the",
  "   speaker who actually said it (student or tutor). For a vocabulary item, choose as its",
  "   quote a natural line that actually CONTAINS the term (a real usage) — not a dictionary",
  "   definition, a question about the word, or an ASR-garbled form; if no supplied line uses",
  "   the term, omit the quote and the builder will show the word without an example.",
  "3. Every correction id must be placed EXACTLY ONCE across the whole output — as a",
  "   grammarGroups item (correctionId), or as one vocabulary.fromCorrectionId, or as one",
  "   phrasing.fromCorrectionId. A correction that teaches both a word and a phrasing goes",
  "   in exactly one section. vocabulary and phrasing carry at most one fromCorrectionId.",
  "   For grammar items you return only correctionId + why — the corrected wording is filled",
  "   from the record, so do not restate it.",
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
  "   the vocabulary or phrasing came from.",
].join("\n");

function speakerTranscript(lesson) {
  return lesson.transcript
    .map((t, i) => `  [${i + 1}] (${t.speaker}) ${t.text}`)
    .join("\n");
}

function correctionLines(lesson) {
  if (!lesson.corrections.length) return "  (none)";
  return lesson.corrections
    .map((c) => `  ${c.id} · "${c.said ?? ""}" -> "${c.fix ?? ""}" · ${c.why ?? ""}`)
    .join("\n");
}

function chatLines(lesson) {
  if (!lesson.chat.length) return "  (none)";
  return lesson.chat.map((m) => `  (${m.from}) ${m.text}`).join("\n");
}

/** The compact user-message bundle: one block per lesson (meta · transcript · corrections · notes · chat). */
export function buildWeekBundle(lessons) {
  const ordered = [...lessons].sort((a, b) =>
    String(a.startAtCST).localeCompare(String(b.startAtCST)) ||
    String(a.lessonId).localeCompare(String(b.lessonId)),
  );
  return ordered
    .map((lesson, idx) => {
      const meta =
        `### Class ${idx + 1} — ${lesson.weekday ?? "?"} ${lesson.startAtCST ?? "?"} · ` +
        `${lesson.minutes ?? "?"} min · Tutor: ${lesson.tutor ?? "?"} · ` +
        `Topic: ${lesson.topic ?? "?"} · lessonId: ${lesson.lessonId}`;
      const notes = lesson.tutorNotes.length
        ? lesson.tutorNotes.map((n) => `  - ${n}`).join("\n")
        : "  (none)";
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
      ].join("\n");
    })
    .join("\n\n");
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
 * One structured-output OpenAI call for the week, with retry + schema validation.
 *
 * Retries (default 3): a transport error or a 5xx/429 status is transient and retried;
 * a valid 2xx whose JSON fails the strict wire schema is retried too (I-SM ③). Any
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

    const schemaErrors = validateAgainstSchema(wire, wireSchema());
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
