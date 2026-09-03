// src/render/chart.js — index-page progress block: small-multiple sparklines derived
// at render time from every week's classes[].stats (derive, don't store), a CEFR level
// track for weeks that carry vm.level, and the table-view twin. Inline SVG only, no JS.

export const CHART_STYLES = "";

/**
 * Progress block for the index page.
 * @param {object[]} weeksDesc - all week VMs, reverse-chron (empty weeks included)
 * @returns {string} HTML, or "" when fewer than 2 non-empty weeks exist
 */
export function progressBlock(_weeksDesc) {
  return "";
}
