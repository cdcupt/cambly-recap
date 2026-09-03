// src/render/index.js — index (archive) page assembly (F1 · F3 · F7).
//
// Reverse-chron list of every week (empty weeks included, as muted non-clickable
// rows). Masthead totals are summed from the week stats at render time (derive,
// don't store). The ● NEW badge lands on the latest NON-empty week only — if the
// newest week is empty the badge moves back. When exactly one published week
// exists, a first-run intro sentence renders so day one is never an empty shell.
// With two or more published weeks the "Your progress" block (chart.js) sits
// between the first-run slot and the weeks list; its CSS (CHART_STYLES) is inlined
// once in the shared <head> stylesheet by layout.js, after STYLES + SECTION_STYLES.

import { htmlDocument } from "./layout.js";
import { banner, indexRow } from "./components.js";
import { pluralize } from "./dates.js";
import { progressBlock } from "./chart.js";

function totalsBar(weeks) {
  const t = weeks.reduce(
    (a, w) => {
      const s = w.stats || {};
      return {
        classes: a.classes + (s.classes || 0),
        minutes: a.minutes + (s.minutes || 0),
        corrections: a.corrections + (s.corrections || 0),
      };
    },
    { classes: 0, minutes: 0, corrections: 0 },
  );
  const n = weeks.length;
  return (
    `<div class="totals">` +
    `<i>${n} ${pluralize(n, "week", "weeks")}</i>` +
    `<i>${t.classes} ${pluralize(t.classes, "class", "classes")}</i>` +
    `<i>${t.minutes} min</i>` +
    `<i>${t.corrections} ${pluralize(t.corrections, "correction", "corrections")}</i>` +
    `</div>`
  );
}

/**
 * Render the index page to an HTML string.
 * @param {object[]} weeks - all week VMs (empty + non-empty), any order
 * @param {{siteState?:object}} [ctx]
 */
export function renderIndex(weeks, { siteState = {} } = {}) {
  const sorted = [...(weeks || [])].sort((a, b) =>
    a.weekId < b.weekId ? 1 : a.weekId > b.weekId ? -1 : 0,
  ); // reverse-chron (weekId is YYYY-MM-DD)

  const latestNonEmpty = sorted.find((w) => w.isEmpty !== true) || null;
  const nonEmptyCount = sorted.filter((w) => w.isEmpty !== true).length;

  const rows = sorted
    .map((w) => indexRow(w, { isLatest: w === latestNonEmpty }))
    .join("");

  const firstRun =
    nonEmptyCount === 1
      ? `<p class="firstrun pad">Your first recap is live. From now on a new week lands here automatically every Monday.</p>`
      : "";

  // Derived at render time from classes[].stats / stats.minutes; "" below two weeks.
  const progress = progressBlock(sorted);

  const body =
    banner(siteState) +
    `<header class="pad">` +
    `<span class="eyebrow">● Cambly weekly recap</span>` +
    `<h1>Every week,<br><span class="accent">re-learned.</span></h1>` +
    `<p class="sub">Refreshed after each week of classes.</p>` +
    totalsBar(sorted) +
    `</header>` +
    `<main>` +
    firstRun +
    progress +
    `<nav class="pad" aria-label="All weeks"><ul class="weeks">${rows}</ul></nav>` +
    `</main>`;

  return htmlDocument({
    title: "Cambly Weekly Recap",
    bodyClass: "mk ix",
    body,
  });
}
