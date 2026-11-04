// app-pilot.js — měření pilotu bez obsahu spisů (lib/pilot_metriky.js).
//  • pod odpovědí agenta 👍 / 👎 (u 👎 důvod z pevného seznamu) → POST /api/pilot-metriky/hodnoceni — žádný text
//  • Manažerský přehled: karta „Pilot — kvalita odpovědí“ (jen správce) s tabulkou po typech úloh a exportem CSV
// Načítá se po app-chat.js a app-ai-costs.js; obaluje loadManagerialTab.
(function () {
    if (typeof LexisLocalApp === 'undefined') return;
    const P = LexisLocalApp.prototype;
    const DUVODY = { spatna_citace: 'špatná citace', chybi_opora: 'chybí opora (§)', vymyslene: 'vymyšlený údaj', nepresne: 'nepřesné', neuplne: 'neúplné', mimo_zadani: 'mimo zadání', jine: 'jiné' };
    const TYPY = { legal_analysis: 'Právní rozbor', contract_review: 'Kontrola smlouvy', contradictions: 'Rozpory', opponent_letter: 'Dopis protistraně', secretary: 'Lhůty / sekretariát', proofread: 'Korektura', obecne: 'Ostatní' };
    const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const kod = (s) => /^[a-z][a-z0-9_]{0,39}$/.test(String(s || '')) ? String(s) : 'obecne';

    P.pilotRatingHtml = function (data, agentId) {
        const kind = kod(data && data.outputGuard && data.outputGuard.taskKind);
        const id = 'pr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const sel = Object.entries(DUVODY).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
        return `<span id="${id}" data-agent="${esc(kod(agentId))}" data-kind="${esc(kind)}" style="margin-left:8px; font-size:0.75rem; white-space:nowrap;">
            <button class="btn btn-secondary" title="Odpověď je použitelná" style="font-size:0.7rem;padding:1px 6px;" onclick="window.appInstance.ratePilot('${id}','dobre')">👍</button>
            <button class="btn btn-secondary" title="Odpověď má chybu" style="font-size:0.7rem;padding:1px 6px;" onclick="document.getElementById('${id}_d').style.display='inline-block'">👎</button>
            <select id="${id}_d" style="display:none; font-size:0.7rem;" onchange="window.appInstance.ratePilot('${id}','spatne',this.value)"><option value="">Co je špatně?</option>${sel}</select>
        </span>`;
    };

    P.ratePilot = async function (id, hodnoceni, duvod) {
        const el = document.getElementById(id);
        if (!el || el.dataset.hotovo) return;
        try {
            const res = await fetch(`${this.apiBase}/pilot-metriky/hodnoceni`, {
                method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ agentId: el.dataset.agent, taskKind: el.dataset.kind, hodnoceni, duvod: duvod || undefined })
            });
            el.dataset.hotovo = '1';
            el.innerHTML = res.ok ? '<span style="color:var(--text-muted);">Díky, zaznamenáno (bez textu).</span>' : '<span style="color:var(--accent-red);">Hodnocení se neuložilo.</span>';
        } catch (e) { el.innerHTML = '<span style="color:var(--accent-red);">Hodnocení se neuložilo.</span>'; }
    };

    const origLoad = P.loadManagerialTab;
    P.loadManagerialTab = async function () {
        const r = origLoad ? await origLoad.apply(this, arguments) : undefined;
        this.loadPilotMetriky();
        return r;
    };

    P.loadPilotMetriky = async function () {
        let card = document.getElementById('pilot-metriky-card');
        const kotva = document.getElementById('ai-costs-card');
        if (!card && kotva) {
            card = document.createElement('div');
            card.id = 'pilot-metriky-card'; card.className = 'glass';
            card.style.cssText = 'padding: 25px; border-radius: 16px; border: 1px solid var(--border-glass); margin-bottom: 25px;';
            kotva.parentNode.insertBefore(card, kotva.nextSibling);
        }
        if (!card) return;
        try {
            const res = await fetch(`${this.apiBase}/pilot-metriky`, { headers: this.getHeaders() });
            if (res.status === 403) { card.style.display = 'none'; return; }   // jen správce
            const d = await res.json();
            const pct = (v) => (v == null ? '—' : String(v).replace('.', ',') + ' %');
            const radky = (d.typy || []).map(t => `<tr>
                <td>${esc(TYPY[t.taskKind] || t.taskKind)}</td><td style="text-align:right">${t.dotazu}</td>
                <td style="text-align:right">${pct(t.pctNeovereneCitace)}</td><td style="text-align:right">${pct(t.pctBezOpory)}</td>
                <td style="text-align:right">${pct(t.pctOpravaPomohla)}</td><td style="text-align:right">${t.odepreno}</td>
                <td style="text-align:right">${pct(t.pctNedostupny)}</td><td style="text-align:right">${t.msPrumer == null ? '—' : (t.msPrumer / 1000).toFixed(1) + ' s'}</td>
                <td style="text-align:right">${t.hodnoceniDobre} / ${t.hodnoceniSpatne}</td></tr>`).join('');
            card.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
                    <h3 style="margin:0;">📊 Pilot — kvalita odpovědí</h3>
                    <a class="btn btn-secondary" style="font-size:0.75rem; padding:4px 10px;" href="${this.apiBase}/pilot-metriky/export.csv" onclick="event.preventDefault(); window.appInstance.downloadPilotCsv()">Export CSV</a>
                </div>
                <p class="subtext" style="margin:6px 0 12px;">Jen počty a kódy chyb — žádný text dotazů, odpovědí ani spisů. Data zůstávají v tomto počítači.${d.zapnuto ? '' : ' <b>Měření je vypnuté (LEXIS_PILOT_METRIKY=0).</b>'}</p>
                ${radky ? `<div style="overflow-x:auto;"><table style="width:100%; font-size:0.8rem; border-collapse:collapse;">
                    <thead><tr><th style="text-align:left">Typ úlohy</th>${['Dotazů', 'Neověřené citace', 'Bez opory', 'Oprava pomohla', 'Odepřeno', 'Výpadky', 'Doba', '👍 / 👎'].map(h => `<th style="text-align:right">${h}</th>`).join('')}</tr></thead>
                    <tbody>${radky}</tbody></table></div>` : '<div style="opacity:0.6;">Zatím žádné dotazy agentů.</div>'}`;
        } catch (e) { card.innerHTML = '<div style="opacity:0.6;">Měření pilotu se nepodařilo načíst.</div>'; }
    };

    P.downloadPilotCsv = async function () {
        try {
            const res = await fetch(`${this.apiBase}/pilot-metriky/export.csv`, { headers: this.getHeaders() });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const url = URL.createObjectURL(await res.blob());
            const a = document.createElement('a');
            a.href = url; a.download = `lexislocal-pilot-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (e) { alert('Export se nepodařil: ' + e.message); }
    };
})();
