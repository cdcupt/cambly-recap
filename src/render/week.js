// src/render/week.js — week page assembly (F1 · F4): head boot script, stale
// banner, header + stat band, sticky chip nav, the six content blocks (five
// sections; the class log is section 01), footer nav. The reveal mechanic is
// shipped only when the week actually has practice cards.

import { esc } from "./esc.js";
import { publishedLabel, pluralize } from "./dates.js";
import { htmlDocument } from "./layout.js";
import { REVEAL } from "./script.js";
import {
  banner,
  statBand,
  chipNav,
  classesSection,
  vocabSection,
  grammarSection,
  phrasingSection,
  practiceSection,
  footerNav,
} from "./components.js";

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

function headerBlock(vm) {
  const classes = vm.classes || [];
  const n = classes.length;
  const tutors = [...new Set(classes.map((c) => c.tutor).filter(Boolean))];
  const withTutors = tutors.length ? ` with ${esc(tutors.join(", "))}` : "";
  const sub =
    `${n} ${pluralize(n, "class", "classes")}${withTutors} ${MDOT} ` +
    `published ${esc(publishedLabel(vm.publishedAt))} ${MDOT} ` +
    `<a class="backlink" href="../index.html">${LARR} All weeks</a>`;
  return (
    `<header class="pad">` +
    `<span class="eyebrow">● Weekly recap</span>` +
    `<h1>Week of <span class="accent">${esc(vm.weekLabel)}</span></h1>` +
    `<p class="sub">${sub}</p>` +
    statBand(vm.stats) +
    `</header>`
  );
}

/**
 * Render a full week page to an HTML string.
 * @param {object} vm - a validated, Σ-checked non-empty WeekVM
 * @param {{siteState?:object, prev?:{weekId,weekLabel}|null, next?:{weekId,weekLabel}|null}} [ctx]
 */
export function renderWeek(vm, { siteState = {}, prev = null, next = null } = {}) {
  const resolve = buildResolver(vm);
  const hasPractice = Array.isArray(vm.practice) && vm.practice.length > 0;

  const body =
    banner(siteState) +
    headerBlock(vm) +
    chipNav() +
    `<main>` +
    classesSection(vm.classes) +
    vocabSection(vm.vocabulary, resolve) +
    grammarSection(vm.grammarGroups, resolve) +
    phrasingSection(vm.phrasing, resolve) +
    practiceSection(vm.practice, resolve) +
    `</main>` +
    footerNav(prev, next);

  return htmlDocument({
    title: `Week of ${esc(vm.weekLabel)} · Cambly Recap`,
    bodyClass: "mk",
    body,
    script: hasPractice ? REVEAL : "",
  });
}
