// src/render/validate.js — fail-closed gates on the renderer path (F4 · F6 · F7 · §10).
//
// Any schema violation, enum miss, missing ▣ quote field, Σ-invariant mismatch,
// doctored integrity block, or budget breach throws RenderAbort — the caller
// aborts BEFORE the atomic swap, leaving the previously published site intact
// (F7 "fail closed"). These are defense-in-depth re-asserts: the builder's two
// gates (§3) already ran upstream; the renderer never trusts that they did.

import { BANDS, LEVEL_DIMENSIONS, CONFIDENCE_LEVELS, PLAN_DAYS, LEVEL_ADVICE_MAX, bandIndexOf } from "../coach.js";

export const SCHEMA_VERSION = 1;
export const MAX_PAGE_BYTES = 200 * 1024; // §F6 charter cap
/** Inline CSS cap for STYLES + SECTION_STYLES + CHART_STYLES together (one <style> block). */
export const MAX_CSS_BYTES = 28 * 1024;
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
  // The v2 blocks are OPTIONAL (older VMs lack them); when present their shape is strict.
  validateReview(vm);
  validateLevel(vm);
  validatePlan(vm);
}

/** An optional ▣ quote: null/undefined means "no quote"; a present one must be non-empty. */
function checkOptionalQuote(q, at) {
  if (q !== null && q !== undefined && !isNonEmptyString(q)) fail(`${at} empty (▣)`);
}

function validateClasses(vm) {
  for (const [i, c] of (vm.classes || []).entries()) {
    if (!isNonEmptyString(c.lessonId)) fail(`week ${vm.weekId}: classes[${i}] missing lessonId`);
    if (!isNonEmptyString(c.startAt)) fail(`week ${vm.weekId}: classes[${i}] missing startAt`);
    // title is optional (v2): null/undefined, or a non-empty string the card shows in place of the topic.
    if (c.title !== null && c.title !== undefined && !isNonEmptyString(c.title)) {
      fail(`week ${vm.weekId}: classes[${i}].title must be null or a non-empty string`);
    }
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
      const at = `week ${vm.weekId}: grammarGroups[${gi}].items[${ii}]`;
      if (!isNonEmptyString(it.said)) fail(`${at}.said empty (▣)`);
      if (!isNonEmptyString(it.fix)) fail(`${at}.fix empty`);
      // correctionId may be null ONLY on a transcript-derived item (derived:true ⇔ null id).
      const cid = it.correctionId;
      if (cid === null || cid === undefined) {
        if (it.derived !== true) fail(`${at}.correctionId required (only a derived:true item may carry null)`);
      } else {
        if (!isNonEmptyString(cid)) fail(`${at}.correctionId invalid`);
        if (it.derived === true) fail(`${at}: a derived:true item must not carry a correctionId`);
      }
    }
  }
}

function validateReview(vm) {
  const r = vm.review;
  if (r === undefined || r === null) return;
  const at = `week ${vm.weekId}: review`;
  if (typeof r !== "object") fail(`${at} must be an object`);
  if (!isNonEmptyString(r.summary)) fail(`${at}.summary empty`);
  if (!Array.isArray(r.wentWell) || !Array.isArray(r.needsWork)) fail(`${at}: wentWell/needsWork must be arrays`);
  for (const [i, w] of r.wentWell.entries()) {
    if (!w || !isNonEmptyString(w.point)) fail(`${at}.wentWell[${i}].point empty`);
    checkOptionalQuote(w.quote, `${at}.wentWell[${i}].quote`);
  }
  for (const [i, n] of r.needsWork.entries()) {
    if (!n || !isNonEmptyString(n.issue)) fail(`${at}.needsWork[${i}].issue empty`);
    if (!isNonEmptyString(n.fix)) fail(`${at}.needsWork[${i}].fix empty`);
    checkOptionalQuote(n.quote, `${at}.needsWork[${i}].quote`);
  }
}

