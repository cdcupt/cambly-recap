// src/render/components.js — the component inventory (F3), one function per
// mockup component: stale banner · stat band · chip nav · class card · vocab
// entry · grammar group · phrasing card · practice card/section · index row ·
// week footer. Every dynamic value goes through esc() (or a whitelisted transform
// from esc.js); the DOM shapes reproduce docs/DESIGN.html's live mockup.
//
// Section numbering is DYNAMIC (recap v2): the chip nav and every "0N" section
// number derive from `sectionsFor(vm)` — only the sections a week actually carries,
// numbered sequentially in the fixed page order Review · Level · Classes ·
// Vocabulary · Grammar · Phrasing · Practice · Plan. An older VM (no review / level /
// plan) therefore renders exactly the five legacy sections as 01..05.

import {
  esc,
  renderMoment,
  renderPrompt,
  renderAnswer,
} from "./esc.js";
import {
  dateLabel,
  dayChipUpper,
  weekdayShort,
  expiryLabel,
  pluralize,
} from "./dates.js";
import { displayTopic } from "./text.js";

const ARR = "→"; // →
const MDOT = "·"; // ·
const LQUO = "“"; // “
const RQUO = "”"; // ”
const EMDASH = "—"; // —
const LARR = "←"; // ←

const isBlock = (v) => v !== null && v !== undefined && typeof v === "object";

/**
 * The eight possible recap sections in page order. `present(vm)` decides whether a
 * week carries the section; the five legacy sections are always present.
 */
export const SECTION_DEFS = Object.freeze([
  { key: "review", id: "m-review", chip: "Review", present: (vm) => isBlock(vm && vm.review) },
  { key: "level", id: "m-level", chip: "Level", present: (vm) => isBlock(vm && vm.level) },
  { key: "classes", id: "m-classes", chip: "Classes", present: () => true },
  { key: "vocab", id: "m-vocab", chip: "Vocabulary", present: () => true },
  { key: "grammar", id: "m-grammar", chip: "Grammar", present: () => true },
  { key: "phrasing", id: "m-phrasing", chip: "Phrasing", present: () => true },
  { key: "practice", id: "m-practice", chip: "Practice", present: () => true },
  { key: "plan", id: "m-plan", chip: "Plan", present: (vm) => isBlock(vm && vm.plan) },
]);

/** Zero-padded two-digit section number ("01".."08"). */
export function sectionNum(i) {
  return String(i + 1).padStart(2, "0");
}

/**
 * The sections a week renders, in page order, each with its sequential number.
 * @param {object} vm
 * @returns {{key:string,id:string,chip:string,num:string}[]}
 */
export function sectionsFor(vm) {
  return SECTION_DEFS.filter((s) => s.present(vm)).map((s, i) => ({
    key: s.key,
    id: s.id,
    chip: s.chip,
    num: sectionNum(i),
  }));
}

/**
 * Stale-auth banner (F3 · F7). Rendered above the header on EVERY page whenever
 * siteState.authStale — role="alert", amber wash, the expiry date and the two
 * recovery steps rendered verbatim as <code>. Returns "" when the session is
 * healthy so no banner markup exists anywhere (U-RN-④).
 */
export function banner(siteState) {
  if (!siteState || siteState.authStale !== true) return "";
  const when = expiryLabel(siteState.authStaleSince);
  const cmds = Array.isArray(siteState.recoveryCommands)
    ? siteState.recoveryCommands
    : [];
  const codes = cmds.map((c) => `<code>${esc(c)}</code>`);
  const fix =
    codes.length === 2 ? `${codes[0]} then ${codes[1]}` : codes.join(" ");
  return (
    `<div class="banner" role="alert">` +
    `<b>⚠ Cambly session expired${when ? ` ${esc(when)}` : ""}</b>` +
    ` Recaps are paused; the archive below stays readable. Fix: ` +
    `${fix}. Missed weeks backfill automatically.</div>`
  );
}

