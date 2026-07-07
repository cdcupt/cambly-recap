// src/render/layout.js — the self-contained HTML document shell (F1 · F6).
//
// Every page is exactly one request: inline CSS, an inline head boot line, an
// inline data-URI favicon, system fonts, no images, no external anything. The
// document ships <html class="no-js"> so the answer-sheet fallback holds until the
// boot script flips it to "js".

import { STYLES } from "./styles.js";
import { BOOT } from "./script.js";

// Inline favicon: a small serif-paper tile with the accent dot. encodeURIComponent
// escapes every "/" and ":" so the data-URI carries no literal "//" or "http://"
// that a self-contained-page check could mistake for an external resource.
const FAVICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
  "<rect width='32' height='32' rx='7' fill='#f7f2ea'/>" +
  "<circle cx='16' cy='16' r='8' fill='#d84a1b'/></svg>";
export const FAVICON = "data:image/svg+xml," + encodeURIComponent(FAVICON_SVG);

/**
 * Assemble a complete HTML document.
 * @param {{title:string, bodyClass:string, body:string, script?:string}} opts
 */
export function htmlDocument({ title, bodyClass, body, script = "" }) {
  const scriptTag = script ? `<script>${script}</script>` : "";
  return (
    `<!doctype html>\n` +
    `<html lang="en" class="no-js">\n` +
    `<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${title}</title>\n` +
    `<link rel="icon" href="${FAVICON}">\n` +
    `<style>${STYLES}</style>\n` +
    `<script>${BOOT}</script>\n` +
    `</head>\n` +
    `<body class="${bodyClass}">\n` +
    `${body}\n` +
    scriptTag +
    `\n</body>\n</html>\n`
  );
}
