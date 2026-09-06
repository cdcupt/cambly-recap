// src/render/styles.js — design tokens + component CSS (F2/F3).
//
// The .mk block is lifted verbatim from docs/DESIGN.html (its "PRODUCT MOCKUP
// STYLES" block IS the visual spec — same palette, type, spacing, shadows). The
// only additions over the mockup are the responsive column (2×2 → 1×4 stats, a
// centered ≤760px paper sheet), the no-JS / print answer-sheet fallback, the
// always-visible server-rendered banner, the muted zero-item note, the honest-
// semantics empty index row (a <span>, styled to match the mockup's <a>), the
// wrapping chip nav (eight chips no longer fit one phone-width row), the non-breaking
// week label and a universal :focus-visible ring. Single string, byte-budgeted ≤ 15 KB (F6).

export const STYLES = `
/* ============ tokens + product mockup styles — lifted from DESIGN.html .mk ============ */
.mk{
  --bg:#f7f2ea; --surface:#fffdf9; --surface2:#fbf6ee; --mink:#1b1813; --ink-soft:#4a443c; --mmuted:#7a7065;
  --mline:rgba(27,24,19,.12); --mline-soft:rgba(27,24,19,.07);
  --acc:#d84a1b; --acc-ink:#a8350f; --acc-wash:#fbe7dd;
  --teal:#1f6f68; --teal-wash:#dcefec;
  --good:#1d7a4d; --good-ink:#14502f; --good-wash:#e3f3e9;
  --bad:#b23a2b; --bad-wash:#fbe9e7;
  --amb:#8a5a06; --amb-wash:#f7ecd6;
  --disp:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,ui-serif,serif;
  --ease:cubic-bezier(.16,1,.3,1);
  background:radial-gradient(700px 320px at 100% -8%,var(--acc-wash) 0%,transparent 60%),var(--bg);
  color:var(--mink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.mk .pad{padding:0 16px}
.mk .eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:.68rem;letter-spacing:.13em;text-transform:uppercase;font-weight:700;color:var(--acc-ink);background:var(--acc-wash);padding:5px 11px;border-radius:999px}
.mk h1{font-family:var(--disp);font-weight:600;font-size:1.72rem;line-height:1.08;letter-spacing:-.01em;margin:12px 0 4px}
.mk h1 .accent{color:var(--acc)}
.mk .sub{color:var(--mmuted);font-size:.86rem;margin:0}
.mk .sub a{color:var(--acc-ink)}
/* Back-link keeps a ≥44px tap target (WCAG 2.5.5) while reading as a plain text link. */
.mk .sub a.backlink{display:inline-flex;align-items:center;min-height:44px;padding-inline:4px;vertical-align:middle}
.mk header{padding:26px 0 14px}
.mk .stats{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:16px 0 4px}
.mk .stat{background:var(--surface);border:1px solid var(--mline-soft);border-radius:13px;padding:11px 12px 9px;box-shadow:0 1px 2px rgba(27,24,19,.05),0 6px 20px rgba(27,24,19,.06)}
.mk .stat .n{font-family:var(--disp);font-size:1.42rem;line-height:1;color:var(--acc)}
.mk .stat .l{font-size:.68rem;color:var(--mmuted);margin-top:5px;letter-spacing:.03em;text-transform:uppercase;font-weight:600}
/* Chips wrap (two rows on phones), never a hidden-scroll row; ≥44px tap targets. */
.mk nav.chips{position:sticky;top:0;z-index:9;display:flex;flex-wrap:wrap;padding:0 6px;background:rgba(247,242,234,.92);backdrop-filter:blur(8px);border-block:1px solid var(--mline-soft)}
.mk nav.chips a{display:inline-flex;align-items:center;min-height:44px;box-sizing:border-box;text-decoration:none;color:var(--ink-soft);font-size:.78rem;font-weight:700;padding:8px 10px;white-space:nowrap;transition:color .2s var(--ease)}
.mk nav.chips a:hover,.mk nav.chips a:focus-visible{color:var(--acc-ink)}
/* Week labels (≤16 chars) never break at the spaced en dash. */
.mk .nowrap{white-space:nowrap;overflow-wrap:normal;word-break:normal}
.mk section{padding:22px 0 4px}
.mk h2{font-family:var(--disp);font-weight:600;font-size:1.28rem;letter-spacing:-.005em;margin:0 0 2px;display:flex;align-items:baseline;gap:8px;border:0;padding-top:0}
.mk h2 .num{font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:.72rem;color:var(--acc);font-weight:800;letter-spacing:.08em}
.mk .ssub{color:var(--mmuted);font-size:.82rem;margin:0 0 12px}
.mk .empty-note{color:var(--mmuted);font-size:.85rem;font-style:italic;margin:6px 0 10px}
.mk .ccard{background:var(--surface);border:1px solid var(--mline-soft);border-radius:14px;padding:14px 15px 12px;margin:10px 0;box-shadow:0 1px 2px rgba(27,24,19,.05),0 6px 20px rgba(27,24,19,.06)}
.mk .ccard .day{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.mk .ccard .day b{font-size:.78rem;font-weight:700;color:var(--ink-soft);letter-spacing:.01em}
.mk .ccard .day span{font-size:.72rem;color:var(--mmuted);font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.mk .ccard .ctitle{font-family:var(--disp);font-weight:600;font-size:1.08rem;line-height:1.3;letter-spacing:-.005em;color:var(--mink);margin:3px 0 0}
.mk .ccard.nohead .day b{font-family:var(--disp);font-size:1.02rem;font-weight:600;color:var(--mink);letter-spacing:0}
.mk .ccard .cstats{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
.mk .ccard .cstats i{font-style:normal;font-size:.7rem;font-weight:700;color:var(--teal);background:var(--teal-wash);border-radius:99px;padding:2px 8px}
.mk .moment{font-size:.85rem;color:var(--ink-soft);margin:6px 0 0}
.mk .moment q{color:var(--mink)}
.mk .tnote{margin:8px 0 0;padding:7px 10px;border-left:3px solid var(--acc);background:var(--acc-wash);border-radius:8px;font-size:.8rem;color:var(--acc-ink);font-style:italic}
/* ----- per-class Focus & tutor feedback (tutorFocus — Cambly's own coaching text) ----- */
.mk .focus{margin:10px 0 2px;padding:11px 13px;background:var(--teal-wash);border:1px solid rgba(31,111,104,.22);border-radius:11px}
.mk .focus>:last-child{margin-bottom:0}
.mk .focus .fhead{font-size:.62rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--teal);margin-bottom:6px}
.mk .focus .fai{font-size:.82rem;color:var(--ink-soft);margin:0 0 7px}
/* Cambly's "what we can work on" — coaching prose (worksheets stripped), accent-edged like a note. */
.mk .focus .fwork{font-size:.82rem;color:var(--ink-soft);margin:0 0 8px;padding:6px 10px;border-left:3px solid var(--acc);background:var(--surface);border-radius:0 8px 8px 0}
.mk .focus .fwork b{display:block;font-size:.6rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--acc-ink);margin-bottom:2px}
.mk .focus .fnote{margin:0 0 8px}
.mk .focus .fnote .en{font-size:.82rem;color:var(--mink);margin:0}
.mk .focus .fnote .zh{font-size:.8rem;color:var(--mmuted);margin:2px 0 0}
.mk .focus .fnext{display:flex;flex-wrap:wrap;align-items:baseline;gap:7px;margin:0;padding:8px 11px;background:var(--acc-wash);border:1px solid rgba(216,74,27,.25);border-radius:9px}
.mk .focus .fnext b{font-size:.6rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:var(--acc);border-radius:99px;padding:2px 9px}
.mk .focus .fnext span{font-size:.85rem;font-weight:600;color:var(--acc-ink)}
.mk .vword{background:var(--surface);border:1px solid var(--mline-soft);border-radius:12px;padding:11px 13px;margin:8px 0;box-shadow:0 1px 2px rgba(27,24,19,.04)}
.mk .vword .w{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.mk .vword .w b{font-family:var(--disp);font-size:1rem;color:var(--acc-ink)}
.mk .vword .w em{font-style:normal;font-size:.8rem;color:var(--ink-soft)}
.mk .vq{font-size:.8rem;color:var(--mmuted);font-style:italic;margin:4px 0 0}
/* Model sentence shown only when no clean verbatim usage survived (never both). */
.mk .veg{font-size:.8rem;color:var(--mmuted);margin:4px 0 0}
.mk .daychip{font-style:normal;font-size:.62rem;font-weight:800;letter-spacing:.06em;color:var(--teal);background:var(--teal-wash);border-radius:99px;padding:2px 7px;vertical-align:middle}
.mk .grp{margin:14px 0 6px}
.mk .grp h3{font-size:.9rem;margin:0 0 2px;display:flex;align-items:center;gap:7px}
.mk .grp h3 .cnt{font-size:.66rem;font-weight:800;color:#fff;background:var(--teal);border-radius:99px;padding:1px 7px}
.mk .rule{font-size:.78rem;color:var(--mmuted);margin:0 0 7px}
.mk .corr{background:var(--surface);border:1px solid var(--mline-soft);border-radius:11px;padding:9px 12px;margin:6px 0;font-size:.86rem}
.mk .corr .said{color:var(--bad);text-decoration:line-through;text-decoration-thickness:1px;text-decoration-color:rgba(178,58,43,.5)}
.mk .corr .fix{color:var(--good-ink);font-weight:600}
.mk .corr .why{display:block;font-size:.76rem;color:var(--mmuted);margin-top:3px}
.mk .corr .arr{color:var(--mmuted)}
/* Source tag on a row the recap spotted in the transcript (not a Cambly correction record). */
.mk .corr .src{font-style:normal;font-size:.58rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--teal);background:var(--teal-wash);border-radius:99px;padding:1px 6px;margin-left:6px;vertical-align:middle;white-space:nowrap}
.mk details.more>summary{cursor:pointer;list-style:none;display:inline-block;font-size:.74rem;font-weight:700;color:var(--teal);background:var(--teal-wash);border-radius:99px;padding:6px 12px;margin:4px 0;min-height:30px}
.mk details.more>summary::-webkit-details-marker{display:none}
.mk details.more>summary:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.mk details.more[open]>summary{opacity:.6}
.mk .up{background:var(--surface);border:1px solid var(--mline-soft);border-radius:12px;padding:11px 13px;margin:8px 0;font-size:.86rem}
.mk .up .from{color:var(--ink-soft)} .mk .up .from q{quotes:"\\201C" "\\201D"}
.mk .up .to{margin-top:4px;color:var(--good-ink);font-weight:600}
.mk .up .why{display:block;font-size:.76rem;color:var(--mmuted);margin-top:3px;font-weight:400}
/* ----- practice: tap-to-reveal ----- */
.mk .practice{background:linear-gradient(180deg,var(--acc-wash),transparent 130px);border:1px solid rgba(216,74,27,.25);border-radius:16px;padding:14px 13px 10px;margin:12px 0}
.mk .practice h2{margin-bottom:4px}
.mk .prog{display:flex;align-items:center;gap:10px;margin:6px 0 12px}
.mk .prog .ptxt{font-size:.74rem;font-weight:700;color:var(--acc-ink);white-space:nowrap}
.mk .pbar{flex:1;height:6px;border-radius:99px;background:rgba(27,24,19,.1);overflow:hidden}
.mk .pbar i{display:block;height:100%;width:0;background:var(--acc);border-radius:99px;transition:width .35s var(--ease)}
.mk .pcard{background:var(--surface);border:1px solid var(--mline-soft);border-radius:13px;margin:9px 0;box-shadow:0 1px 2px rgba(27,24,19,.05),0 5px 16px rgba(27,24,19,.06);overflow:hidden;transition:box-shadow .2s var(--ease)}
.mk .pcard.done{border-color:rgba(31,111,104,.45)}
.mk .pq{display:block;width:100%;text-align:left;background:none;border:0;font:inherit;color:inherit;padding:13px 14px;min-height:44px;cursor:pointer}
.mk .pq:hover{background:var(--surface2)}
.mk .pq:focus-visible{outline:2px solid var(--acc);outline-offset:-2px;border-radius:13px}
.mk .ptag{display:block;font-size:.62rem;font-weight:800;letter-spacing:.09em;color:var(--teal);margin-bottom:5px}
.mk .pcard.done .ptag::after{content:" \\B7 \\2713 DONE";color:var(--good)}
.mk .ptext{display:block;font-size:.9rem}
.mk .ptext .gapline{color:var(--acc-ink);font-weight:700;border-bottom:2px dotted var(--acc);padding:0 .3em}
.mk .ptext .cue{color:var(--mmuted);font-style:italic}
.mk .phint{display:inline-block;margin-top:8px;font-size:.68rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--acc-ink);background:var(--acc-wash);border-radius:99px;padding:4px 10px}
.mk .pq[aria-expanded="true"] .phint{display:none}
.mk .pa{padding:0 14px 13px}
.mk .pa .ans{background:var(--good-wash);border-radius:9px;padding:8px 12px;color:var(--good-ink);font-size:.88rem}
.mk .pa .ans b{font-weight:700}
.mk .pa .why{font-size:.76rem;color:var(--mmuted);margin:6px 2px 0}
.mk .pall{display:inline-block;font:inherit;font-size:.74rem;font-weight:700;color:var(--teal);background:var(--teal-wash);border:0;border-radius:99px;padding:8px 14px;margin:4px 0 8px;cursor:pointer;min-height:34px}
.mk .pall:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.mk footer.wknav{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--mline);margin-top:20px;padding:16px 16px 30px;font-size:.8rem}
.mk footer.wknav a{color:var(--acc-ink);text-decoration:none;font-weight:600;padding:8px 0;min-height:44px;display:flex;align-items:center}
.mk footer.wknav a:hover{text-decoration:underline}
.mk footer.wknav .gap{flex:0 0 auto}

/* ----- index page ----- */
.ix .totals{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0 2px}
.ix .totals i{font-style:normal;font-size:.7rem;font-weight:700;color:var(--teal);background:var(--teal-wash);border-radius:99px;padding:3px 9px}
.ix .firstrun{color:var(--ink-soft);font-size:.85rem;margin:12px 0 0;font-style:italic}
.ix ul.weeks{list-style:none;margin:14px 0 0;padding:0 0 26px}
.ix ul.weeks .wrow{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--mink);background:var(--surface);border:1px solid var(--mline-soft);border-radius:13px;padding:12px 13px;margin:8px 0;min-height:52px;box-shadow:0 1px 2px rgba(27,24,19,.04);transition:transform .18s var(--ease),box-shadow .18s var(--ease)}
.ix ul.weeks a.wrow:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(27,24,19,.1)}
.ix ul.weeks a.wrow:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.ix .wl{flex:1;min-width:0}
.ix .wl b{font-family:var(--disp);font-size:.95rem;font-weight:600;display:block}
.ix .wl>span{font-size:.74rem;color:var(--mmuted)}
.ix .wc{font-size:.7rem;font-weight:800;color:var(--acc-ink);background:var(--acc-wash);border-radius:99px;padding:3px 9px;white-space:nowrap}
/* v1 week with no Cambly correction records — a fact, not a score. */
.ix .wc.muted{color:var(--ink-soft);background:var(--surface2);border:1px solid var(--mline-soft);font-weight:700}
.ix li.latest .wrow{border-color:rgba(216,74,27,.4);border-width:1.5px}
.ix li.latest .new{font-size:.6rem;font-weight:800;letter-spacing:.08em;color:#fff;background:var(--acc);border-radius:99px;padding:2px 7px;margin-left:6px;vertical-align:middle}
.ix li.empty .wrow{background:transparent;border-style:dashed;box-shadow:none;color:var(--mmuted)}
.ix li.empty .wl b{font-weight:400;font-style:italic;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:.85rem}

/* ----- stale-auth banner (server-rendered, always visible when present) ----- */
.mk .banner{background:var(--amb-wash);border-bottom:1px solid rgba(138,90,6,.3);padding:10px 16px;font-size:.78rem;color:var(--amb);line-height:1.45}
.mk .banner b{display:block;font-size:.8rem}
.mk .banner code{background:rgba(138,90,6,.12);border-radius:4px;padding:.05rem .3rem;font-size:.72rem;white-space:normal;overflow-wrap:anywhere}

/* ----- renderer additions: page shell, responsive, focus, motion, print ----- */
html{background:#efe7da}
html,body{margin:0;padding:0}
body.mk{max-width:760px;margin:0 auto;min-height:100vh;box-shadow:0 0 40px rgba(27,24,19,.08)}
main{display:block}
/* Defensive wrap: no long unbroken token (URL, pasted greeting, code) may force
   horizontal scroll at 320px. Every text-bearing container breaks long words. */
.mk .sub,.mk .ccard .day span,.mk .ccard .ctitle,.mk .moment,.mk .tnote,.mk .focus .fai,.mk .focus .fwork,.mk .focus .fnote .en,.mk .focus .fnote .zh,.mk .focus .fnext span,.mk .vword .w b,.mk .vword .w em,.mk .vq,.mk .veg,.mk .grp h3,.mk .rule,.mk .corr,.mk .corr .said,.mk .corr .fix,.mk .corr .why,.mk .up,.mk .ptag,.mk .ptext,.mk .pa .ans,.mk .pa .why,.mk .empty-note,.ix .wl b,.ix .wl>span{overflow-wrap:anywhere;word-break:break-word}
/* Flex text cells must be allowed to shrink below their content width to wrap. */
.mk .ccard .day,.mk .vword .w,.mk .grp h3,.mk .focus .fnext{min-width:0}
.mk a:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px}
@media (min-width:760px){.mk .stats{grid-template-columns:repeat(4,1fr)}}
@media (prefers-reduced-motion:reduce){.mk *{transition:none !important}}
html.no-js .pa[hidden]{display:block}
html.no-js .phint,html.no-js .prog{display:none}
@media print{
  html{background:#fff}
  body.mk{box-shadow:none;max-width:none}
  .mk nav.chips{position:static;backdrop-filter:none}
  .pa[hidden]{display:block}
  .phint,.prog{display:none}
}
`.trim();
