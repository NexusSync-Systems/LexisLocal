/*
 * app-icons.js — sjednocení ikonografie do Lucide-style čárových SVG.
 *
 * Nahrazuje emoji v UI za čárové ikony ve stejném stylu, jaký už používá boční
 * navigace (viewBox 0 0 24 24, stroke=currentColor, fill=none, kulaté zakončení).
 * Pracuje i s obsahem, který dosazují app-*.js za běhu — díky MutationObserveru.
 *
 * Bezpečné: nesahá na <script>/<style>/<textarea>/<input>, na prvky s data-noicon
 * ani na už vykreslené .licon. Nemapované emoji ponechává beze změny.
 */
(function () {
  'use strict';

  // Vnitřek SVG (jen path/geometrie). Klíč = emoji BEZ variation selectoru (U+FE0F).
  // Hodnota = string (obrys) NEBO {p, fill, color}.
  var P = {
    // stav / zpětná vazba
    '✅': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.2 2.2L15.5 9.5"/>',
    '✔': '<path d="M20 6 9 17l-5-5"/>',
    '✓': '<path d="M20 6 9 17l-5-5"/>',
    '❌': '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
    '✕': '<path d="M18 6 6 18M6 6l12 12"/>',
    '✖': '<path d="M18 6 6 18M6 6l12 12"/>',
    '⚠': '<path d="M10.3 4 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    '🚨': '<path d="M10.3 4 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    '🔔': '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',

    // dokumenty / text
    '📄': '<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v5h5M8 13h8M8 17h6"/>',
    '📃': '<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v5h5M8 13h8M8 17h6"/>',
    '📑': '<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v5h5"/>',
    '📋': '<rect x="8" y="3" width="8" height="4" rx="0"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>',
    '📜': '<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v5h5M8 13h8M8 17h6"/>',
    '📖': '<path d="M2 5h7a3 3 0 0 1 3 3v11a2.5 2.5 0 0 0-2.5-2.5H2z"/><path d="M22 5h-7a3 3 0 0 0-3 3v11a2.5 2.5 0 0 1 2.5-2.5H22z"/>',
    '📚': '<path d="M4 4h4v16H4zM10 4h4v16h-4zM16 5l4 1-3 14-4-1z"/>',
    '📝': '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    '✏': '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    '✍': '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    '🖋': '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    '📎': '<path d="M21 8.5 12.5 17a4 4 0 0 1-6-6l8-8a2.7 2.7 0 0 1 4 4l-8 8a1.3 1.3 0 0 1-2-2l7.5-7.5"/>',

    // složky / úložiště
    '📁': '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    '📂': '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    '🗂': '<rect x="3" y="7" width="18" height="13" rx="0"/><path d="M3 7l2-3h6l2 3"/>',
    '💾': '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    '🗑': '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',

    // akce
    '🔄': '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>',
    '⏳': '<path d="M6 2h12M6 22h12M8 2c0 4 8 6 8 10s-8 6-8 10M16 2c0 4-8 6-8 10"/>',
    '⏰': '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M5 3 2 6M22 6l-3-3"/>',
    '🕒': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    '⏱': '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
    '📅': '<rect x="3" y="4" width="18" height="17" rx="0"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    '📆': '<rect x="3" y="4" width="18" height="17" rx="0"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    '➕': '<path d="M12 5v14M5 12h14"/>',
    '🔍': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    '🔎': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    '⚡': '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>',
    '🚀': '<path d="M5 13c-2 1-3 5-3 5s4-1 5-3M12 3c4 2 7 6 7 12-2 1-5 1-7 0-2-6 0-10 0-12zM9 14a11 11 0 0 1 6-8"/>',
    '🎯': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    '🔗': '<path d="M9 15l6-6M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5"/>',
    '🐙': '<circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8 11l8-4M8 13l8 4"/>',
    '🕸': '<circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8 11l8-4M8 13l8 4"/>',

    // subjekty
    '🤖': '<rect x="4" y="8" width="16" height="12" rx="0"/><path d="M12 8V4M8 4h8"/><path d="M2 13h2M20 13h2"/><circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none"/>',
    '🦙': '<rect x="6" y="6" width="12" height="12" rx="0"/><rect x="10" y="10" width="4" height="4" rx="0"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    '👤': '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    '👥': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M16 5.5a3.5 3.5 0 0 1 0 7M21.5 21a6.5 6.5 0 0 0-4-6"/>',
    '👑': '<path d="M3 7l4 4 5-7 5 7 4-4-2 12H5z"/>',
    '🕵': '<circle cx="12" cy="9" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    '🪪': '<rect x="3" y="5" width="18" height="14" rx="0"/><circle cx="8" cy="11" r="2"/><path d="M13 9h5M13 13h5M6 16h5"/>',
    '🏢': '<rect x="5" y="3" width="14" height="18" rx="0"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
    '💻': '<rect x="3" y="4" width="18" height="12" rx="0"/><path d="M2 20h20"/>',
    '🖥': '<rect x="3" y="4" width="18" height="12" rx="0"/><path d="M8 20h8M12 16v4"/>',

    // komunikace / síť
    '📥': '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z"/>',
    '📤': '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z"/><path d="M12 3v7M9 6l3-3 3 3"/>',
    '📧': '<rect x="3" y="5" width="18" height="14" rx="0"/><path d="m3 7 9 6 9-6"/>',
    '✉': '<rect x="3" y="5" width="18" height="14" rx="0"/><path d="m3 7 9 6 9-6"/>',
    '💬': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    '🔌': '<path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0zM12 16v6"/>',
    '🧭': '<circle cx="12" cy="12" r="9"/><path d="m16 8-6 2-2 6 6-2z"/>',

    // bezpečnost
    '🔒': '<rect x="5" y="11" width="14" height="10" rx="0"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    '🔓': '<rect x="5" y="11" width="14" height="10" rx="0"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
    '🛡': '<path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5z"/>',
    '⚖': '<path d="M12 3v18M7 21h10M5 6h14"/><path d="M5 6 2 12a3 3 0 0 0 6 0zM19 6l-3 6a3 3 0 0 0 6 0z"/>',
    '🛠': '<path d="M14.5 5.5a3.5 3.5 0 0 0-4.9 4.4l-6.6 6.6 2.5 2.5 6.6-6.6a3.5 3.5 0 0 0 4.4-4.9l-2.3 2.3-2-2z"/>',
    '⚙': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',

    // data / grafy
    '📊': '<path d="M3 3v18h18"/><path d="M7 14v4M12 9v9M17 5v13"/>',
    '📈': '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
    '💶': '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5a4 4 0 1 0 0 7M7 11h6M7 13h5"/>',
    '💰': '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M14.5 9.5a2.5 2 0 0 0-5 0c0 2.5 5 1 5 3.5a2.5 2 0 0 1-5 0"/>',
    '👍': '<path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM7 11l4-8a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7"/>',

    // navigační šipky
    '→': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    '←': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    '⬆': '<path d="M12 19V5M6 11l6-6 6 6"/>',
    '⬇': '<path d="M12 5v14M6 13l6 6 6-6"/>',
    '▶': '<path d="M7 4l12 8-12 8z" fill="currentColor" stroke="none"/>',
    '☰': '<path d="M3 6h18M3 12h18M3 18h18"/>'
  };

  // Stavové tečky — plné kolečko s významovou barvou (výjimka z mono schématu).
  var DOTS = {
    '🟢': 'var(--accent-green, #5a8a4a)',
    '🟩': 'var(--accent-green, #5a8a4a)',
    '🔴': 'var(--m-accent, #ec3013)',
    '🟥': 'var(--m-accent, #ec3013)',
    '🟡': 'var(--accent-yellow, #c8860a)',
    '🟠': 'var(--accent-yellow, #c8860a)',
    '⚫': 'var(--m-ink, #201e1d)',
    '⚪': 'var(--m-faint, #7d7979)'
  };

  // Emoji, které NECHCEME sahat (přepínač motivu si je řídí sám textem).
  var SKIP = { '🌗': 1, '🌙': 1, '☀': 1, '🌞': 1, '🏠': 1 };

  var VS = /[️︎]/g; // variation selectors

  // Sestav regulární výraz ze všech klíčů (delší první), s volitelným VS.
  var keys = Object.keys(P).concat(Object.keys(DOTS))
    .filter(function (k) { return !SKIP[k]; })
    .sort(function (a, b) { return b.length - a.length; });
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  var RE = new RegExp('(?:' + keys.map(esc).join('|') + ')\\uFE0F?', 'g');

  function svg(inner, filled, color) {
    var s = '<span class="licon' + (filled ? ' licon-fill' : '') + '" aria-hidden="true"'
      + (color ? ' style="color:' + color + '"' : '') + '>'
      + '<svg viewBox="0 0 24 24">' + inner + '</svg></span>';
    return s;
  }
  function iconHtmlFor(ch) {
    var key = ch.replace(VS, '');
    if (DOTS[key]) return svg('<circle cx="12" cy="12" r="6"/>', true, DOTS[key]);
    var v = P[key];
    if (!v) return null;
    if (typeof v === 'string') return svg(v, false, null);
    return svg(v.p, !!v.fill, v.color || null);
  }

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, CODE: 1, PRE: 1, NOSCRIPT: 1 };
  function skipEl(el) {
    if (!el) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.isContentEditable) return true;
    if (el.classList && el.classList.contains('licon')) return true;
    if (el.hasAttribute && el.hasAttribute('data-noicon')) return true;
    return false;
  }

  function paintNode(root) {
    if (!root || root.nodeType !== 1) return;
    if (skipEl(root)) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !RE.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        RE.lastIndex = 0;
        // odfiltruj text uvnitř zakázaných rodičů
        var p = n.parentNode;
        while (p && p.nodeType === 1) {
          if (skipEl(p)) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var hits = [], node;
    while ((node = walker.nextNode())) hits.push(node);
    hits.forEach(function (textNode) {
      var text = textNode.nodeValue;
      RE.lastIndex = 0;
      var frag = document.createDocumentFragment();
      var last = 0, m, any = false;
      while ((m = RE.exec(text))) {
        var html = iconHtmlFor(m[0]);
        if (!html) continue;
        any = true;
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var tpl = document.createElement('template');
        tpl.innerHTML = html;
        frag.appendChild(tpl.content.firstChild);
        last = m.index + m[0].length;
      }
      if (!any) return;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  // ── observer pro dynamický obsah (app-*.js) ──
  var pending = [], timer = null, observer = null;
  function flush() {
    timer = null;
    if (observer) observer.disconnect();
    var batch = pending; pending = [];
    batch.forEach(paintNode);
    if (observer) observer.observe(document.body, { childList: true, subtree: true });
  }
  function schedule(n) {
    pending.push(n);
    if (!timer) timer = setTimeout(flush, 120);
  }

  function start() {
    paintNode(document.body);
    observer = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var nd = added[j];
          if (nd.nodeType === 1) schedule(nd);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.LexisIcons = { repaint: function () { paintNode(document.body); } };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
