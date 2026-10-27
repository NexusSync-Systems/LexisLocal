// app-spis-cloud.js — karta spisu: pravidla cloudové AI (stupeň citlivosti A–D + souhlas klienta).
// Načítá se v index.html PO app.js a app-spisova.js. Metody se přidávají na LexisLocalApp.prototype.
// Server (lib/cloud_policy.js) pravidla vynucuje sám — UI jen zobrazuje stav a posílá změny;
// tlačítka, která uživatel nesmí použít, se nezobrazí (opravneni z GET /api/spisy/:id/cloud).
// Data z API se escapují (escapeHtml) — XSS obrana.
const SPIS_CLOUD_PORADI = ['D', 'C', 'B', 'A']; // od nejméně po nejvíc citlivý

function spisCloudDatum(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('cs-CZ');
}
function spisCloudKdo(k) { return k && (k.name || k.id) ? (k.name || k.id) : 'neznámý uživatel'; }

/** Text o stavu cloudu v kanceláři (zda se pravidla spisu vůbec uplatní). */
function spisCloudKancelar(k) {
    if (!k) return { text: '', barva: 'var(--text-secondary)' };
    if (k.jenLokalne) return { text: 'Kancelář: režim jen lokálně — cloud je vypnutý pro všechny spisy', barva: 'var(--text-secondary)' };
    if (!k.cloudAktivni) return { text: 'Kancelář: cloud není zapnutý — vše běží lokálně; nastavení spisu platí, až se zapne', barva: 'var(--text-secondary)' };
    if (k.druh === 'cloud_eu') return { text: 'Kancelář: cloudový model Amazon Bedrock (EU) je zapnutý', barva: 'var(--accent-yellow)' };
    if (k.druh === 'prime_api') return { text: 'Kancelář: nastaveno přímé API — pro spisy je zablokované, dotazy jdou lokálně', barva: 'var(--accent-red)' };
    return { text: 'Kancelář: neznámý poskytovatel — pro spisy zablokováno', barva: 'var(--accent-red)' };
}

/** Řádek se souhlasem klienta (platný / odvolaný / žádný). */
function spisCloudSouhlasText(s, typy) {
    if (!s) return '<span style="opacity:0.7;">Souhlas klienta: nezaznamenán</span>';
    const typ = escapeHtml((typy && typy[s.typ]) || s.typ);
    const pozn = s.poznamka ? ` — <i>${escapeHtml(s.poznamka)}</i>` : '';
    if (s.stav === 'udelen') {
        return `Souhlas klienta: <b style="color:var(--accent-green);">udělen</b> · ${typ} · ${escapeHtml(spisCloudDatum(s.udelenoAt))}, zaznamenal(a) ${escapeHtml(spisCloudKdo(s.udelil))}${pozn}`;
    }
    if (s.stav === 'odvolan') {
        const d = s.duvodOdvolani ? ` (${escapeHtml(s.duvodOdvolani)})` : '';
        return `Souhlas klienta: <b style="color:var(--accent-red);">odvolán</b> ${escapeHtml(spisCloudDatum(s.odvolanoAt))}, zaznamenal(a) ${escapeHtml(spisCloudKdo(s.odvolal))}${d}`;
    }
    return '<span style="opacity:0.7;">Souhlas klienta: nezaznamenán</span>';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign(module.exports || {}, { spisCloudKancelar, spisCloudSouhlasText, spisCloudDatum, SPIS_CLOUD_PORADI });
}