/** Week header stat band — the four precomputed, deterministic numbers (F3). */
export function statBand(stats) {
  const s = stats || {};
  const cell = (n, l) =>
    `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${l}</div></div>`;
  return (
    `<div class="stats">` +
    cell(s.classes ?? 0, "classes") +
    cell(s.minutes ?? 0, "minutes") +
    cell(s.corrections ?? 0, "corrections") +
    cell(s.expressions ?? 0, "expressions") +
    `</div>`
  );
}

/** Sticky chip nav — plain anchors (jump links) for exactly the sections this week renders. */
export function chipNav(vm) {
  const links = sectionsFor(vm || {})
    .map((s) => `<a href="#${s.id}">${s.chip}</a>`)
    .join("");
  return `<nav class="chips" aria-label="Recap sections">${links}</nav>`;
}

/** `<h2><span class="num">0N</span>Title</h2>` + the optional muted sub-line. */
export function sectionHead(num, title, ssub) {
  return (
    `<h2><span class="num">${esc(num)}</span>${title}</h2>` +
    (ssub ? `<p class="ssub">${ssub}</p>` : "")
  );
}

function emptyNote(msg) {
  return `<p class="empty-note">${msg}</p>`;
}

const hasText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Per-class "Focus & tutor feedback" block (§10 tutorFocus). Surfaces Cambly's OWN
 * coaching text — the AI coach summary, the coach's "work on" note, the tutor's note
 * with its Chinese translation as a secondary line, and a prominent "Next focus" chip.
 * Every field is nullable and each present one is escaped (tutor/learner content, not
 * markup). Returns "" when tutorFocus is null or carries no usable text, so older
 * lessons render no block and the section collapses cleanly.
 */
export function focusBlock(tf) {
  if (!tf || typeof tf !== "object") return "";
  const parts = [];
  if (hasText(tf.aiFeedback)) {
    parts.push(`<p class="fai">${esc(tf.aiFeedback)}</p>`);
  }
  if (hasText(tf.workOn)) {
    parts.push(`<p class="fwork"><b>Work on</b>${esc(tf.workOn)}</p>`);
  }
  if (hasText(tf.tutorNotes) || hasText(tf.tutorNotesZh)) {
    const en = hasText(tf.tutorNotes)
      ? `<p class="en">${esc(tf.tutorNotes)}</p>`
      : "";
    const zh = hasText(tf.tutorNotesZh)
      ? `<p class="zh">${esc(tf.tutorNotesZh)}</p>`
      : "";
    parts.push(`<div class="fnote">${en}${zh}</div>`);
  }
  if (hasText(tf.nextFocus)) {
    parts.push(
      `<p class="fnext"><b>Next focus</b><span>${esc(tf.nextFocus)}</span></p>`,
    );
  }
  if (parts.length === 0) return "";
  return (
    `<div class="focus">` +
    `<div class="fhead">Focus &amp; tutor feedback</div>` +
    parts.join("") +
    `</div>`
  );
}

/**
 * One class card: an eyebrow line (day · minutes · "with <tutor>"), the title-or-topic as
 * the card HEADLINE (h3.ctitle — ink, sentence case; never the small-caps caption, which
 * would undo displayTopic()'s sentence-case softening), teal stat chips, the moment, the
 * optional note, the focus block. The LLM title (set by the builder only for a generic
 * topic) takes precedence over the topic; both go through displayTopic(). With neither,
 * the card carries the `nohead` class so the date steps back up to the headline role.
 */
export function classCard(cls) {
  const c = cls || {};
  const st = c.stats || {};
  const chips = [
    `${esc(st.wpm ?? 0)} wpm`,
    `${esc(st.talkPct ?? 0)}% talk`,
    `${esc(st.words ?? 0)} words`,
    // Per-lesson raw corrective-feedback count (stats.fixes, lesson-derived per §10). Labelled
    // "flagged" — NOT "fixes" — so it never reads as the same number as the header/index/grammar
    // "fixes", which count only rendered grammar (excludes corrections re-homed as vocab/phrasing).
    `${esc(st.fixes ?? 0)} flagged`,
  ]
    .map((t) => `<i>${t}</i>`)
    .join("");
  const moment =
    c.moment && typeof c.moment.text === "string"
      ? `<p class="moment">${renderMoment(c.moment.text)}</p>`
      : "";
  const note =
    c.tutorNote !== null && c.tutorNote !== undefined && c.tutorNote !== ""
      ? `<p class="tnote">${esc(c.tutorNote)}</p>`
      : "";
  const about = displayTopic(hasText(c.title) ? c.title : c.topic);
  const withTutor = hasText(c.tutor) ? ` ${MDOT} with ${esc(c.tutor)}` : "";
  const headline = about ? `<h3 class="ctitle">${esc(about)}</h3>` : "";
  return (
    `<article class="ccard${about ? "" : " nohead"}">` +
    `<div class="day"><b>${esc(dateLabel(c.startAt))}</b>` +
    `<span>${esc(c.minutes ?? 0)} min${withTutor}</span></div>` +
    headline +
    `<div class="cstats">${chips}</div>` +
    moment +
    note +
    focusBlock(c.tutorFocus) +
    `</article>`
  );
}

