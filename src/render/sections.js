// src/render/sections.js — recap v2 week-page sections (the week in review · CEFR level
// estimate · next-week plan) and their CSS. Every dynamic value goes through esc().
// Each section returns "" when its VM block is absent so older weeks render unchanged.

export const SECTION_STYLES = "";

/** Section — "The week in review" (vm.review). Returns "" when vm.review is absent. */
export function reviewSection(_vm, _resolve) {
  return "";
}

/** Section — "Level estimate" (vm.level, CEFR). Returns "" when vm.level is absent. */
export function levelSection(_vm) {
  return "";
}

/** Section — "Plan for next week" (vm.plan). Returns "" when vm.plan is absent. */
export function planSection(_vm) {
  return "";
}
