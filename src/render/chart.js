// src/render/chart.js — the index "Your progress" block (Recap v2 · C1–C2).
//
// Four small-multiple stat tiles (speaking speed · share of talk · unique words ·
// minutes studied) derived AT RENDER TIME from classes[].stats and stats.minutes —
// nothing new is stored in the week VMs (F7 "derive, don't store"). Each tile is a
// value + a neutral delta chip vs the first week + an inline SVG sparkline with a
// native <title> hover per point (the page has no JS budget for a tooltip layer),
// followed by a Level track row and a table twin behind <details>.
//
// Palette check — dataviz validate_palette.js "#1f6f68,#d84a1b" --mode light
// --surface "#fffdf9": lightness band PASS · CVD separation PASS (worst ΔE 9.9
// protan) · normal-vision floor PASS (ΔE 27.7) · contrast vs surface PASS (both
// ≥ 3:1) · chroma floor FAIL for #1f6f68 (OKLCH C 0.076 < 0.10, "reads gray").
// The validator scopes itself to CATEGORICAL palettes; this design is emphasis, not
// identity — one hue for the series, the accent only on the latest point — and every
// tile carries direct first/last labels, a per-point <title> and the table twin, so
// the verdict is accepted with those mandatory secondary encodings in place.
//
// SVG mechanics: a 150×56 viewBox stretched horizontally (preserveAspectRatio=
// "none", fixed 56px height) so the drawing never grows tall on wide tiles. The line
// and baseline use vector-effect="non-scaling-stroke" (2px / 1px on screen at any
// width) and the end marker is a zero-length round-capped path (an 8px accent dot on
// a 12px surface ring, also non-scaling). The only text — the first and last values —
// sits in reserved HTML gutters beside the SVG so it never stretches or clips. Text
// wears text tokens only (never the series colour); tabular-nums only in the table.

import { esc } from "./esc.js";

const W = 150; // viewBox width (user units, stretched to the tile width)
const H = 56; // viewBox height == rendered height in px
const INSET = 5; // x inset so the end marker never sits on the edge
const LINE_TOP = 7; // highest line point (room for the 12px ring)
const LINE_BOTTOM = 49; // lowest line point (above the baseline)
const BASE_Y = 55.5; // hairline baseline, half-pixel aligned
const COL_BASE = 55; // columns stand on the baseline
const COL_TOP = 4; // tallest column's top
const COL_MAX_W = 14; // column width cap (user units ≈ 24px on the widest tile)
const COL_RADIUS = 4; // rounded top
const COL_FILL = 0.7; // column share of its slot (the rest is the gap)
const PAD_RATIO = 0.15; // honest y range: min−pad … max+pad
const MDOT = "·";
const MINUS = "−";
const EMDASH = "—";

/** The four small multiples, in tile order. `showUnit` = unit shown beside the big value. */
const METRICS = [
  { key: "wpm", label: "Speaking speed", unit: "wpm", sep: " ", showUnit: true, kind: "line" },
  { key: "talkPct", label: "Your share of talk", unit: "%", sep: "", showUnit: true, kind: "line" },
  { key: "words", label: "Unique words per class", unit: "words", sep: " ", showUnit: false, kind: "line" },
  { key: "minutes", label: "Minutes studied", unit: "min", sep: " ", showUnit: true, kind: "columns" },
];

const isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const r1 = (v) => Math.round(v * 10) / 10; // 1-decimal coordinates keep the SVG small
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const byWeekId = (a, b) => (a.weekId < b.weekId ? -1 : a.weekId > b.weekId ? 1 : 0);
const metricByKey = (key) => METRICS.find((m) => m.key === key);
const firstPresent = (vals) => vals.findIndex((v) => v !== null);
const lastPresent = (vals) => vals.length - 1 - [...vals].reverse().findIndex((v) => v !== null);

/**
 * Mean of one classes[].stats key, rounded to an integer. Classes whose value is
 * missing, null, 0 or non-finite are ignored (a 0 wpm class is a stats outage, not a
 * silent lesson). Returns null when no class qualifies.
 */