/** The classes section. A non-empty week always has ≥1 class. */
export function classesSection(classes, num = "01") {
  const list = Array.isArray(classes) ? classes : [];
  const title = "The class log";
  const ssub = list.length
    ? "What each conversation was about — and the moment worth keeping."
    : "";
  const body = list.length
    ? list.map(classCard).join("")
    : emptyNote("No classes this week.");
  return `<section id="m-classes" class="pad">${sectionHead(num, title, ssub)}${body}</section>`;
}

/**
 * One vocab entry: term · meaning · day chip · the optional verbatim quote line — or,
 * when no clean quote survived but the summarizer supplied a model sentence, an
 * "e.g. …" line instead (never both).
 */
export function vocabItem(v, resolve) {
  const day = dayChipUpper(resolve.startAt(v.lessonId));
  const chip = day ? `<i class="daychip">${day}</i>` : "";
  const head =
    `<div class="w"><b>${esc(v.term)}</b><em>${esc(v.meaning)}</em>${chip}</div>`;
  // The example sentence is optional (finding 5): render the quote line only when a real
  // usage quote survived the guard; otherwise the word shows with its meaning + day, plus
  // the LLM's model sentence when the builder kept one (RULE 8).
  if (!hasText(v.quote)) {
    const eg = hasText(v.example) ? `<p class="veg">e.g. ${esc(v.example)}</p>` : "";
    return `<div class="vword">${head}${eg}</div>`;
  }
  const tutor = resolve.tutor(v.lessonId);
  const attribution =
    v.quoteBy === "tutor" && tutor ? ` ${EMDASH} ${esc(tutor)}` : "";
  return (
    `<div class="vword">${head}` +
    `<p class="vq">${LQUO}${esc(v.quote)}${RQUO}${attribution}</p></div>`
  );
}

/** The vocabulary section. */
export function vocabSection(vocabulary, resolve, num = "02") {
  const list = Array.isArray(vocabulary) ? vocabulary : [];
  const title = "Vocabulary of the week";
  const ssub = list.length
    ? "Words that came up in your classes — some with the real sentence they appeared in, on the ones where we caught a clean example."
    : "";
  const body = list.length
    ? list.map((v) => vocabItem(v, resolve)).join("")
    : emptyNote("No new vocabulary this week.");
  return `<section id="m-vocab" class="pad">${sectionHead(num, title, ssub)}${body}</section>`;
}

const isDerived = (item) => item && item.derived === true;

/**
 * One correction row: strikethrough said → bold fix, why + day suffix. A transcript-
 * derived row (spotted by the recap, not flagged by Cambly) carries a small source tag.
 */
function corrRow(item, resolve) {
  const day = weekdayShort(resolve.startAt(item.lessonId));
  const suffix = day ? ` ${MDOT} ${day}` : "";
  const src = isDerived(item) ? `<i class="src">transcript</i>` : "";
  return (
    `<div class="corr"><span class="said">${esc(item.said)}</span> ` +
    `<span class="arr">${ARR}</span> <span class="fix">${esc(item.fix)}</span>${src}` +
    `<span class="why">${esc(item.why)}${suffix}</span></div>`
  );
}

// A grammar group shows all items when ≤3; past that it previews the first two
// and collapses the rest behind a native <details> "Show n more" (mockup F3).
const GRAMMAR_PREVIEW = 2;

