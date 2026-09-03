// src/render/sections.js — recap v2 week-page sections (the week in review · CEFR level
// estimate · next-week plan) and their CSS. Every dynamic value goes through esc().
// Each section returns "" when its VM block is absent so older weeks render unchanged.
//
// Visual language (from styles.js, reused — nothing invented): warm paper, display serif
// for h2 + the ONE big number on the page (the CEFR band), sans body, 1px soft-line cards
// with 12–16px radii, teal for progress/track/plan, accent for the band and "needs work",
// good-green for "went well". No JavaScript; no decorative pseudo-content — every glyph
// (✓, →) is real markup marked aria-hidden.

import { esc } from "./esc.js";
import { dayChipUpper } from "./dates.js";
import { sectionHead } from "./components.js";
import { BANDS } from "../coach.js";

const MDOT = "·";
const hasText = (v) => typeof v === "string" && v.trim() !== "";
const arr = (v) => (Array.isArray(v) ? v : []);

/** Capitalise the first letter of a dimension name for display ("range" → "Range"). */
function capitalise(s) {
  const t = String(s ?? "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A day chip for a resolvable lessonId, else "". */
function dayChip(resolve, lessonId) {
  if (!resolve || !lessonId) return "";
  const day = dayChipUpper(resolve.startAt(lessonId));
  return day ? ` <i class="daychip">${day}</i>` : "";
}

// ── Review ───────────────────────────────────────────────────────────────────────

/** The optional verbatim quote line under a review item: the <q> and its day chip inline, on one block. */
function quoteLine(item, resolve, extraClass = "") {
  if (!hasText(item.quote)) return "";
  const cls = extraClass ? `rq ${extraClass}` : "rq";
  return `<span class="rql"><q class="${cls}">${esc(item.quote)}</q>${dayChip(resolve, item.lessonId)}</span>`;
}

function wentWellCard(points, resolve) {
  if (!points.length) return "";
  const rows = points
    .map(
      (w) =>
        `<li><i class="ck" aria-hidden="true">✓</i><div><span class="pt">${esc(w.point)}</span>${quoteLine(w, resolve)}</div></li>`,
    )
    .join("");
  return `<div class="rvcard good"><h3>What went well</h3><ul>${rows}</ul></div>`;
}

function needsWorkCard(items, resolve) {
  if (!items.length) return "";
  const rows = items
    .map(
      (n) =>
        `<li><b class="iss">${esc(n.issue)}</b>${quoteLine(n, resolve, "bad")}` +
        `<span class="fx"><i aria-hidden="true">→</i> ${esc(n.fix)}</span></li>`,
    )
    .join("");
  return `<div class="rvcard work"><h3>What needs work</h3><ul>${rows}</ul></div>`;
}

/**
 * Section — "The week in review" (vm.review): the summary as a serif lead paragraph, then
 * a two-column band (stacked on mobile) of "What went well" / "What needs work" cards.
 * Returns "" when vm.review is absent.
 * @param {object} vm
 * @param {{startAt:(id:string)=>string|null}} resolve lessonId → class startAt (day chips)
 * @param {string} [num] the section's "0N" number
 */
export function reviewSection(vm, resolve, num = "01") {
  const r = vm && vm.review;
  if (!r || typeof r !== "object") return "";
  const lead = hasText(r.summary) ? `<p class="lead">${esc(r.summary)}</p>` : "";
  const cards = wentWellCard(arr(r.wentWell), resolve) + needsWorkCard(arr(r.needsWork), resolve);
  const grid = cards ? `<div class="rvgrid">${cards}</div>` : "";
  return (
    `<section id="m-review" class="pad">` +
    sectionHead(num, "The week in review", "") +
    lead +
    grid +
    `</section>`
  );
}

// ── Level ────────────────────────────────────────────────────────────────────────

/** The 7-cell segmented track; cells up to bandIndex filled, the reached cell names the band for AT. */
function bandTrack(bandIndex, band) {
  const cells = BANDS.map((_, i) => {
    if (i === bandIndex) return `<i class="on hit"><span class="sr">${esc(band)}</span></i>`;
    return i < bandIndex ? `<i class="on"></i>` : `<i></i>`;
  }).join("");
  return `<span class="track">${cells}</span>`;
}

function dimensionRow(d) {
  return (
    `<li class="dim"><span class="dname">${esc(capitalise(d.name))}</span>` +
    bandTrack(d.bandIndex, d.band) +
    `<span class="dband" aria-hidden="true">${esc(d.band)}</span>` +
    (hasText(d.evidence) ? `<span class="dev">${esc(d.evidence)}</span>` : "") +
    `</li>`
  );
}

function adviceList(advice) {
  if (!advice.length) return "";
  const rows = advice
    .map((a, i) => `<li><i class="an" aria-hidden="true">${i + 1}</i><div><b>${esc(a.title)}</b><span>${esc(a.detail)}</span></div></li>`)
    .join("");
  return `<h3 class="lvh3">To reach the next band</h3><ol class="advice">${rows}</ol>`;
}

const LEVEL_FOOTNOTE =
  "Estimated from this week's spontaneous speech only (read-aloud passages excluded). Not an official test result.";

/**
 * Section — "Level estimate" (vm.level, CEFR): a hero card with the band as the page's one
 * big number, the five-dimension track strip, the numbered advice and the footnote.
 * Returns "" when vm.level is absent.
 * @param {object} vm
 * @param {string} [num] the section's "0N" number
 */
export function levelSection(vm, num = "02") {
  const l = vm && vm.level;
  if (!l || typeof l !== "object") return "";
  const eyebrow = `Estimated CEFR level ${MDOT} ${esc(l.confidence)} confidence`;
  const hero =
    `<div class="lvhero">` +
    `<span class="lveye">${eyebrow}</span>` +
    `<span class="lvbig">${esc(l.overall)}</span>` +
    (hasText(l.summary) ? `<p class="lvsum">${esc(l.summary)}</p>` : "") +
    `</div>`;
  const dims = arr(l.dimensions);
  const strip = dims.length ? `<ul class="dims">${dims.map(dimensionRow).join("")}</ul>` : "";
  return (
    `<section id="m-level" class="pad">` +
    sectionHead(num, "Level estimate", "Where your spoken English sat this week, on the CEFR scale.") +
    hero +
    strip +
    adviceList(arr(l.advice)) +
    `<p class="lvfoot">${LEVEL_FOOTNOTE}</p>` +
    `</section>`
  );
}

// ── Plan ─────────────────────────────────────────────────────────────────────────

function planItem(it) {
  const day = String(it.day ?? "").toUpperCase();
  const why = hasText(it.why) ? `<span class="pwhy">${esc(it.why)}</span>` : "";
  return `<li><i class="daychip">${esc(day)}</i><div><span class="task">${esc(it.task)}</span>${why}</div></li>`;
}

function askList(asks) {
  if (!asks.length) return "";
  const rows = asks.map((a) => `<li><i class="daychip askc">ASK</i><span>${esc(a)}</span></li>`).join("");
  return `<h3 class="askh">Ask your tutor next class</h3><ul class="ask">${rows}</ul>`;
}

/**
 * Section — "Plan for the week of <weekLabel>" (vm.plan): the focus line, the day-chipped
 * checklist and the "Ask your tutor" rows, framed in one teal-wash card (the mirror of
 * the practice frame). Returns "" when vm.plan is absent.
 * @param {object} vm
 * @param {string} [num] the section's "0N" number
 */
export function planSection(vm, num = "08") {
  const p = vm && vm.plan;
  if (!p || typeof p !== "object") return "";
  const title = `Plan for the week of ${esc(p.weekLabel)}`;
  const focus = hasText(p.focus) ? `<p class="pfocus">${esc(p.focus)}</p>` : "";
  const items = arr(p.items);
  const list = items.length ? `<ul class="plan">${items.map(planItem).join("")}</ul>` : "";
  return (
    `<section id="m-plan" class="pad"><div class="planbox">` +
    `<h2><span class="num">${esc(num)}</span>${title}</h2>` +
    `<p class="ssub">Ten to twenty minutes a day, built from this week's real material.</p>` +
    focus +
    list +
    askList(arr(p.askTutor).filter(hasText)) +
    `</div></section>`
  );
}

// ── CSS (scoped under .mk; appended after STYLES, before CHART_STYLES) ──────────────

export const SECTION_STYLES = `
/* ----- recap v2: review ----- */
.mk .lead{font-family:var(--disp);font-size:1.02rem;line-height:1.5;color:var(--mink);margin:6px 0 14px}
.mk .rvgrid{display:grid;gap:10px;margin:0 0 6px}
.mk .rvcard{background:var(--surface);border:1px solid var(--mline-soft);border-radius:14px;padding:13px 14px 11px;box-shadow:0 1px 2px rgba(27,24,19,.05),0 6px 20px rgba(27,24,19,.06)}
.mk .rvcard.good{background:linear-gradient(180deg,var(--good-wash),var(--surface) 96px);border-color:rgba(29,122,77,.24)}
.mk .rvcard.work{background:linear-gradient(180deg,var(--acc-wash),var(--surface) 96px);border-color:rgba(216,74,27,.24)}
.mk .rvcard h3{font-size:.66rem;letter-spacing:.09em;text-transform:uppercase;font-weight:800;margin:0 0 6px}
.mk .rvcard.good h3{color:var(--good-ink)}
.mk .rvcard.work h3{color:var(--acc-ink)}
.mk .rvcard ul{list-style:none;margin:0;padding:0}
.mk .rvcard li{display:flex;gap:8px;padding:8px 0;border-top:1px solid var(--mline-soft);font-size:.86rem;line-height:1.45}
.mk .rvcard li:first-child{border-top:0;padding-top:2px}
.mk .rvcard li>div{flex:1;min-width:0}
.mk .rvcard .ck{flex:0 0 16px;font-style:normal;font-weight:800;color:var(--good)}
.mk .rvcard .pt{color:var(--mink)}
.mk .rvcard .rql{display:block;margin-top:2px;line-height:1.4}
.mk .rvcard .rq{font-size:.8rem;color:var(--mmuted);font-style:italic;quotes:"\\201C" "\\201D"}
.mk .rvcard .rq.bad{text-decoration:line-through;text-decoration-thickness:1px;text-decoration-color:rgba(178,58,43,.5)}
.mk .rvcard.work li{display:block}
.mk .rvcard .iss{display:block;color:var(--mink);font-weight:700}
.mk .rvcard .fx{display:block;margin-top:3px;color:var(--good-ink);font-weight:600;font-size:.84rem}
.mk .rvcard .fx i{font-style:normal;font-weight:400;color:var(--mmuted)}
/* ----- recap v2: level ----- */
.mk .lvhero{display:grid;grid-template-columns:1fr;gap:6px 18px;align-items:center;background:var(--surface);border:1px solid var(--mline-soft);border-radius:16px;padding:15px 17px 14px;margin:8px 0 12px;box-shadow:0 1px 2px rgba(27,24,19,.05),0 8px 24px rgba(27,24,19,.07)}
.mk .lveye{grid-column:1/-1;font-size:.64rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--mmuted)}
.mk .lvbig{font-family:var(--disp);font-size:3.1rem;line-height:.95;font-weight:600;letter-spacing:-.02em;color:var(--acc)}
.mk .lvsum{margin:0;font-size:.9rem;line-height:1.5;color:var(--ink-soft)}
.mk .dims{list-style:none;margin:0 0 4px;padding:0 2px}
.mk .dim{display:grid;grid-template-columns:minmax(76px,auto) 1fr auto;grid-template-areas:"name track band" "ev ev ev";gap:3px 10px;align-items:center;padding:9px 0;border-top:1px solid var(--mline-soft)}
.mk .dim:first-child{border-top:0}
.mk .dname{grid-area:name;font-size:.8rem;font-weight:700;color:var(--mink)}
.mk .track{grid-area:track;display:grid;grid-template-columns:repeat(7,1fr);gap:2px;height:8px;min-width:0}
.mk .track i{display:block;height:100%;border-radius:2px;background:var(--teal-wash)}
.mk .track i.on{background:var(--teal)}
.mk .dband{grid-area:band;font-size:.68rem;font-weight:800;letter-spacing:.03em;color:var(--teal);background:var(--teal-wash);border-radius:99px;padding:2px 8px;white-space:nowrap}
.mk .dev{grid-area:ev;font-size:.78rem;color:var(--mmuted)}
.mk .sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.mk .lvh3{font-size:.66rem;letter-spacing:.09em;text-transform:uppercase;font-weight:800;color:var(--acc-ink);margin:12px 0 4px}
.mk .advice{list-style:none;margin:0;padding:0}
.mk .advice li{display:flex;gap:10px;align-items:flex-start;background:var(--surface);border:1px solid var(--mline-soft);border-radius:12px;padding:10px 12px;margin:7px 0;font-size:.86rem}
.mk .advice li>div{flex:1;min-width:0}
.mk .advice .an{flex:0 0 24px;height:24px;line-height:24px;text-align:center;font-style:normal;font-size:.7rem;font-weight:800;color:#fff;background:var(--acc);border-radius:99px}
.mk .advice b{display:block;color:var(--mink)}
.mk .advice span{display:block;color:var(--ink-soft);font-size:.82rem;margin-top:1px}
.mk .lvfoot{font-size:.74rem;color:var(--mmuted);font-style:italic;margin:10px 0 4px}
/* ----- recap v2: plan (teal mirror of the practice frame) ----- */
.mk .planbox{background:linear-gradient(180deg,var(--teal-wash),transparent 130px);border:1px solid rgba(31,111,104,.28);border-radius:16px;padding:14px 13px 12px;margin:12px 0}
.mk .planbox h2{margin-bottom:4px}
.mk .pfocus{margin:6px 0 10px;padding:8px 11px;border-left:3px solid var(--teal);background:var(--surface);border-radius:8px;font-size:.88rem;font-weight:600;color:var(--mink)}
.mk ul.plan,.mk ul.ask{list-style:none;margin:0;padding:0}
.mk ul.plan li{display:flex;gap:10px;align-items:flex-start;background:var(--surface);border:1px solid var(--mline-soft);border-radius:12px;padding:10px 12px;margin:7px 0;min-height:44px;box-sizing:border-box}
.mk ul.plan li>div{flex:1;min-width:0}
.mk ul.plan .daychip,.mk ul.ask .daychip{flex:0 0 auto;min-width:40px;text-align:center;margin-top:2px}
.mk .task{display:block;font-size:.88rem;color:var(--mink)}
.mk .pwhy{display:block;font-size:.76rem;color:var(--mmuted);margin-top:2px}
.mk .askh{font-size:.66rem;letter-spacing:.09em;text-transform:uppercase;font-weight:800;color:var(--teal);margin:14px 0 4px}
.mk ul.ask li{display:flex;gap:10px;align-items:flex-start;padding:8px 2px;font-size:.86rem;border-top:1px solid var(--mline-soft);min-height:44px;box-sizing:border-box}
.mk ul.ask li>span{flex:1;min-width:0}
.mk .daychip.askc{color:#fff;background:var(--teal)}
/* ----- recap v2: wrapping + responsive ----- */
.mk .lead,.mk .rvcard .pt,.mk .rvcard .rq,.mk .rvcard .iss,.mk .rvcard .fx,.mk .lvsum,.mk .dev,.mk .advice b,.mk .advice span,.mk .pfocus,.mk .task,.mk .pwhy,.mk ul.ask li>span,.mk .planbox h2{overflow-wrap:anywhere;word-break:break-word}
.mk .planbox h2{min-width:0}
.mk .planbox h2 .num{flex:0 0 auto;white-space:nowrap;overflow-wrap:normal;word-break:normal}
@media (min-width:480px){.mk .lvhero{grid-template-columns:auto 1fr}}
@media (min-width:760px){.mk .rvgrid{grid-template-columns:1fr 1fr}}
`.trim();