export function avgStat(classes, key) {
  const vals = (Array.isArray(classes) ? classes : [])
    .map((c) => (c && c.stats ? c.stats[key] : null))
    .filter(isPositive);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function levelOf(vm) {
  const lv = vm.level;
  if (!lv || typeof lv !== "object") return null;
  if (typeof lv.overall !== "string" || lv.overall.trim() === "") return null;
  return {
    band: lv.overall.trim(),
    confidence: typeof lv.confidence === "string" && lv.confidence !== "" ? lv.confidence : null,
  };
}

/**
 * Per-week aggregates, ascending by weekId (any input order). Empty weeks keep their
 * slot with null metrics so they render as gaps, never as zeros.
 * @param {object[]} weeks - week VMs (empty + non-empty)
 * @returns {{weekId:string, weekLabel:string, isEmpty:boolean, classes:number,
 *   minutes:number|null, wpm:number|null, talkPct:number|null, words:number|null,
 *   level:{band:string, confidence:string|null}|null}[]}
 */
export function weekSeries(weeks) {
  return [...(Array.isArray(weeks) ? weeks : [])]
    .filter((w) => w && typeof w === "object")
    .sort(byWeekId)
    .map((w) => {
      const isEmpty = w.isEmpty === true;
      const classes = Array.isArray(w.classes) ? w.classes : [];
      const stats = w.stats || {};
      return {
        weekId: String(w.weekId ?? ""),
        weekLabel: String(w.weekLabel ?? ""),
        isEmpty,
        classes: isEmpty ? 0 : Number.isInteger(stats.classes) ? stats.classes : classes.length,
        minutes: !isEmpty && isPositive(stats.minutes) ? stats.minutes : null,
        wpm: isEmpty ? null : avgStat(classes, "wpm"),
        talkPct: isEmpty ? null : avgStat(classes, "talkPct"),
        words: isEmpty ? null : avgStat(classes, "words"),
        level: isEmpty ? null : levelOf(w),
      };
    });
}

/**
 * The neutral delta vs the first week that has the metric, in two parts: the pill text
 * (`value`: "+9 wpm" · "−3%" · "No change") and the muted tail (`since`: "since May 4–10").
 * They are rendered as separate inline pieces so the pill itself never wraps — at 320px a
 * one-piece "+176 words since May 4–10" chip split into a two-line blob. No red/green
 * judgement. Returns null with fewer than two data points.
 * @param {ReturnType<typeof weekSeries>} series
 * @param {"wpm"|"talkPct"|"words"|"minutes"} key
 * @returns {{value:string, since:string}|null}
 */
export function deltaParts(series, key) {
  const metric = metricByKey(key);
  const pts = series.filter((s) => s[key] !== null);
  if (!metric || pts.length < 2) return null;
  const first = pts[0];
  const d = pts[pts.length - 1][key] - first[key];
  const value = d === 0 ? "No change" : `${d > 0 ? "+" : MINUS}${Math.abs(d)}${metric.sep}${metric.unit}`;
  return { value, since: `since ${first.weekLabel}` };
}

/** The delta as one sentence ("+9 wpm since May 4–10") — the two parts joined; null below two points. */
export function deltaLabel(series, key) {
  const parts = deltaParts(series, key);
  return parts ? `${parts.value} ${parts.since}` : null;
}

// ---------------------------------------------------------------- geometry

/** Honest per-tile y scale for lines: min−pad … max+pad, never anchored at 0. */
function lineScale(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const pad = span > 0 ? span * PAD_RATIO : Math.max(1, Math.abs(hi) * 0.1);
  const yMin = lo - pad;
  const yMax = hi + pad;
  return (v) => r1(LINE_BOTTOM - ((v - yMin) / (yMax - yMin)) * (LINE_BOTTOM - LINE_TOP));
}

/** Consecutive runs of present indexes — each run is one polyline; gaps split them. */
function presentRuns(vals) {
  const runs = [];
  let run = [];
  for (const [i, v] of vals.entries()) {
    if (v === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run = [...run, i];
    }
  }
  return run.length ? [...runs, run] : runs;
}

const dotPath = (cls, x, y) =>
  `<path class="${cls}" d="M${x} ${y}h.01" vector-effect="non-scaling-stroke"/>`;

/** Line tile marks: polylines per run, a small dot for a lone point, the accent end marker. */
function lineMarks(series, key) {
  const n = series.length;
  const xs = series.map((_, i) => (n <= 1 ? W / 2 : r1(INSET + (i * (W - 2 * INSET)) / (n - 1))));
  const vals = series.map((s) => s[key]);
  const present = vals.filter((v) => v !== null);
  if (present.length === 0) return { xs, ys: vals, marks: "" };
  const yOf = lineScale(present);
  const ys = vals.map((v) => (v === null ? null : yOf(v)));
  const runs = presentRuns(vals).map((run) =>
    run.length === 1
      ? dotPath("pt", xs[run[0]], ys[run[0]])
      : `<polyline class="ln" points="${run.map((i) => `${xs[i]},${ys[i]}`).join(" ")}" vector-effect="non-scaling-stroke"/>`,
  );
  const li = lastPresent(vals);
  const marker = dotPath("ring", xs[li], ys[li]) + dotPath("dot", xs[li], ys[li]);
  return { xs, ys, marks: runs.join("") + marker };
}

/** One column with a rounded top, anchored on the baseline. */
function columnPath(x, yTop, w, cls) {
  const r = Math.min(COL_RADIUS, w / 2, (COL_BASE - yTop) / 2);
  const d =
    `M${r1(x)} ${COL_BASE}V${r1(yTop + r)}Q${r1(x)} ${r1(yTop)} ${r1(x + r)} ${r1(yTop)}` +
    `H${r1(x + w - r)}Q${r1(x + w)} ${r1(yTop)} ${r1(x + w)} ${r1(yTop + r)}V${COL_BASE}Z`;
  return `<path class="${cls}" d="${d}"/>`;
}

/** Column tile marks (minutes): thin rounded columns from 0, the latest in the accent. */
function columnMarks(series, key) {
  const n = series.length;
  const slot = W / n;
  const w = r1(Math.min(COL_MAX_W, slot * COL_FILL));
  const xs = series.map((_, i) => r1(i * slot + slot / 2));
  const vals = series.map((s) => s[key]);
  const present = vals.filter((v) => v !== null);
  if (present.length === 0) return { xs, ys: vals, marks: "" };
  const max = Math.max(...present);
  const ys = vals.map((v) => (v === null ? null : r1(COL_BASE - (v / max) * (COL_BASE - COL_TOP))));
  const li = lastPresent(vals);
  const marks = vals
    .map((v, i) => (v === null ? "" : columnPath(xs[i] - w / 2, ys[i], w, i === li ? "col last" : "col")))
    .join("");
  return { xs, ys, marks };
}

/** Invisible per-point hit band carrying the native <title> tooltip (wider than the mark). */
function hitRects(series, metric, xs) {
  const n = series.length;
  return series
    .map((s, i) => {
      if (s[metric.key] === null) return "";
      const x0 = i === 0 ? 0 : (xs[i - 1] + xs[i]) / 2;
      const x1 = i === n - 1 ? W : (xs[i] + xs[i + 1]) / 2;
      const title = esc(`Week of ${s.weekLabel} ${MDOT} ${s[metric.key]}${metric.sep}${metric.unit}`);
      return `<rect class="hit" x="${r1(x0)}" y="0" width="${r1(x1 - x0)}" height="${H}"><title>${title}</title></rect>`;
    })
    .join("");
}

/** One direct label (first or last value) in an HTML gutter, vertically at its point. */
function gutterLabel(series, key, ys, idx, cls) {
  const y = clamp(ys[idx], LINE_TOP, LINE_BOTTOM);
  return `<span class="pl ${cls}" style="top:${y}px" aria-hidden="true">${esc(series[idx][key])}</span>`;
}

/** One inline sparkline: gutters + SVG (baseline · marks · hit bands with titles). */
function sparkline(series, metric) {
  const geo = metric.kind === "columns" ? columnMarks(series, metric.key) : lineMarks(series, metric.key);
  const vals = series.map((s) => s[metric.key]);
  const fi = firstPresent(vals);
  const li = lastPresent(vals);
  const first = fi >= 0 && fi !== li ? gutterLabel(series, metric.key, geo.ys, fi, "a") : "";
  const last = fi >= 0 ? gutterLabel(series, metric.key, geo.ys, li, "b") : "";
  return (
    `<div class="spark">${first}` +
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" ` +
    `aria-label="${esc(metric.label)} by week">` +
    `<line class="base" x1="0" y1="${BASE_Y}" x2="${W}" y2="${BASE_Y}" vector-effect="non-scaling-stroke"/>` +
    geo.marks +
    hitRects(series, metric, geo.xs) +
    `</svg>${last}</div>`
  );
}

// ---------------------------------------------------------------- markup

function tile(series, metric) {
  const pts = series.filter((s) => s[metric.key] !== null);
  const latest = pts.length ? pts[pts.length - 1][metric.key] : null;
  const unit = metric.showUnit ? `<span class="tu">${metric.unit}</span>` : "";
  const value = latest === null ? `<b>${EMDASH}</b>` : `<b>${esc(latest)}</b>${unit}`;
  const delta = deltaParts(series, metric.key);
  const chip = delta
    ? `<p class="delta"><span class="td">${esc(delta.value)}</span><span class="tds">${esc(delta.since)}</span></p>`
    : "";
  return (
    `<article class="tile"><h3>${metric.label}</h3><p class="tv">${value}</p>${chip}` +
    sparkline(series, metric) +
    `</article>`
  );
}

/** Level track: omitted with no level, one sentence for one week, chips in week order otherwise. */
function levelRow(series) {
  const leveled = series.filter((s) => s.level !== null);
  if (leveled.length === 0) return "";
  if (leveled.length === 1) {
    const s = leveled[0];
    const conf = s.level.confidence ? ` (${esc(s.level.confidence)} confidence)` : "";
    return `<p class="ltrack one">Level estimate began ${esc(s.weekLabel)}: ${esc(s.level.band)}${conf}</p>`;
  }
  const chips = leveled
    .map((s) => `<li><b>${esc(s.level.band)}</b><span>${esc(s.weekLabel)}</span></li>`)
    .join("");
  return `<div class="ltrack"><span class="lk">Level</span><ol>${chips}</ol></div>`;
}

const cell = (v) => (v === null ? EMDASH : esc(v));

/** Table twin behind <details> — reuses the site's .more summary pill; scrolls inside .table-wrap. */
function dataTable(series) {
  const rows = series
    .filter((s) => !s.isEmpty)
    .map(
      (s) =>
        `<tr><th scope="row">${esc(s.weekLabel)}</th><td>${esc(s.classes)}</td><td>${cell(s.minutes)}</td>` +
        `<td>${cell(s.wpm)}</td><td>${cell(s.talkPct)}</td><td>${cell(s.words)}</td>` +
        `<td class="t">${s.level ? esc(s.level.band) : EMDASH}</td></tr>`,
    )
    .join("");
  const head =
    `<tr><th scope="col" class="t">Week</th><th scope="col">Classes</th><th scope="col">Min</th>` +
    `<th scope="col">wpm</th><th scope="col">Talk %</th><th scope="col">Words</th><th scope="col" class="t">Level</th></tr>`;
  return (
    `<details class="more ptable"><summary>Show the data</summary><div class="table-wrap">` +
    `<table><caption>Per-class averages, week by week</caption><thead>${head}</thead><tbody>${rows}</tbody></table>` +
    `</div></details>`
  );
}

/**
 * The index "Your progress" section: four small multiples + the Level track + the
 * table twin. Returns "" with fewer than two non-empty weeks (one point is not a trend).
 * @param {object[]} weeksDesc - every week VM (any order; sorted internally)
 */
export function progressBlock(weeksDesc) {
  const series = weekSeries(weeksDesc);
  if (series.filter((s) => !s.isEmpty).length < 2) return "";
  const tiles = METRICS.map((m) => tile(series, m)).join("");
  return (
    `<section class="pad progress" aria-labelledby="progress-h">` +
    `<h2 id="progress-h">Your progress</h2>` +
    `<p class="ssub">Averages per class, week by week ${EMDASH} from your real Cambly stats.</p>` +
    `<div class="tiles">${tiles}</div>` +
    levelRow(series) +
    dataTable(series) +
    `</section>`
  );
}

/** Index-only chart CSS, scoped under .ix; byte-budgeted ≤ 5 KB (C2). */
export const CHART_STYLES = `
.ix .progress{padding:22px 16px 6px}
.ix .tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0 4px}
.ix .tile{min-width:0;background:var(--surface);border:1px solid var(--mline-soft);border-radius:13px;padding:11px 11px 10px;box-shadow:0 1px 2px rgba(27,24,19,.05),0 6px 20px rgba(27,24,19,.06)}
.ix .tile h3{margin:0;font-size:.74rem;font-weight:600;line-height:1.3;color:var(--mmuted);overflow-wrap:anywhere}
.ix .tv{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;margin:4px 0 0;font-size:1.5rem;font-weight:600;line-height:1.1;color:var(--mink)}
.ix .tv .tu{font-size:.72rem;font-weight:600;color:var(--mmuted)}
.ix .delta{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 6px;margin:7px 0 0;font-size:.66rem;line-height:1.4}
.ix .td{display:inline-block;padding:2px 8px;font-weight:600;color:var(--ink-soft);background:var(--surface2);border:1px solid var(--mline-soft);border-radius:99px;white-space:nowrap}
.ix .tds{color:var(--mmuted);white-space:nowrap}
.ix .spark{position:relative;height:56px;margin:10px 0 0;padding:0 29px}
.ix .spark svg{display:block;width:100%;height:56px;overflow:visible}
.ix .spark .pl{position:absolute;width:24px;font-size:.66rem;line-height:1;color:var(--mmuted);transform:translateY(-50%);white-space:nowrap}
.ix .spark .pl.a{left:0;text-align:right}
.ix .spark .pl.b{right:0;text-align:left;font-weight:700;color:var(--mink)}
.ix .spark .base{stroke:var(--mline);stroke-width:1}
.ix .spark .ln{fill:none;stroke:var(--teal);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.ix .spark .pt{fill:none;stroke:var(--teal);stroke-width:4;stroke-linecap:round}
.ix .spark .ring{fill:none;stroke:var(--surface);stroke-width:12;stroke-linecap:round}
.ix .spark .dot{fill:none;stroke:var(--acc);stroke-width:8;stroke-linecap:round}
.ix .spark .col{fill:var(--teal)}
.ix .spark .col.last{fill:var(--acc)}
.ix .spark .hit{fill:transparent}
.ix .ltrack{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:12px 0 0;font-size:.8rem;color:var(--ink-soft);overflow-wrap:anywhere}
.ix .ltrack .lk{font-size:.64rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--mmuted)}
.ix .ltrack ol{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.ix .ltrack li{display:inline-flex;align-items:baseline;gap:5px;padding:3px 9px;background:var(--surface);border:1px solid var(--mline-soft);border-radius:99px}
.ix .ltrack li b{font-size:.78rem;color:var(--mink)}
.ix .ltrack li span{font-size:.68rem;color:var(--mmuted)}
.ix .ptable{margin:12px 0 0}
.ix details.ptable>summary{display:inline-flex;align-items:center;box-sizing:border-box;min-height:44px;padding:0 14px}
.ix .table-wrap{overflow-x:auto;margin:8px 0 0;-webkit-overflow-scrolling:touch}
.ix .ptable table{width:100%;min-width:440px;border-collapse:collapse;font-size:.78rem}
.ix .ptable caption{text-align:left;padding:0 0 6px;font-size:.72rem;color:var(--mmuted)}
.ix .ptable th,.ix .ptable td{padding:5px 8px;border-bottom:1px solid var(--mline-soft);text-align:right;white-space:nowrap}
.ix .ptable th{font-size:.64rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--mmuted)}
.ix .ptable td{font-variant-numeric:tabular-nums;color:var(--mink)}
.ix .ptable .t,.ix .ptable th[scope=row]{text-align:left}
.ix .ptable th[scope=row]{font-size:.78rem;font-weight:600;letter-spacing:0;text-transform:none;color:var(--mink)}
@media (min-width:760px){.ix .tiles{grid-template-columns:repeat(4,1fr)}}
`.trim();