/** One grammar group: pattern + count badge, optional rule line, corr rows. */
export function grammarGroup(group, resolve) {
  const g = group || {};
  const items = Array.isArray(g.items) ? g.items : [];
  const collapse = items.length > 3;
  const visible = collapse ? items.slice(0, GRAMMAR_PREVIEW) : items;
  const hidden = collapse ? items.slice(GRAMMAR_PREVIEW) : [];
  const rule =
    g.rule !== null && g.rule !== undefined && g.rule !== ""
      ? `<p class="rule">${esc(g.rule)}</p>`
      : "";
  const visibleRows = visible.map((it) => corrRow(it, resolve)).join("");
  const more = hidden.length
    ? `<details class="more"><summary>Show ${hidden.length} more</summary>` +
      hidden.map((it) => corrRow(it, resolve)).join("") +
      `</details>`
    : "";
  return (
    `<div class="grp"><h3>${esc(g.pattern)} <span class="cnt">${items.length}</span></h3>` +
    rule +
    visibleRows +
    more +
    `</div>`
  );
}

/**
 * Grammar sub-line: "N fixes — K flagged by Cambly · M spotted in your transcript, grouped
 * into G habits." When every row is Cambly-anchored the legacy sentence is kept verbatim
 * (no breakdown to show); when every row is derived, the sub-line says so.
 */
function grammarSsub(groups, itemCount, derivedCount) {
  const anchored = itemCount - derivedCount;
  const habits = `${groups.length} ${pluralize(groups.length, "habit", "habits")}`;
  const fixes = `${itemCount} grammar ${pluralize(itemCount, "fix", "fixes")}`;
  if (derivedCount === 0) {
    return `All ${fixes} from the week, grouped into ${habits}. Strike = what you said.`;
  }
  const parts = [];
  if (anchored > 0) parts.push(`${anchored} flagged by Cambly`);
  parts.push(`${derivedCount} spotted in your transcript`);
  return `${fixes} ${EMDASH} ${parts.join(` ${MDOT} `)}, grouped into ${habits}. Strike = what you said.`;
}

/** The grammar section — corrections grouped into habits. */
export function grammarSection(grammarGroups, resolve, num = "03") {
  const groups = Array.isArray(grammarGroups) ? grammarGroups : [];
  const items = groups.flatMap((g) => (Array.isArray(g.items) ? g.items : []));
  const derivedCount = items.filter(isDerived).length;
  const title = "Grammar corrections";
  const ssub = groups.length ? grammarSsub(groups, items.length, derivedCount) : "";
  const body = groups.length
    ? groups.map((g) => grammarGroup(g, resolve)).join("")
    : emptyNote("No grammar corrections this week.");
  return `<section id="m-grammar" class="pad">${sectionHead(num, title, ssub)}${body}</section>`;
}

/** One phrasing card: "You said …" → the native version → why. */
export function phrasingItem(p, resolve) {
  const day = dayChipUpper(resolve.startAt(p.lessonId));
  const chip = day ? ` <i class="daychip">${day}</i>` : "";
  return (
    `<div class="up"><div class="from">You said: <q>${esc(p.said)}</q>${chip}</div>` +
    `<div class="to">${ARR} ${LQUO}${esc(p.better)}${RQUO} ` +
    `<span class="why">${esc(p.why)}</span></div></div>`
  );
}

/** The phrasing-upgrades section. */
export function phrasingSection(phrasing, resolve, num = "04") {
  const list = Array.isArray(phrasing) ? phrasing : [];
  const title = "Phrasing upgrades";
  const ssub = list.length
    ? "Correct-ish → what a native would actually say."
    : "";
  const body = list.length
    ? list.map((p) => phrasingItem(p, resolve)).join("")
    : emptyNote("No phrasing upgrades this week.");
  return `<section id="m-phrasing" class="pad">${sectionHead(num, title, ssub)}${body}</section>`;
}

