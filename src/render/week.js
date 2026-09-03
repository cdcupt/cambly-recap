// src/render/week.js — week page assembly (F1 · F4): head boot script, stale
// banner, header + stat band, sticky chip nav, the content sections, footer nav.
// The sections a week renders — and their "0N" numbers — derive from what the VM
// carries: Review · Level · Classes · Vocabulary · Grammar · Phrasing · Practice ·
// Plan, with the three v2 blocks (review / level / plan) optional. An older VM
// renders exactly the five legacy sections as 01..05. The reveal mechanic is
// shipped only when the week actually has practice cards.

import { esc } from "./esc.js";
import { publishedLabel, pluralize } from "./dates.js";
import { htmlDocument } from "./layout.js";
import { REVEAL } from "./script.js";
import {
  banner,
  statBand,
  chipNav,
  sectionsFor,
  classesSection,
  vocabSection,
  grammarSection,
  phrasingSection,
  practiceSection,
  footerNav,
  weekLabelSpan,
} from "./components.js";
import { reviewSection, levelSection, planSection } from "./sections.js";

const MDOT = "·";
const LARR = "←";

function buildResolver(vm) {
  const byId = new Map();
  for (const c of vm.classes || []) byId.set(c.lessonId, c);
  return {
    startAt: (id) => (byId.has(id) ? byId.get(id).startAt : null),
    tutor: (id) => (byId.has(id) ? byId.get(id).tutor : null),
  };
}

const hasText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * The header's "with …" tutor phrase. Named tutors are listed once each; classes whose
 * tutor is unknown (empty string) are counted honestly as "N other tutor(s)" rather than
 * silently dropped — "5 classes with Niki V. and 1 other tutor". No "with" at all when
 * no class names a tutor.
 */
function withTutors(classes) {
  const named = [...new Set(classes.map((c) => c.tutor).filter(hasText))];
  if (named.length === 0) return "";
  const unnamed = classes.filter((c) => !hasText(c.tutor)).length;
  const others = unnamed ? ` and ${unnamed} other ${pluralize(unnamed, "tutor", "tutors")}` : "";
  return ` with ${esc(named.join(", "))}${others}`;
}

function headerBlock(vm) {
  const classes = vm.classes || [];
  const n = classes.length;
  const sub =
    `${n} ${pluralize(n, "class", "classes")}${withTutors(classes)} ${MDOT} ` +
    `published ${esc(publishedLabel(vm.publishedAt))} ${MDOT} ` +
    `<a class="backlink" href="../index.html">${LARR} All weeks</a>`;
  return (
    `<header class="pad">` +
    `<span class="eyebrow">● Weekly recap</span>` +
    `<h1>Week of <span class="accent">${weekLabelSpan(vm.weekLabel)}</span></h1>` +
    `<p class="sub">${sub}</p>` +
    statBand(vm.stats) +
    `</header>`
  );
}

/** The section renderers keyed like SECTION_DEFS; each receives its sequential "0N". */
function sectionRenderers(vm, resolve) {
  return {
    review: (num) => reviewSection(vm, resolve, num),
    level: (num) => levelSection(vm, num),
    classes: (num) => classesSection(vm.classes, num),
    vocab: (num) => vocabSection(vm.vocabulary, resolve, num),
    grammar: (num) => grammarSection(vm.grammarGroups, resolve, num),
    phrasing: (num) => phrasingSection(vm.phrasing, resolve, num),
    practice: (num) => practiceSection(vm.practice, resolve, num),
    plan: (num) => planSection(vm, num),
  };
}

/**
 * Render a full week page to an HTML string.
 * @param {object} vm - a validated, Σ-checked non-empty WeekVM
 * @param {{siteState?:object, prev?:{weekId,weekLabel}|null, next?:{weekId,weekLabel}|null}} [ctx]
 */
export function renderWeek(vm, { siteState = {}, prev = null, next = null } = {}) {
  const resolve = buildResolver(vm);
  const hasPractice = Array.isArray(vm.practice) && vm.practice.length > 0;
  const render = sectionRenderers(vm, resolve);
  const main = sectionsFor(vm)
    .map((s) => render[s.key](s.num))
    .join("");

  const body =
    banner(siteState) +
    headerBlock(vm) +
    chipNav(vm) +
    `<main>${main}</main>` +
    footerNav(prev, next);

  return htmlDocument({
    title: `Week of ${esc(vm.weekLabel)} · Cambly Recap`,
    bodyClass: "mk",
    body,
    script: hasPractice ? REVEAL : "",
  });
}
