// app-ai-costs.js — Manažerský přehled: náklady na cloudovou AI (Bedrock) a čára rozpočtu.
// Načítá se PO app-managerial.js; obaluje loadManagerialTab (bez zásahu do původního kódu).
// Data: GET /api/ai-usage/summary (živý odhad LexisLocal + dny potvrzené fakturací AWS).
(function () {
    if (typeof LexisLocalApp === 'undefined') return;
    const P = LexisLocalApp.prototype;
    const origLoad = P.loadManagerialTab;
    const usd = (n) => (n == null ? '—' : (Math.abs(n) < 10 ? Number(n).toFixed(2) : Number(n).toFixed(0)) + ' $');
    const dt = (iso) => { try { return new Date(iso).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };
    const dd = (den) => { const p = String(den).split('-'); return `${Number(p[2])}. ${Number(p[1])}.`; };
    const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' tis.' : String(n || 0);
    const STAV = { ok: ['var(--accent-green)', 'V rozpočtu'], varovani: ['var(--accent-yellow)', 'Blíží se rozpočtu'], prekroceno: ['var(--accent-red)', 'Rozpočet překročen'], bez_rozpoctu: ['var(--text-secondary)', 'Rozpočet nenastaven'] };

    P.loadManagerialTab = async function () {
        const r = origLoad ? await origLoad.apply(this, arguments) : undefined;
        this.loadAiCosts();
        if (!this._aiCostsTimer) {
            // Živě: obnova každých 30 s, jen když je přehled otevřený.
            this._aiCostsTimer = setInterval(() => {
                const pane = document.getElementById('tab-managerial');
                if (pane && pane.classList.contains('active') && !document.hidden) this.loadAiCosts(true);
            }, 30000);
        }
        return r;
    };

    P.loadAiCosts = async function (quiet) {
        const card = document.getElementById('ai-costs-card');
        if (!card) return;
        const sel = document.getElementById('ai-costs-month');
        const mesic = (sel && sel.value) || '';
        try {
            const res = await fetch(`${this.apiBase}/ai-usage/summary${mesic ? '?mesic=' + encodeURIComponent(mesic) : ''}`, { headers: this.getHeaders() });
            if (res.status === 403) { card.style.display = 'none'; return; }
            const s = await res.json();
            if (!res.ok) throw new Error(s.error || res.status);
            card.style.display = '';
            this.renderAiCosts(s);
        } catch (err) {
            if (!quiet) card.innerHTML = `<div style="opacity:.7;padding:10px;">Náklady na AI se nepodařilo načíst: ${escapeHtml(String(err.message || err))}</div>`;
        }
    };

    P.renderAiCosts = function (s) {
        const card = document.getElementById('ai-costs-card');
        const months = []; const d0 = new Date();
        for (let i = 0; i < 6; i++) { const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - i, 1)); months.push(d.toISOString().slice(0, 7)); }
        const [barva, stavText] = STAV[s.stav] || STAV.bez_rozpoctu;
        const pct = s.pct == null ? null : Math.min(100, s.pct);
        const kpi = (label, value, sub, color) => `<div class="glass" style="padding:12px 14px;border-radius:10px;background:var(--sf-02);border:1px solid var(--border-glass);">
            <div style="font-size:.72rem;opacity:.7;">${label}</div>
            <div style="font-size:1.25rem;font-weight:600;color:${color || 'var(--text-primary)'};margin:2px 0;">${value}</div>
            <div style="font-size:.72rem;opacity:.7;">${sub || ''}</div></div>`;
        const list = (title, rows, keyFn) => `<div><div style="font-size:.8rem;font-weight:600;margin-bottom:6px;">${title}</div>${rows.length ? rows.slice(0, 5).map(r =>
            `<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:3px 0;border-bottom:1px solid var(--border-glass);"><span>${escapeHtml(keyFn(r))}</span><span>${usd(r.odhadUsd)} · ${r.dotazu}×</span></div>`).join('') : '<div style="font-size:.75rem;opacity:.6;">Zatím nic.</div>'}</div>`;

        let syncInfo;
        if (s.sync) {
            const ok = s.sync.stav === 'sedi';
            syncInfo = `Poslední porovnání s fakturací AWS: <strong>${dt(s.sync.kdy)}</strong> (období ${dd(s.sync.obdobiOd)}–${dd(s.sync.obdobiDo)} bez dneška) — AWS ${usd(s.sync.awsUsd)}, odhad ${usd(s.sync.odhadUsd)}, rozdíl ${s.sync.rozdilUsd >= 0 ? '+' : ''}${usd(s.sync.rozdilUsd)} (${s.sync.rozdilPct} %) `
                + (ok ? '<span style="color:var(--accent-green);">✓ sedí</span>' : '<span style="color:var(--accent-yellow);">⚠ nesedí — zkontrolujte ceník; v grafu platí částky AWS</span>');
        } else {
            syncInfo = 'S fakturací AWS zatím neporovnáno.';
        }
        if (s.posledniPokus && s.posledniPokus.stav === 'chyba') syncInfo += `<br><span style="color:var(--accent-red);">Poslední pokus ${dt(s.posledniPokus.kdy)} selhal: ${escapeHtml(s.posledniPokus.chyba || '')}</span>`;
        syncInfo += s.synchronizaceZapnuta ? ` · automaticky každý večer po ${s.hodinaSynchronizace}:00` : ' · automatické porovnání je vypnuté (Bedrock není zapnutý)';

        card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:15px;flex-wrap:wrap;">
            <div>
                <h3 style="margin:0 0 6px;font-family:'Outfit',sans-serif;display:flex;gap:10px;align-items:center;"><span>🤖</span> Náklady na cloudovou AI</h3>
                <div style="font-size:.8rem;opacity:.7;">Odhad LexisLocal živě z každého dotazu (aktualizováno ${dt(s.aktualizovanoOdhad)}); dny potvrzené fakturací AWS podle AWS. Částky v USD bez odečtu kreditů.</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <select id="ai-costs-month" style="padding:7px 10px;background:var(--sf-03);border:1px solid var(--border-glass);border-radius:8px;color:var(--text-primary);">
                    ${months.map(m => `<option value="${m}" ${m === s.mesic ? 'selected' : ''}>${m}</option>`).join('')}
                </select>
                <button class="btn btn-secondary" id="ai-costs-sync" style="padding:8px 14px;font-size:.82rem;">Porovnat s AWS teď</button>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0 8px;">
            ${kpi('Utraceno tento měsíc', usd(s.celkem), s.rozpocet ? `z rozpočtu ${usd(s.rozpocet)} · ${s.pct} % · ${stavText}` : stavText, barva)}
            ${kpi('Potvrzeno AWS', usd(s.potvrzenoAws), s.sync ? `za dny do ${dd(s.sync.obdobiDo)} (bez něj)` : 'čeká na první porovnání')}
            ${kpi('Odhad od porovnání', usd(s.odhadOdSync), s.korekce !== 1 ? `opraveno poměrem AWS ${s.korekce}×` : 'z tokenů × ceník')}
            ${kpi('Výhled do konce měsíce', usd(s.vyhledDoKonceMesice), s.rozpocet && s.vyhledDoKonceMesice > s.rozpocet ? '<span style="color:var(--accent-red);">překročí rozpočet</span>' : 'při dosavadním tempu')}
            ${kpi('Dotazy', `${s.pocty.cloud} / ${s.pocty.lokalne}`, `cloud / lokálně · odepřeno ${s.pocty.odepreno} · tokeny ${fmtTok(s.tokeny.vstup)} → ${fmtTok(s.tokeny.vystup)}`)}
        </div>
        ${pct != null ? `<div style="height:8px;border-radius:4px;background:var(--sf-03);overflow:hidden;margin-bottom:12px;" title="${s.pct} % rozpočtu"><div style="height:100%;width:${pct}%;background:${barva};"></div></div>` : ''}
        <div id="ai-costs-chart">${this.aiCostsChart(s)}</div>
        <div style="font-size:.78rem;opacity:.85;margin-top:8px;line-height:1.5;">${syncInfo}${s.bezCeniku ? `<br><span style="color:var(--accent-yellow);">${s.bezCeniku} dotazů s modelem bez ceníku — doplňte ceník níže.</span>` : ''}${s.tvrdyStrop ? '<br>Tvrdý strop je zapnutý: po vyčerpání rozpočtu jdou dotazy jen na lokální model.' : ''}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px;margin-top:16px;">
            ${list('Podle spisů', s.poSpisech, r => r.spisZn)}
            ${list('Podle uživatelů', s.poUzivatelich, r => r.klic)}
            ${list('Podle modelů', s.poModelech, r => r.klic)}
        </div>
        <details style="margin-top:16px;" id="ai-costs-settings-box"><summary style="cursor:pointer;font-size:.85rem;font-weight:600;">Rozpočet a ceník</summary><div id="ai-costs-settings" style="margin-top:10px;font-size:.82rem;opacity:.7;">Načítám…</div></details>`;

        document.getElementById('ai-costs-month').onchange = () => this.loadAiCosts();
        document.getElementById('ai-costs-sync').onclick = (e) => this.syncAiCosts(e.target);
        document.getElementById('ai-costs-settings-box').addEventListener('toggle', (e) => { if (e.target.open) this.loadAiCostsSettings(); });
    };

    // Kumulativní spotřeba po dnech (plně = potvrzeno AWS, čárkovaně = odhad), výhled do konce
    // měsíce (tečkovaně), vodorovná čára rozpočtu a hranice varování.
    P.aiCostsChart = function (s) {
        const W = 700, H = 230, L = 52, R = 16, T = 14, B = 28;
        const n = s.dnuVMesici || 30;
        const max = Math.max(s.rozpocet || 0, s.vyhledDoKonceMesice || 0, s.celkem || 0, 1) * 1.12;
        const x = (i) => L + (W - L - R) * (i / Math.max(1, n - 1));
        const y = (v) => T + (H - T - B) * (1 - v / max);
        const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max / 1.12 * f);
        let g = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border-glass)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--text-secondary)">${usd(v)}</text>`).join('');
        for (let d = 1; d <= n; d += (n > 20 ? 5 : 2)) g += `<text x="${x(d - 1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-secondary)">${d}.</text>`;
        const pts = s.rada.map((r, i) => ({ x: x(i), y: y(r.kumulativne), zdroj: r.zdroj, v: r.kumulativne, den: r.den }));
        const awsPts = pts.filter(p => p.zdroj === 'aws');
        const odhIdx = pts.findIndex(p => p.zdroj === 'odhad');
        const odhPts = odhIdx >= 0 ? pts.slice(Math.max(0, odhIdx - 1)) : [];
        const line = (arr, extra) => arr.length > 1 ? `<polyline fill="none" points="${arr.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" ${extra}/>` : '';
        let svg = g;
        if (pts.length) svg += `<polygon points="${pts[0].x},${y(0)} ${pts.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')} ${pts[pts.length - 1].x},${y(0)}" fill="var(--accent-blue)" fill-opacity="0.07"/>`;
        svg += line(awsPts, 'stroke="var(--accent-green)" stroke-width="2.5"');
        svg += line(odhPts, 'stroke="var(--accent-blue)" stroke-width="2" stroke-dasharray="5 4"');
        const last = pts[pts.length - 1];
        if (last && s.mesic === new Date().toISOString().slice(0, 7) && pts.length < n) {
            svg += `<line x1="${last.x}" y1="${last.y}" x2="${x(n - 1)}" y2="${y(s.vyhledDoKonceMesice)}" stroke="var(--text-secondary)" stroke-width="1.5" stroke-dasharray="2 4"/>`;
            svg += `<text x="${x(n - 1)}" y="${y(s.vyhledDoKonceMesice) - 6}" text-anchor="end" font-size="10" fill="var(--text-secondary)">výhled ${usd(s.vyhledDoKonceMesice)}</text>`;
        }
        if (last) svg += `<circle cx="${last.x}" cy="${last.y}" r="4" fill="var(--accent-blue)"><title>${dd(last.den)}: ${usd(last.v)}</title></circle>`;
        if (s.rozpocet) {
            const yb = y(s.rozpocet), yw = y(s.rozpocet * s.varovaniPct / 100);
            svg += `<line x1="${L}" x2="${W - R}" y1="${yw}" y2="${yw}" stroke="var(--accent-yellow)" stroke-width="1" stroke-dasharray="3 3"/><text x="${W - R}" y="${yw - 4}" text-anchor="end" font-size="10" fill="var(--accent-yellow)">varování ${s.varovaniPct} %</text>`;
            svg += `<line x1="${L}" x2="${W - R}" y1="${yb}" y2="${yb}" stroke="var(--accent-red)" stroke-width="2" stroke-dasharray="8 4"/><text x="${L + 6}" y="${yb - 5}" font-size="11" font-weight="600" fill="var(--accent-red)">Rozpočet ${usd(s.rozpocet)}</text>`;
        }
        const legend = `<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:.72rem;opacity:.8;margin-top:4px;">
            <span><span style="display:inline-block;width:18px;border-top:2.5px solid var(--accent-green);vertical-align:middle;"></span> potvrzeno AWS</span>
            <span><span style="display:inline-block;width:18px;border-top:2px dashed var(--accent-blue);vertical-align:middle;"></span> odhad LexisLocal</span>
            <span><span style="display:inline-block;width:18px;border-top:1.5px dotted var(--text-secondary);vertical-align:middle;"></span> výhled</span>
            ${s.rozpocet ? '<span><span style="display:inline-block;width:18px;border-top:2px dashed var(--accent-red);vertical-align:middle;"></span> rozpočet</span>' : '<span>rozpočet nenastaven</span>'}</div>`;
        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;" role="img" aria-label="Kumulativní náklady na cloudovou AI a rozpočet">${svg}</svg>${legend}`;
    };

    P.syncAiCosts = async function (btn) {
        const t = btn.textContent; btn.disabled = true; btn.textContent = 'Porovnávám…';
        try {
            const res = await fetch(`${this.apiBase}/ai-usage/sync`, { method: 'POST', headers: this.getHeaders() });
            const j = await res.json();
            if (!res.ok && j.sync && j.sync.chyba) alert('Porovnání s AWS selhalo: ' + j.sync.chyba);
        } catch (e) { alert('Porovnání s AWS selhalo: ' + e.message); }
        btn.disabled = false; btn.textContent = t;
        this.loadAiCosts();
    };

    P.loadAiCostsSettings = async function () {
        const box = document.getElementById('ai-costs-settings');
        try {
            const res = await fetch(`${this.apiBase}/ai-usage/settings`, { headers: this.getHeaders() });
            const j = await res.json();
            const n = j.nastaveni;
            const inp = 'padding:6px 9px;background:var(--sf-03);border:1px solid var(--border-glass);border-radius:6px;color:var(--text-primary);';
            box.style.opacity = '1';
            box.innerHTML = `<form id="ai-costs-form" style="display:flex;flex-direction:column;gap:10px;">
                <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">
                    <label>Měsíční rozpočet (USD)<br><input type="number" min="0" step="1" name="rozpocet" value="${n.mesicniRozpocetUsd}" style="${inp}width:120px;"></label>
                    <label>Varování při (%)<br><input type="number" min="1" max="100" name="varovani" value="${n.varovaniPct}" style="${inp}width:90px;"></label>
                    <label>Tolerance porovnání s AWS (%)<br><input type="number" min="0" max="100" name="tolerance" value="${n.tolerancePct}" style="${inp}width:90px;"></label>
                    <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" name="strop" ${n.tvrdyStrop ? 'checked' : ''}> Tvrdý strop (po vyčerpání jen lokálně)</label>
                </div>
                <div style="font-size:.78rem;opacity:.75;">Ceník v USD za 1 milion tokenů; řádek platí pro model, jehož ID obsahuje „vzor“. Aktuální ceny: ceník AWS Bedrock pro EU profily.</div>
                <table style="font-size:.8rem;border-collapse:collapse;max-width:460px;" id="ai-costs-cenik">
                    <tr><th style="text-align:left;">Vzor modelu</th><th>Vstup</th><th>Výstup</th></tr>
                    ${n.cenik.map(c => `<tr><td><input name="vzor" value="${escapeHtml(c.vzor)}" style="${inp}width:140px;"></td><td><input name="vstup" type="number" step="0.01" min="0" value="${c.vstup}" style="${inp}width:90px;"></td><td><input name="vystup" type="number" step="0.01" min="0" value="${c.vystup}" style="${inp}width:90px;"></td></tr>`).join('')}
                    <tr><td><input name="vzor" placeholder="nový vzor" style="${inp}width:140px;"></td><td><input name="vstup" type="number" step="0.01" min="0" style="${inp}width:90px;"></td><td><input name="vystup" type="number" step="0.01" min="0" style="${inp}width:90px;"></td></tr>
                </table>
                <div><button type="submit" class="btn btn-secondary" style="padding:8px 14px;font-size:.82rem;">Uložit</button> <span id="ai-costs-saved" style="font-size:.78rem;"></span></div>
            </form>`;
            document.getElementById('ai-costs-form').onsubmit = (e) => this.saveAiCostsSettings(e);
        } catch (e) { box.textContent = 'Nastavení se nepodařilo načíst: ' + e.message; }
    };

    P.saveAiCostsSettings = async function (e) {
        e.preventDefault();
        const f = e.target;
        const rows = [...document.querySelectorAll('#ai-costs-cenik tr')].slice(1).map(tr => ({
            vzor: tr.querySelector('[name=vzor]').value.trim(), vstup: tr.querySelector('[name=vstup]').value, vystup: tr.querySelector('[name=vystup]').value
        })).filter(r => r.vzor && r.vstup !== '' && r.vystup !== '').map(r => ({ vzor: r.vzor, vstup: Number(r.vstup), vystup: Number(r.vystup) }));
        const body = { mesicniRozpocetUsd: Number(f.rozpocet.value || 0), varovaniPct: Number(f.varovani.value || 80), tolerancePct: Number(f.tolerance.value || 5), tvrdyStrop: f.strop.checked, cenik: rows };
        const msg = document.getElementById('ai-costs-saved');
        try {
            const res = await fetch(`${this.apiBase}/ai-usage/settings`, { method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error || res.status);
            msg.textContent = '✓ Uloženo'; msg.style.color = 'var(--accent-green)';
            this.loadAiCosts();
        } catch (err) { msg.textContent = 'Chyba: ' + err.message; msg.style.color = 'var(--accent-red)'; }
    };
})();