/** One practice card — the whole face is one native tap-to-reveal button. */
export function practiceCard(item, idx, resolve) {
  const it = item || {};
  const n = idx + 1;
  const paId = `pa${n}`;
  const day = dayChipUpper(resolve.startAt(it.lessonId));
  const format = String(it.format || "").replace(/_/g, " ");
  const tag = day ? `${format} ${MDOT} ${day}` : format;
  return (
    `<article class="pcard">` +
    `<button class="pq" aria-expanded="false" aria-controls="${paId}">` +
    `<span class="ptag">${esc(tag)}</span>` +
    `<span class="ptext">${renderPrompt(it.prompt, it.cue)}</span>` +
    `<span class="phint">Tap to reveal</span>` +
    `</button>` +
    `<div class="pa" id="${paId}" hidden>` +
    `<div class="ans">${renderAnswer(it.answer)}</div>` +
    `<p class="why">Why: ${esc(it.why)}</p></div>` +
    `</article>`
  );
}

/**
 * The practice section. The progress row (aria-live text + decorative bar) and the
 * reveal-all button render only when there are cards; a zero-item practice section
 * keeps its heading and collapses to one muted line.
 */
export function practiceSection(practice, resolve, num = "05") {
  const list = Array.isArray(practice) ? practice : [];
  const n = list.length;
  const head = `<h2><span class="num">${esc(num)}</span>Practice — tap to reveal</h2>`;
  let body;
  if (n === 0) {
    body = emptyNote("No practice drills this week.");
  } else {
    const cards = list
      .map((it, i) => practiceCard(it, i, resolve))
      .join("");
    body =
      `<p class="ssub" style="margin-bottom:2px">Say the full correct sentence <b>out loud</b> first. ` +
      `Then tap to check. All ${n} come from this week's real errors.</p>` +
      `<div class="prog"><p class="ptxt" id="ptxt" aria-live="polite">0 of ${n} revealed</p>` +
      `<div class="pbar" aria-hidden="true"><i id="pfill"></i></div></div>` +
      cards +
      `<button class="pall" id="revealall">Reveal all (review mode)</button>`;
  }
  return `<section id="m-practice" class="pad"><div class="practice">${head}${body}</div></section>`;
}

/** Week footer nav — prev · All weeks · next, prev/next already skip empty weeks. */
export function footerNav(prev, next) {
  const slot = (w, isNext) => {
    if (!w) return `<span class="gap" aria-hidden="true"></span>`;
    const label = `Week of ${esc(w.weekLabel)}`;
    const text = isNext ? `${label} ${ARR}` : `${LARR} ${label}`;
    return `<a href="${esc(w.weekId)}.html">${text}</a>`;
  };
  return (
    `<footer class="wknav">` +
    slot(prev, false) +
    `<a href="../index.html">All weeks</a>` +
    slot(next, true) +
    `</footer>`
  );
}

/**
 * One index archive row. Empty weeks are a non-clickable <span> (honest
 * semantics — the sanctioned deviation from the mockup's <a role="presentation">).
 * The latest non-empty week gets the accent border + ● NEW badge.
 */
export function indexRow(week, { isLatest = false } = {}) {
  const w = week || {};
  const label = `Week of ${esc(w.weekLabel)}`;
  if (w.isEmpty === true) {
    return (
      `<li class="empty"><span class="wrow"><span class="wl">` +
      `<b>${label} ${EMDASH} no classes this week</b></span></span></li>`
    );
  }
  const s = w.stats || {};
  const classes = s.classes ?? 0;
  const minutes = s.minutes ?? 0;
  const corrections = s.corrections ?? 0;
  const badge = isLatest ? `<span class="new">NEW</span>` : "";
  const sub = `${classes} ${pluralize(classes, "class", "classes")} ${MDOT} ${minutes} min`;
  // A zero-fix week is a clean week, not a low score — reframe the pill so "0" never
  // reads as scoring zero of a good thing; non-zero weeks keep the honest "N fixes".
  const pill =
    corrections === 0
      ? "Clean week ✓"
      : `${corrections} ${pluralize(corrections, "fix", "fixes")}`;
  const li = isLatest ? `<li class="latest">` : `<li>`;
  return (
    `${li}<a class="wrow" href="weeks/${esc(w.weekId)}.html">` +
    `<span class="wl"><b>${label}${badge}</b><span>${sub}</span></span>` +
    `<span class="wc">${pill}</span></a></li>`
  );
}
