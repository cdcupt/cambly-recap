// src/render/script.js — the only inline JS on any page (F5).
//
// BOOT is a one-liner in <head>: it flips <html class="no-js"> to "js" so the
// no-JS / print answer-sheet fallback (styles.js) only applies when JS is truly
// absent. REVEAL is the tap-to-reveal mechanic, byte-compatible with the working
// mockup script in docs/DESIGN.html (lines 805–831) minus the doc-only state
// chips, adapted only for an arbitrary card count N. It is served ONLY on week
// pages that have practice cards; the index ships just the boot line. Measured
// well under the ≤ 2 KB inline budget.

/** Head boot script: no-js → js (single statement, runs before body paints). */
export const BOOT = "document.documentElement.className='js'";

/**
 * Tap-to-reveal + progress. reveal(btn,expand) toggles hidden + aria-expanded and
 * adds/removes the card's .done class to match; update() RECOMPUTES the count from
 * the cards currently revealed (aria-expanded="true") on every toggle — so re-hiding
 * a card decrements the counter and clears the "All done" sign-off (never a latching
 * ++). update() rewrites the aria-live text and the (aria-hidden) bar width. One
 * listener per .pq button, one for #revealall. State is ephemeral by design —
 * reload resets progress; no localStorage in v1.
 */
export const REVEAL = `(function(){
var btns=[].slice.call(document.querySelectorAll('.pq'));
var total=btns.length;
var ptxt=document.getElementById('ptxt'),pfill=document.getElementById('pfill');
function done(){return btns.filter(function(b){return b.getAttribute('aria-expanded')==='true';}).length;}
function update(){
var d=done();
if(ptxt)ptxt.textContent=d>=total?'All done \\u2014 see you next Monday \\u2713':d+' of '+total+' revealed';
if(pfill)pfill.style.width=(total?d/total*100:0)+'%';
}
function reveal(btn,expand){
var card=btn.closest('.pcard'),pa=document.getElementById(btn.getAttribute('aria-controls'));
var open=expand!==undefined?expand:btn.getAttribute('aria-expanded')!=='true';
btn.setAttribute('aria-expanded',open?'true':'false');
if(open){pa.removeAttribute('hidden');card.classList.add('done');}
else{pa.setAttribute('hidden','');card.classList.remove('done');}
update();
}
btns.forEach(function(b){b.addEventListener('click',function(){reveal(b);});});
var all=document.getElementById('revealall');
if(all)all.addEventListener('click',function(){btns.forEach(function(b){reveal(b,true);});});
})();`;