function validateLevel(vm) {
  const l = vm.level;
  if (l === undefined || l === null) return;
  const at = `week ${vm.weekId}: level`;
  if (typeof l !== "object") fail(`${at} must be an object`);
  if (!BANDS.includes(l.overall)) fail(`${at}.overall invalid band ${JSON.stringify(l.overall)}`);
  if (l.bandIndex !== bandIndexOf(l.overall)) fail(`${at}.bandIndex does not match overall`);
  if (!CONFIDENCE_LEVELS.includes(l.confidence)) fail(`${at}.confidence invalid`);
  if (!Array.isArray(l.dimensions) || l.dimensions.length !== LEVEL_DIMENSIONS.length) {
    fail(`${at}.dimensions must list exactly the ${LEVEL_DIMENSIONS.length} canonical dimensions`);
  }
  l.dimensions.forEach((d, i) => {
    const dat = `${at}.dimensions[${i}]`;
    if (!d || d.name !== LEVEL_DIMENSIONS[i]) fail(`${dat}.name must be "${LEVEL_DIMENSIONS[i]}" (canonical order)`);
    if (!BANDS.includes(d.band)) fail(`${dat}.band invalid band`);
    if (d.bandIndex !== bandIndexOf(d.band)) fail(`${dat}.bandIndex does not match band`);
    if (typeof d.evidence !== "string") fail(`${dat}.evidence must be a string`);
  });
  if (!isNonEmptyString(l.summary)) fail(`${at}.summary empty`);
  if (!Array.isArray(l.advice) || l.advice.length > LEVEL_ADVICE_MAX) {
    fail(`${at}.advice must be an array of at most ${LEVEL_ADVICE_MAX}`);
  }
  for (const [i, a] of l.advice.entries()) {
    if (!a || !isNonEmptyString(a.title)) fail(`${at}.advice[${i}].title empty`);
    if (!isNonEmptyString(a.detail)) fail(`${at}.advice[${i}].detail empty`);
  }
}

function validatePlan(vm) {
  const p = vm.plan;
  if (p === undefined || p === null) return;
  const at = `week ${vm.weekId}: plan`;
  if (typeof p !== "object") fail(`${at} must be an object`);
  if (!isNonEmptyString(p.weekLabel)) fail(`${at}.weekLabel empty`);
  if (!isNonEmptyString(p.focus)) fail(`${at}.focus empty`);
  if (!Array.isArray(p.items) || p.items.length === 0) fail(`${at}.items must be a non-empty array`);
  for (const [i, it] of p.items.entries()) {
    if (!it || !PLAN_DAYS.includes(it.day)) fail(`${at}.items[${i}].day invalid`);
    if (!isNonEmptyString(it.task)) fail(`${at}.items[${i}].task empty`);
    if (typeof it.why !== "string") fail(`${at}.items[${i}].why must be a string`);
  }
  if (!Array.isArray(p.askTutor)) fail(`${at}.askTutor must be an array`);
  for (const [i, a] of p.askTutor.entries()) {
    if (!isNonEmptyString(a)) fail(`${at}.askTutor[${i}] empty`);
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
 * section total (renderedGrammar — EVERY row, anchored + transcript-derived) so header ==
 * section == badge (beta finding 4); and (b) the raw Cambly-reported Σ anchor kept in
 * integrity.reportedCorrections equals anchoredGrammar (rows WITH a correctionId) +
 * vocab(fromCorrectionId) + phrasing(fromCorrectionId) — no correction lost or invented.
 * Derived rows (correctionId null) sit outside Σ. A doctored integrity{} block that
 * disagrees with the recomputed breakdown aborts. Returns the facts (reported = the raw Σ
 * anchor).
 */
export function assertSigma(vm) {
  const items = (vm.grammarGroups || []).flatMap((g) => (Array.isArray(g.items) ? g.items : []));
  const renderedGrammar = items.length;
  const anchoredGrammar = items.filter(
    (it) => it && it.correctionId !== null && it.correctionId !== undefined,
  ).length;
  const derivedGrammar = renderedGrammar - anchoredGrammar;
  const renderedVocab = (vm.vocabulary || []).filter(
    (v) => v.fromCorrectionId !== null && v.fromCorrectionId !== undefined,
  ).length;
  const renderedPhrasing = (vm.phrasing || []).filter(
    (p) => p.fromCorrectionId !== null && p.fromCorrectionId !== undefined,
  ).length;
  const sum = anchoredGrammar + renderedVocab + renderedPhrasing;

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
        `anchored grammar ${anchoredGrammar} + vocab ${renderedVocab} + phrasing ${renderedPhrasing} = ${sum}`,
    );
  }
  if (integ && typeof integ === "object") {
    const drift =
      (integ.renderedGrammar !== undefined && integ.renderedGrammar !== renderedGrammar) ||
      (integ.derivedGrammar !== undefined && integ.derivedGrammar !== derivedGrammar) ||
      (integ.renderedVocab !== undefined && integ.renderedVocab !== renderedVocab) ||
      (integ.renderedPhrasing !== undefined && integ.renderedPhrasing !== renderedPhrasing);
    if (drift) fail(`week ${vm.weekId}: doctored integrity{} block does not match rendered counts`);
  }
  return { reported, renderedGrammar, anchoredGrammar, derivedGrammar, renderedVocab, renderedPhrasing, sum };
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
