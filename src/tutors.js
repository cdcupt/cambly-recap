// src/tutors.js — the persisted tutors map + the tutor self-heal (recap v2, spec A2), and
// the data/ on-disk week-VM helpers they share with the run wrapper.
//
// /api/tutors answers an OBJECT map keyed by id → normalized (normalize.js) to the flat
// map {id: {id, displayName}}, merged into data/tutors.json (the file never shrinks), used
// to name each lesson's tutor and to self-heal published VMs whose class lost its tutor
// (patchTutorNames). Every helper takes an injectable fsImpl for tests. Split out of
// src/run.js so the run wrapper stays within the repo's 800-line file cap; run.js
// re-exports patchTutorNames for its existing callers.

import fs from "node:fs";
import path from "node:path";

import { normalizeTutors, mergeTutors, lessonTutorId } from "./normalize.js";

const TUTORS_FILE = "tutors.json"; // data/tutors.json — the persisted flat tutors map

// ── data/weeks on-disk helpers (shared with run.js) ──────────────────────────────

/** The weekIds with a VM file under data/weeks ([] when the dir is absent). */
export function listExistingWeekIds(dataDir, fsImpl) {
  try {
    return fsImpl
      .readdirSync(path.join(dataDir, "weeks"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** data/weeks/<weekId>.json → the parsed VM, or null when absent/unreadable. */
export function readWeekVM(dataDir, weekId, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(dataDir, "weeks", `${weekId}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Write data/weeks/<weekId>.json (pretty-printed, trailing newline), creating the dir. */
export function writeWeekVM(dataDir, weekId, vm, fsImpl) {
  const dir = path.join(dataDir, "weeks");
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(path.join(dir, `${weekId}.json`), JSON.stringify(vm, null, 2) + "\n");
}

// ── the tutors map ───────────────────────────────────────────────────────────────

/** data/tutors.json → the flat tutors map ({} when absent or unreadable). */
export function readTutorsMap(dataDir, fsImpl) {
  try {
    return normalizeTutors(JSON.parse(fsImpl.readFileSync(path.join(dataDir, TUTORS_FILE), "utf8")));
  } catch {
    return {};
  }
}

/** Merge freshly fetched tutors OVER the persisted map and write it back (the file never shrinks). */
export function persistTutorsMap(dataDir, fetched, fsImpl) {
  const merged = mergeTutors(readTutorsMap(dataDir, fsImpl), fetched);
  fsImpl.mkdirSync(dataDir, { recursive: true });
  fsImpl.writeFileSync(path.join(dataDir, TUTORS_FILE), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

/** The tutor display name for a published class, via raw/<lessonId>/_lesson.json → tutors map. */
function rawTutorNameOf(dataDir, lessonId, tutorsMap, fsImpl) {
  try {
    const rec = JSON.parse(fsImpl.readFileSync(path.join(dataDir, "raw", lessonId, "_lesson.json"), "utf8"));
    const tid = lessonTutorId(rec);
    return tid && tutorsMap[tid] ? tutorsMap[tid].displayName : null;
  } catch {
    return null;
  }
}

/**
 * Tutor self-heal (spec A2): every class of every data/weeks/*.json with an empty `tutor`
 * is named via raw/<lessonId>/_lesson.json (tutorId || tutorIds[0]) → tutors map →
 * displayName. A VM is rewritten only when a class changed (idempotent, byte-stable).
 * @param {{dataDir:string, fsImpl?:object, tutorsMap?:object, log?:function}} args
 * @returns {number} classes patched
 */
export function patchTutorNames({ dataDir, fsImpl = fs, tutorsMap = {}, log = () => {} }) {
  const map = normalizeTutors(tutorsMap);
  if (Object.keys(map).length === 0) return 0;
  let patched = 0;
  for (const weekId of listExistingWeekIds(dataDir, fsImpl).sort()) {
    const vm = readWeekVM(dataDir, weekId, fsImpl);
    if (!vm || !Array.isArray(vm.classes)) continue;
    const classes = vm.classes.map((c) => {
      if (!c || typeof c !== "object" || c.tutor) return c;
      const name = rawTutorNameOf(dataDir, c.lessonId, map, fsImpl);
      return name ? { ...c, tutor: name } : c;
    });
    const changed = classes.filter((c, i) => c !== vm.classes[i]).length;
    if (changed === 0) continue;
    writeWeekVM(dataDir, weekId, { ...vm, classes }, fsImpl);
    patched += changed;
    log(`tutor self-heal: ${weekId} — named ${changed} class(es)`);
  }
  return patched;
}
