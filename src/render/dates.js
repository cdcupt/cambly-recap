// src/render/dates.js — renderer date labels, all Asia/Shanghai (fixed +08:00).
//
// The VM carries ISO8601+08:00 timestamps (classes[].startAt, publishedAt) and a
// date string for authStaleSince. Every label the renderer derives — day chips,
// date labels, the published sub-line — is computed here so the contract stays
// free of redundant display state (F7 "derive, don't store"). Reuses the integer
// CST math from src/week.js; no timezone library, zero dependencies.

import { CST_OFFSET_MS, weekdayOf } from "../week.js";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

/** Parse an ISO8601 (or date-only) string to epoch ms, or null when unparseable. */
function toEpoch(iso) {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** CST calendar parts of an epoch (UTC-shift trick — Asia/Shanghai has no DST). */
function cstParts(ms) {
  const d = new Date(ms + CST_OFFSET_MS);
  return {
    weekday: weekdayOf(ms), // "Thu"
    month: MONTHS[d.getUTCMonth()],
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
  };
}

const pad2 = (n) => String(n).padStart(2, "0");

/** Uppercase 3-letter weekday for the vocab/phrasing/practice day chips ("THU"). */
export function dayChipUpper(iso) {
  const ms = toEpoch(iso);
  return ms === null ? "" : weekdayOf(ms).toUpperCase();
}

/** Title-case 3-letter weekday for the grammar "· Thu" why suffix. */
export function weekdayShort(iso) {
  const ms = toEpoch(iso);
  return ms === null ? "" : weekdayOf(ms);
}

/** Class-card date label, "Thu May 28". */
export function dateLabel(iso) {
  const ms = toEpoch(iso);
  if (ms === null) return "";
  const p = cstParts(ms);
  return `${p.weekday} ${p.month} ${p.day}`;
}

/** Published sub-line stamp, "Mon Jun 1, 07:30". */
export function publishedLabel(iso) {
  const ms = toEpoch(iso);
  if (ms === null) return "";
  const p = cstParts(ms);
  return `${p.weekday} ${p.month} ${p.day}, ${pad2(p.hours)}:${pad2(p.minutes)}`;
}

/** Stale-banner expiry stamp, "Mon Jul 6" (handles both datetime and date-only). */
export function expiryLabel(iso) {
  const ms = toEpoch(iso);
  if (ms === null) return "";
  const p = cstParts(ms);
  return `${p.weekday} ${p.month} ${p.day}`;
}

/** Spelled-out small integers for editorial headings ("The three classes"); digits past 20. */
export function numberWord(n) {
  if (!Number.isInteger(n) || n < 0 || n > 20) return String(n);
  return NUMBER_WORDS[n];
}

/** Naive count pluralizer: pluralize(1,"class","classes") → "class". */
export function pluralize(n, singular, plural) {
  return n === 1 ? singular : plural;
}
