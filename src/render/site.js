// src/render/site.js — the renderer path (F1 · F7 · §10 caption).
//
// Full idempotent re-render of the whole site from data/weeks/*.json +
// data/site-state.json: validate every week, RE-ASSERT the Σ-invariant (§10) and
// the ▣ quotes and the page budgets BEFORE the atomic swap, render index + one
// page per non-empty week into a staging dir on the /site volume, promote it with
// plain renames, then write healthz.json LAST (after the swap). Any gate failure
// throws before the swap, leaving the previously published site intact (fail
// closed). Env seams: DATA_DIR, SITE_DIR, FAKE_NOW (via healthz's resolveNow).

import fs from "node:fs";
import path from "node:path";
import { resolveNow } from "../week.js";
import { renderWeek } from "./week.js";
import { renderIndex } from "./index.js";
import { renderNotFound } from "./notfound.js";
import { validateWeek, assertSigma, assertBudget } from "./validate.js";
import { writeHealthz } from "./healthz.js";

const STAGE_DIR = ".stage";

/** Read + parse every data/weeks/*.json, sorted ascending by weekId. */
export function readWeeks(dataDir, { fsImpl = fs } = {}) {
  const weeksDir = path.join(dataDir, "weeks");
  let entries = [];
  try {
    entries = fsImpl.readdirSync(weeksDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fsImpl.readFileSync(path.join(weeksDir, f), "utf8")))
    .sort((a, b) => (a.weekId < b.weekId ? -1 : a.weekId > b.weekId ? 1 : 0));
}

/** Read data/site-state.json, defaulting to {} when absent or unreadable. */
export function readSiteState(dataDir, { fsImpl = fs } = {}) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(dataDir, "site-state.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Nearest non-empty older/newer neighbors for the footer prev/next (skip empties). */
function neighborsFor(weekId, nonEmptyAsc) {
  const i = nonEmptyAsc.findIndex((w) => w.weekId === weekId);
  const pick = (w) => (w ? { weekId: w.weekId, weekLabel: w.weekLabel } : null);
  return { prev: pick(nonEmptyAsc[i - 1]), next: pick(nonEmptyAsc[i + 1]) };
}

/** Render facts serialized into healthz — derived, never stored (F7). */
export function computeFacts(weeksAsc) {
  const latest = weeksAsc[weeksAsc.length - 1] || null;
  return {
    latestWeekId: latest ? latest.weekId : null,
    weeksTotal: weeksAsc.length,
    lessonsThisWeek: latest && latest.stats ? latest.stats.classes ?? 0 : 0,
    rejectedCount:
      latest && latest.integrity ? latest.integrity.rejectedCount ?? 0 : 0,
  };
}

function cleanDir(dir, fsImpl) {
  fsImpl.rmSync(dir, { recursive: true, force: true });
  fsImpl.mkdirSync(dir, { recursive: true });
}

// Promote a freshly built stage dir into the served dir with plain renames — the
// stage lives on the same /site volume so each rename is atomic (F7 swap mechanics).
function atomicSwap(siteDir, stage, fsImpl) {
  const liveIndex = path.join(siteDir, "index.html");
  const liveWeeks = path.join(siteDir, "weeks");
  const oldWeeks = path.join(siteDir, "weeks.old");

  fsImpl.renameSync(path.join(stage, "index.html"), liveIndex);
  fsImpl.renameSync(path.join(stage, "not-found.html"), path.join(siteDir, "not-found.html"));

  fsImpl.rmSync(oldWeeks, { recursive: true, force: true });
  if (fsImpl.existsSync(liveWeeks)) fsImpl.renameSync(liveWeeks, oldWeeks);
  fsImpl.renameSync(path.join(stage, "weeks"), liveWeeks);
  fsImpl.rmSync(oldWeeks, { recursive: true, force: true });

  fsImpl.rmSync(stage, { recursive: true, force: true });
}

/**
 * Build the whole static site. Aborts (throws RenderAbort) before any swap on any
 * schema, Σ, quote, or budget violation.
 * @param {{dataDir?:string, siteDir?:string, nowMs?:number, fsImpl?:object}} [opts]
 * @returns {{weekPages:string[], indexBytes:number, healthz:object, facts:object}}
 */
export function buildSite(opts = {}) {
  const fsImpl = opts.fsImpl ?? fs;
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "data";
  const siteDir = opts.siteDir ?? process.env.SITE_DIR ?? "dist";
  const nowMs = opts.nowMs ?? resolveNow();

  const weeksAsc = readWeeks(dataDir, { fsImpl });
  const siteState = readSiteState(dataDir, { fsImpl });

  // Gate everything BEFORE touching the served dir (fail closed).
  for (const vm of weeksAsc) {
    validateWeek(vm);
    assertSigma(vm);
  }

  const nonEmptyAsc = weeksAsc.filter((w) => w.isEmpty !== true);

  // Render + budget-assert into memory first.
  const indexHtml = renderIndex(weeksAsc, { siteState });
  assertBudget(indexHtml, "index.html");

  // The static, auth-exempt 404 page (constant; no week data).
  const notFoundHtml = renderNotFound();
  assertBudget(notFoundHtml, "not-found.html");

  const pages = nonEmptyAsc.map((vm) => {
    const { prev, next } = neighborsFor(vm.weekId, nonEmptyAsc);
    const html = renderWeek(vm, { siteState, prev, next });
    assertBudget(html, `weeks/${vm.weekId}.html`);
    return { weekId: vm.weekId, html };
  });

  // Stage on the /site volume, then promote atomically.
  const stage = path.join(siteDir, STAGE_DIR);
  fsImpl.mkdirSync(siteDir, { recursive: true });
  cleanDir(stage, fsImpl);
  fsImpl.mkdirSync(path.join(stage, "weeks"), { recursive: true });
  fsImpl.writeFileSync(path.join(stage, "index.html"), indexHtml);
  fsImpl.writeFileSync(path.join(stage, "not-found.html"), notFoundHtml);
  for (const p of pages) {
    fsImpl.writeFileSync(path.join(stage, "weeks", `${p.weekId}.html`), p.html);
  }
  atomicSwap(siteDir, stage, fsImpl);

  // healthz.json LAST — after the swap, so freshness reflects a completed site.
  const facts = computeFacts(weeksAsc);
  const healthz = writeHealthz(siteDir, { siteState, facts, nowMs }, { fsImpl });

  return {
    weekPages: pages.map((p) => p.weekId),
    indexBytes: Buffer.byteLength(indexHtml, "utf8"),
    healthz,
    facts,
  };
}