if (typeof LexisLocalApp !== 'undefined') Object.assign(LexisLocalApp.prototype, {
    async renderSpisCloud(spisId) {
        const el = document.getElementById('ss-spis-cloud');
        if (!el) return;
        const sid = String(spisId).replace(/[^A-Za-z0-9_.:-]/g, '');
        let d;
        try { d = await this.ssGet(`/spisy/${encodeURIComponent(sid)}/cloud`); }
        catch (e) { el.innerHTML = ''; return; }
        const c = d.cloud || {};
        const stupne = d.stupne || {};
        const prava = d.opravneni || {};
        const k = spisCloudKancelar(d.kancelar);
        const btnStyle = 'font-size:0.75rem;padding:3px 10px;';
        const stupenBtns = SPIS_CLOUD_PORADI.slice().reverse().map(st => {
            const info = stupne[st] || {};
            const aktivni = st === c.stupen;
            const snizeni = SPIS_CLOUD_PORADI.indexOf(st) < SPIS_CLOUD_PORADI.indexOf(c.stupen);
            const smi = !aktivni && (snizeni ? prava.snizitStupen : prava.zvysitStupen);
            return `<button class="btn ${aktivni ? 'btn-primary' : 'btn-secondary'}" data-stupen="${st}" title="${escapeHtml(info.label || st)}: ${escapeHtml(info.popis || '')}${!aktivni && !smi ? ' (nemáte oprávnění)' : ''}"
                style="${btnStyle}min-width:36px;" ${aktivni || !smi ? 'disabled' : ''}>${st}</button>`;
        }).join('');
        const platny = !!c.platnySouhlas;
        const souhlasBtns = [];
        if (!platny && prava.udelitSouhlas && c.stupen !== 'A') {
            souhlasBtns.push(`<button class="btn btn-secondary" data-souhlas="spis" style="${btnStyle}">Zaznamenat souhlas pro tento spis</button>`);
            if (c.stupen === 'C' || c.stupen === 'D') souhlasBtns.push(`<button class="btn btn-secondary" data-souhlas="ramcovy" style="${btnStyle}">Rámcový souhlas (smlouva)</button>`);
        }
        if (platny && prava.odvolatSouhlas) souhlasBtns.push(`<button class="btn btn-secondary" data-odvolat="1" style="${btnStyle}color:var(--accent-red);">Klient souhlas odvolal</button>`);
        const z = c.zmena;
        const zmena = z && z.od && z.od !== c.stupen
            ? `<div style="margin-top:6px;font-size:0.74rem;opacity:0.75;">Poslední změna stupně: ${escapeHtml(z.od)} → ${escapeHtml(c.stupen)}, ${escapeHtml(spisCloudDatum(z.at))}, ${escapeHtml(spisCloudKdo(z.kdo))}${z.duvod ? ' — ' + escapeHtml(z.duvod) : ''}</div>` : '';
        const vyh = c.vyhodnoceni || {};
        el.innerHTML = `
            <div class="glass" style="padding:12px 14px;border-radius:10px;border:1px solid var(--border-glass);font-size:0.82rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                    <strong>☁️ Cloudová AI</strong>
                    <span style="font-size:0.72rem;color:${k.barva};">${escapeHtml(k.text)}</span>
                </div>
                <div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span>Stupeň citlivosti:</span>
                    <span style="display:inline-flex;gap:4px;">${stupenBtns}</span>
                    <b>${escapeHtml(c.stupenLabel || c.stupen || '')}</b>${c.stupenNastaven ? '' : ' <span style="opacity:0.6;">(výchozí — advokát zatím nezkontroloval)</span>'}
                </div>
                <div style="margin-top:6px;">${spisCloudSouhlasText(c.souhlas, d.typySouhlasu)}</div>
                <div style="margin-top:6px;">
                    ${c.cloudPovolen
                        ? '<span style="color:var(--accent-green);">✓ Dotazy k tomuto spisu smí do cloudu</span>' + (d.kancelar && d.kancelar.cloudAktivni ? '' : ' <span style="opacity:0.6;">(až kancelář cloud zapne)</span>')
                        : '🔒 Jen lokálně — ' + escapeHtml(vyh.duvod || '')}
                </div>
                ${souhlasBtns.length ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${souhlasBtns.join('')}</div>` : ''}
                ${zmena}
                <div id="ss-spis-cloud-msg" style="margin-top:6px;font-size:0.75rem;"></div>
            </div>`;
        const msg = (t, err) => { const m = document.getElementById('ss-spis-cloud-msg'); if (m) { m.textContent = t; m.style.color = err ? 'var(--accent-red)' : 'var(--accent-green)'; } };
        const post = async (path, body, ok) => {
            try {
                await this.ssSend(`/spisy/${encodeURIComponent(sid)}/cloud/${path}`, 'POST', body);
                // Celý detail znovu — změna se zapsala i do spisového deníku.
                if (typeof this.openSpis === 'function') await this.openSpis(sid);
                await this.renderSpisCloud(sid);
                msg(ok);
            } catch (e) { msg('Chyba: ' + e.message, true); }
        };
        el.querySelectorAll('[data-stupen]').forEach(b => b.addEventListener('click', async () => {
            const novy = b.dataset.stupen;
            const label = (stupne[novy] && stupne[novy].label) || novy;
            const snizeni = SPIS_CLOUD_PORADI.indexOf(novy) < SPIS_CLOUD_PORADI.indexOf(c.stupen);
            if (snizeni) {
                const duvod = await LexisUI.prompt(`Snížení stupně na ${label}. Odůvodnění (zapíše se do deníku spisu):`, '');
                if (duvod === null) return;
                if (duvod.trim().length < 5) { msg('Snížení stupně vyžaduje odůvodnění (aspoň pár slov).', true); return; }
                post('stupen', { stupen: novy, duvod: duvod.trim() }, `Stupeň změněn na ${label}.`);
            } else {
                if (!(await LexisUI.confirm(`Zvýšit stupeň citlivosti na ${label}?${novy === 'A' ? ' Spis pak do cloudu nepůjde ani se souhlasem klienta.' : ''}`))) return;
                post('stupen', { stupen: novy }, `Stupeň změněn na ${label}.`);
            }
        }));
        el.querySelectorAll('[data-souhlas]').forEach(b => b.addEventListener('click', async () => {
            const typ = b.dataset.souhlas;
            const pozn = await LexisUI.prompt(typ === 'ramcovy'
                ? 'Rámcový souhlas — kde je (např. smlouva o právních službách ze dne …, čl. …):'
                : 'Jak klient souhlas udělil (např. písemně dne …, doklad založen ve spisu):', '');
            if (pozn === null) return;
            if (pozn.trim().length < 5) { msg('Uveďte, jak byl souhlas udělen — doklad musí být dohledatelný.', true); return; }
            post('souhlas', { typ, poznamka: pozn.trim() }, 'Souhlas zaznamenán.');
        }));
        el.querySelectorAll('[data-odvolat]').forEach(b => b.addEventListener('click', async () => {
            const duvod = await LexisUI.prompt('Odvolání souhlasu — jak a kdy klient souhlas odvolal (např. telefonicky dnes v 10:15):', '');
            if (duvod === null) return;
            post('souhlas/odvolat', { duvod: duvod.trim() }, 'Odvolání zaznamenáno — další dotazy k tomuto spisu jen lokálně.');
        }));
    }
});
