// app-ai-rezim.js — Manažerský přehled: režim AI kanceláře (lokální / hybridní / jen cloud), jen správce.
// Načítá se PO app-managerial.js; obaluje loadManagerialTab. Data: GET/POST /api/settings/ai-rezim (lib/ai_rezim.js).
(function () {
    if (typeof LexisLocalApp === 'undefined') return;
    const P = LexisLocalApp.prototype;
    const origLoad = P.loadManagerialTab;
    const POPIS = {
        lokalni: 'Vše na počítači kanceláře. Data neodcházejí, dotazy nic nestojí. Slabší u náročných rešerší.',
        hybrid: 'Obecné dotazy a spisy se souhlasem klienta odpovídá Claude (Bedrock EU), ostatní lokální model. Při výpadku AWS lokální model.',
        'jen-cloud': 'Bez lokálního modelu: odpovídá jen Claude, vyhledávání běží v aplikaci. U spisů bez souhlasu AI nepracuje; při výpadku AWS je AI nedostupná.'
    };

    P.loadManagerialTab = async function () {
        const r = origLoad ? await origLoad.apply(this, arguments) : undefined;
        this.loadAiRezim();
        return r;
    };

    P.loadAiRezim = async function () {
        const card = document.getElementById('ai-rezim-card');
        if (!card) return;
        try {
            const res = await fetch(`${this.apiBase}/settings/ai-rezim`, { headers: this.getHeaders() });
            if (res.status === 403) { card.style.display = 'none'; return; }
            const s = await res.json();
            if (!res.ok) throw new Error(s.error || res.status);
            card.style.display = '';
            this.renderAiRezim(s);
        } catch (err) {
            card.innerHTML = `<div style="opacity:.7;padding:10px;">Režim AI se nepodařilo načíst: ${escapeHtml(String(err.message || err))}</div>`;
        }
    };

    P.renderAiRezim = function (s, zprava) {
        const card = document.getElementById('ai-rezim-card');
        const ids = ['lokalni', 'hybrid', 'jen-cloud'];
        const radek = id => {
            const p = s.pripravenost[id];
            const akt = s.aktualni === id;
            const kontroly = p.kontroly.map(c => `<li style="color:${c.ok ? 'var(--text-secondary)' : 'var(--accent-red)'};">${c.ok ? '✓' : '✗'} ${escapeHtml(c.nazev)}${c.detail ? ' — ' + escapeHtml(c.detail) : ''}</li>`).join('');
            return `<label class="glass" style="display:block;padding:12px 14px;border-radius:10px;border:1px solid ${akt ? 'var(--accent-blue, #4a8cff)' : 'var(--border-glass)'};background:var(--sf-02);cursor:${s.zamek ? 'default' : 'pointer'};">
                <input type="radio" name="ai-rezim" value="${id}" ${akt ? 'checked' : ''} ${s.zamek && !(s.zamek.typ === 'jen-lokalne' && id === 'lokalni') ? 'disabled' : ''}>
                <strong>${escapeHtml(s.rezimy[id].nazev)}</strong>${akt ? ' <span style="font-size:.75rem;opacity:.8;">(aktuální)</span>' : ''}
                <span style="font-size:.75rem;margin-left:6px;color:${p.ok ? 'var(--accent-green)' : 'var(--accent-yellow)'};">${p.ok ? 'připraveno' : 'nepřipraveno'}</span>
                <div style="font-size:.78rem;opacity:.8;margin:4px 0 4px 22px;">${POPIS[id]}</div>
                <ul style="font-size:.74rem;margin:0 0 0 22px;padding-left:14px;">${kontroly}</ul></label>`;
        };
        card.innerHTML = `
            <h3 style="margin:0 0 6px;">🧭 Režim AI kanceláře</h3>
            <div style="font-size:.8rem;opacity:.75;margin-bottom:12px;">Platí pro celou kancelář. Pravidla cloudu (souhlas klienta, stupně A–D, rozpočet, audit) platí v obou cloudových režimech.
                ${s.aktualni === 'jiny' ? '<br><strong>Server má ruční nastavení mimo tři režimy.</strong>' : ''}
                ${s.zamek ? `<br><strong>🔒 ${escapeHtml(s.zamek.duvod)}</strong>` : ''}</div>
            <form id="ai-rezim-form" style="display:grid;gap:10px;">
                ${ids.map(radek).join('')}
                <label id="ai-rezim-potvrzeni-wrap" style="font-size:.8rem;display:none;"><input type="checkbox" id="ai-rezim-potvrzeni">
                    Potvrzuji, že kancelář má zpracovatelskou smlouvu s AWS a DPIA pro cloudovou AI a klienty informovala.</label>
                <div><button type="submit" class="btn btn-secondary" style="padding:8px 14px;font-size:.82rem;" ${s.zamek && s.zamek.typ === 'env' ? 'disabled' : ''}>Přepnout režim</button>
                    <span id="ai-rezim-msg" style="font-size:.78rem;margin-left:8px;">${zprava || ''}</span></div>
            </form>`;
        const form = document.getElementById('ai-rezim-form');
        const wrap = document.getElementById('ai-rezim-potvrzeni-wrap');
        const vybrany = () => (form.querySelector('input[name="ai-rezim"]:checked') || {}).value;
        const sync = () => { const v = vybrany(); wrap.style.display = v && s.rezimy[v] && s.rezimy[v].cloud && v !== s.aktualni ? '' : 'none'; };
        form.addEventListener('change', sync); sync();
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const rezim = vybrany();
            const msg = document.getElementById('ai-rezim-msg');
            if (!rezim || rezim === s.aktualni) { msg.textContent = 'Vyberte jiný režim.'; return; }
            msg.textContent = 'Přepínám…';
            try {
                const res = await fetch(`${this.apiBase}/settings/ai-rezim`, {
                    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, this.getHeaders()),
                    body: JSON.stringify({ rezim, potvrzeni: !!document.getElementById('ai-rezim-potvrzeni').checked })
                });
                const j = await res.json();
                if (!res.ok) throw new Error(j.error || res.status);
                const r2 = await fetch(`${this.apiBase}/settings/ai-rezim`, { headers: this.getHeaders() });
                this.renderAiRezim(await r2.json(), `✓ Přepnuto (${escapeHtml(j.z)} → ${escapeHtml(j.na)}). Platí hned; doporučujeme restart aplikace a obnovení stránky u všech uživatelů.${j.varovani ? ' ⚠️ ' + escapeHtml(j.varovani) : ''}`);
            } catch (err) {
                msg.innerHTML = `<span style="color:var(--accent-red);">${escapeHtml(String(err.message || err))}</span>`;
            }
        });
    };
})();
