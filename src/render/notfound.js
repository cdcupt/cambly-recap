// src/render/notfound.js — the static, personal-data-free 404 page (F1 · F6).
//
// Served by Caddy's handle_errors for any genuine 404 (see ops/Caddyfile). It is
// auth-EXEMPT, so it must carry ZERO personal content — just the brand shell and a
// root-relative link home. Self-contained like every other page (inline CSS, no
// external anything). The back link is absolute ("/index.html") because the page is
// served for arbitrary request paths, so a relative link could resolve wrong.

import { esc } from "./esc.js";
import { htmlDocument } from "./layout.js";

const LARR = "←";

/** Render the shared not-found page to an HTML string. Takes no data (constant). */
export function renderNotFound() {
  const body =
    `<header class="pad">` +
    `<span class="eyebrow">● Cambly weekly recap</span>` +
    `<h1>Page not <span class="accent">found</span></h1>` +
    `<p class="sub">That page isn't here — it may have moved, or the link was mistyped.</p>` +
    `</header>` +
    `<main>` +
    `<footer class="wknav"><a href="/index.html">${LARR} All weeks</a></footer>` +
    `</main>`;

  return htmlDocument({
    title: `Page not found ${esc("·")} Cambly Recap`,
    bodyClass: "mk",
    body,
  });
}
