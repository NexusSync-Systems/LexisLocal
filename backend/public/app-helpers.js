// app-helpers.js — čisté pomocné funkce dashboardu (bez DOM/stavu). Vytaženo z app.js
// kvůli testovatelnosti. V prohlížeči se načítá PŘED app.js/mixiny (globální funkce),
// v Node/testech přes module.exports. Jeden zdroj pravdy pro escapování (XSS obrana).
function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return unsafe
         .toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

if (typeof module !== 'undefined' && module.exports) module.exports = { escapeHtml: escapeHtml };

// ID do inline onclick="fn('…')": escapeHtml nestačí (entity se v atributu dekódují) → jen bezpečné znaky.
function safeId(id) {
    return String(id == null ? '' : id).replace(/[^A-Za-z0-9_.:-]/g, '');
}
