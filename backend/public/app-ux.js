// app-ux.js — drobnosti UX z kontroly 5. 10. 2026:
//  • výběr modelu pro denní výkaz nabízí jen modely, které kancelář opravdu má
//    (dřív natvrdo „Llama-3 (Doporučeno)“, i když byl stažený jen qwen2.5:7b).
//  • „Generovat demo“ je jen pro prázdnou instalaci — jakmile má kancelář skutečné spisy,
//    tlačítko z hlavičky zmizí (demo spis by se míchal mezi ostré).
(function () {
    'use strict';
    if (typeof LexisLocalApp === 'undefined') return;
    const P = LexisLocalApp.prototype;
    const isEmbed = n => /bge|nomic|embed|minilm|e5-/i.test(n);

    P.fillTimesheetModels = async function () {
        const sel = document.getElementById('timesheet-model-select');
        if (!sel || sel.dataset.filled) return;
        try {
            const res = await fetch(`${this.apiBase}/models`, { headers: this.getHeaders() });
            const data = await res.json();
            const names = (data.models || []).map(m => m.name || m.model).filter(n => n && !isEmbed(n));
            if (!names.length) return;
            sel.innerHTML = '<option value="">Výchozí model kanceláře</option>' +
                names.map(n => `<option value="${String(n).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}">${String(n).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</option>`).join('');
            sel.dataset.filled = '1';
        } catch (e) { /* zůstane „Výchozí model kanceláře“ */ }
    };

    const orig = P.loadTimeTrackingTab;
    if (typeof orig === 'function') {
        P.loadTimeTrackingTab = function () {
            const r = orig.apply(this, arguments);
            try { this.fillTimesheetModels(); } catch (e) { /* ignore */ }
            return r;
        };
    }

    P.updateDemoButton = async function () {
        const btn = document.getElementById('btn-parse-test');
        if (!btn) return;
        try {
            const res = await fetch(`${this.apiBase}/spisy`, { headers: this.getHeaders() });
            if (!res.ok) return;
            const data = await res.json();
            const list = Array.isArray(data) ? data : (data.spisy || []);
            btn.style.display = list.length ? 'none' : '';
        } catch (e) { /* tlačítko zůstane */ }
    };
    function kick() {
        const app = window.appInstance;
        if (app && typeof app.updateDemoButton === 'function') app.updateDemoButton();
        else setTimeout(kick, 500);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(kick, 800));
    else setTimeout(kick, 800);
})();
