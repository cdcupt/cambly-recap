// src/render/validate.js — fail-closed gates on the renderer path (F4 · F6 · F7 · §10).
//
// Any schema violation, enum miss, missing ▣ quote field, Σ-invariant mismatch,
// doctored integrity block, or budget breach throws RenderAbort — the caller
// aborts BEFORE the atomic swap, leaving the previously published site intact
// (F7 "fail closed"). These are defense-in-depth re-asserts: the builder's two
// gates (§3) already ran upstream; the renderer never trusts that they did.

export const SCHEMA_VERSION = 1;
export const MAX_PAGE_BYTES = 200 * 1024; // §F6 charter cap
export const MAX_CSS_BYTES = 15 * 1024;
export const MAX_JS_BYTES = 2 * 1024;

const QUOTE_BY = new Set(["student", "tutor"]);
const PRACTICE_FORMATS = new Set([
  "FILL_THE_GAP",
  "CORRECT_IT",
  "SAY_IT_BETTER",
]);

/** Thrown by every gate; the run wrapper maps it to a fetch-failed/aborted outcome. */
export class RenderAbort extends Error {
  constructor(message) {
    super(message);
    this.name = "RenderAbort";
  }
}

function fail(msg) {
  throw new RenderAbort(msg);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Schema + enum + ▣ quote validation for one week VM. Aborts on any violation.
 * schemaVersion ≠ 1 is a hard abort (U-RN-⑪); an unknown build{} block is
 * tolerated (F4). isEmpty:true stubs must carry empty arrays.
 */
export function validateWeek(vm) {
  if (!vm || typeof vm !== "object") fail("week VM is not an object");
  if (vm.schemaVersion !== SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${vm.schemaVersion} (expected ${SCHEMA_VERSION})`);
  }
  for (const f of ["weekId", "weekLabel", "startDate", "endDate", "publishedAt"]) {
    if (!isNonEmptyString(vm[f])) fail(`week ${vm.weekId ?? "?"}: missing ${f}`);
  }
  if (typeof vm.isEmpty !== "boolean") fail(`week ${vm.weekId}: isEmpty must be a boolean`);
  if (!vm.stats || typeof vm.stats !== "object") fail(`week ${vm.weekId}: missing stats`);

  const arrays = ["classes", "vocabulary", "grammarGroups", "phrasing", "practice"];
  for (const a of arrays) {
    if (vm[a] !== undefined && !Array.isArray(vm[a])) {
      fail(`week ${vm.weekId}: ${a} must be an array`);
    }
  }

  if (vm.isEmpty === true) {
    for (const a of arrays) {
      if (Array.isArray(vm[a]) && vm[a].length > 0) {
        fail(`week ${vm.weekId}: isEmpty week must have empty ${a}`);
      }
    }
    return; // stub: nothing more to check
  }

  validateClasses(vm);
  validateVocabulary(vm);
  validateGrammar(vm);
  validatePhrasing(vm);
  validatePractice(vm);
}

function validateClasses(vm) {
  for (const [i, c] of (vm.classes || []).entries()) {
    if (!isNonEmptyString(c.lessonId)) fail(`week ${vm.weekId}: classes[${i}] missing lessonId`);
    if (!isNonEmptyString(c.startAt)) fail(`week ${vm.weekId}: classes[${i}] missing startAt`);
    if (c.moment) {
      const { text, quotes } = c.moment;
      if (!isNonEmptyString(text)) fail(`week ${vm.weekId}: classes[${i}].moment.text empty`);
      // U-RN-⑭: moment highlights are verbatim transcript lines, guarded against the
      // real corpus upstream in the builder (which the renderer has no access to). They
      // are NOT required to be substrings of the moment.text narrative — a highlight the
      // prose doesn't embed simply renders without an inline <q> mark — so the only
      // re-assert here is the ▣ non-empty check.
      for (const [qi, q] of (quotes || []).entries()) {
        if (!isNonEmptyString(q)) fail(`week ${vm.weekId}: classes[${i}].moment.quotes[${qi}] empty (▣)`);
      }
    }
  }
}

function validateVocabulary(vm) {
  for (const [i, v] of (vm.vocabulary || []).entries()) {
    if (!isNonEmptyString(v.term)) fail(`week ${vm.weekId}: vocabulary[${i}] missing term`);
    // The example quote is OPTIONAL (beta finding 5): a word whose only candidate line did
    // not contain the term renders as term + meaning + day, with no misleading sentence.
    // When a quote IS present it must be a non-empty ▣ field on a valid side.
    if (v.quote !== null && v.quote !== undefined) {
      if (!isNonEmptyString(v.quote)) fail(`week ${vm.weekId}: vocabulary[${i}].quote empty (▣)`);
      if (!QUOTE_BY.has(v.quoteBy)) fail(`week ${vm.weekId}: vocabulary[${i}].quoteBy invalid`);
    }
  }
}

function validateGrammar(vm) {
  for (const [gi, g] of (vm.grammarGroups || []).entries()) {
    if (!isNonEmptyString(g.pattern)) fail(`week ${vm.weekId}: grammarGroups[${gi}] missing pattern`);
    if (!Array.isArray(g.items) || g.items.length === 0) {
      fail(`week ${vm.weekId}: grammarGroups[${gi}] has no items`);
    }
    for (const [ii, it] of g.items.entries()) {
      if (!isNonEmptyString(it.said)) fail(`week ${vm.weekId}: grammarGroups[${gi}].items[${ii}].said empty (▣)`);
      if (!isNonEmptyString(it.fix)) fail(`week ${vm.weekId}: grammarGroups[${gi}].items[${ii}].fix empty`);
      if (!isNonEmptyString(it.correctionId)) {
        fail(`week ${vm.weekId}: grammarGroups[${gi}].items[${ii}].correctionId required`);
      }
    }
  }
}

function validatePhrasing(vm) {
  for (const [i, p] of (vm.phrasing || []).entries()) {
    if (!isNonEmptyString(p.said)) fail(`week ${vm.weekId}: phrasing[${i}].said empty (▣)`);
    if (!isNonEmptyString(p.better)) fail(`week ${vm.weekId}: phrasing[${i}] missing better`);
  }
}

function validatePractice(vm) {
  for (const [i, p] of (vm.practice || []).entries()) {
    if (!PRACTICE_FORMATS.has(p.format)) fail(`week ${vm.weekId}: practice[${i}].format invalid`);
    if (!isNonEmptyString(p.prompt)) fail(`week ${vm.weekId}: practice[${i}] missing prompt`);
    if (!isNonEmptyString(p.answer)) fail(`week ${vm.weekId}: practice[${i}] missing answer`);
  }
}

/**
 * Σ-invariant re-assert (§10 hard gate, U-RN-⑩). Recomputes the rendered counts from the
 * arrays and enforces two things: (a) the USER-FACING stats.corrections equals the grammar
 * section total (renderedGrammar) so header == section == badge (beta finding 4); and (b)
 * the raw Cambly-reported Σ anchor kept in integrity.reportedCorrections equals
 * renderedGrammar + vocab(fromCorrectionId) + phrasing(fromCorrectionId) — no correction
 * lost or invented. A doctored integrity{} block that disagrees with the recomputed rendered
 * breakdown aborts. Returns the facts (reported = the raw Σ anchor).
 */
export function assertSigma(vm) {
  const renderedGrammar = (vm.grammarGroups || []).reduce(
    (sum, g) => sum + (Array.isArray(g.items) ? g.items.length : 0),
    0,
  );
  const renderedVocab = (vm.vocabulary || []).filter(
    (v) => v.fromCorrectionId !== null && v.fromCorrectionId !== undefined,
  ).length;
  const renderedPhrasing = (vm.phrasing || []).filter(
    (p) => p.fromCorrectionId !== null && p.fromCorrectionId !== undefined,
  ).length;
  const sum = renderedGrammar + renderedVocab + renderedPhrasing;

  // (a) The header/badge count must equal the Grammar section it labels.
  const statsCorr = vm.stats ? vm.stats.corrections ?? 0 : 0;
  if (statsCorr !== renderedGrammar) {
    fail(
      `week ${vm.weekId}: Σ mismatch — stats.corrections=${statsCorr} ≠ ` +
        `rendered grammar ${renderedGrammar}`,
    );
  }

  // (b) The raw Σ anchor (integrity.reportedCorrections) must account for every correction.
  const integ = vm.integrity;
  const reported =
    integ && integ.reportedCorrections !== undefined ? integ.reportedCorrections : sum;
  if (reported !== sum) {
    fail(
      `week ${vm.weekId}: Σ mismatch — reportedCorrections=${reported} ≠ ` +
        `grammar ${renderedGrammar} + vocab ${renderedVocab} + phrasing ${renderedPhrasing} = ${sum}`,
    );
  }
  if (integ && typeof integ === "object") {
    const drift =
      (integ.renderedGrammar !== undefined && integ.renderedGrammar !== renderedGrammar) ||
      (integ.renderedVocab !== undefined && integ.renderedVocab !== renderedVocab) ||
      (integ.renderedPhrasing !== undefined && integ.renderedPhrasing !== renderedPhrasing);
    if (drift) fail(`week ${vm.weekId}: doctored integrity{} block does not match rendered counts`);
  }
  return { reported, renderedGrammar, renderedVocab, renderedPhrasing, sum };
}

/**
 * Page budget assert (F6 · U-RN-⑬): a rendered page must be < 200 KB and must
 * reference zero external resources (self-contained, favicon = inline data-URI).
 *
 * The external-resource scan requires a REAL attribute quote (" or ') right after
 * `src=`/`href=`. The renderer always quotes its attributes, and esc() turns every
 * user-content quote into an entity (&quot; / &#39;), so escaped transcript text
 * containing a pasted `href=https://…` or `<a href=https://…>` can never satisfy
 * the quote and cannot trip the gate — only a genuine emitted attribute can.
 */
export function assertBudget(html, label = "page") {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes >= MAX_PAGE_BYTES) {
    fail(`${label}: ${bytes} bytes ≥ ${MAX_PAGE_BYTES} budget`);
  }
  const external = /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.exec(html);
  if (external) {
    fail(`${label}: external resource reference found (${external[0]})`);
  }
}
