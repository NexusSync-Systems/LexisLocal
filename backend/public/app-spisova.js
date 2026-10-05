// Jednotka lhůty česky a ve správném tvaru („15 dnů“, ne „15 day“ — test 2. 10. 2026).
function unitLabelCs(unit, amount) {
    const n = Math.abs(parseInt(amount, 10));
    const F = {
        day: ['den', 'dny', 'dnů'], week: ['týden', 'týdny', 'týdnů'],
        month: ['měsíc', 'měsíce', 'měsíců'], year: ['rok', 'roky', 'let']
    }[String(unit || '').toLowerCase()];
    if (!F) return String(unit || '');
    if (n === 1) return F[0];
    if (n >= 2 && n <= 4) return F[1];
    return F[2];
}
// Zbývající dny lhůty česky: „zbývá 5 dnů“, „dnes“, „2 dny po lhůtě“ (dřív „-2 dní“).
function daysLeftCs(d) {
    if (d === null || d === undefined || isNaN(d)) return '—';
    if (d === 0) return 'dnes';
    const n = Math.abs(d);
    const w = n === 1 ? 'den' : (n <= 4 ? 'dny' : 'dnů');
    return d > 0 ? `${n} ${w}` : `${n} ${w} po lhůtě`;
}
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(module.exports || {}, { unitLabelCs, daysLeftCs });

/**
 * app-spisova.js — dashboard: Spisová služba (spisy, lhůtník, skartace,
 * fakturace, nezařazené dokumenty) a AML / Onboarding klienta.
 * Prototype-mixin nad LexisLocalApp (načítá se po app.js). Vše přes API
 * /api/spisy, /api/lhutnik, /api/skartace, /api/fakturace, /api/aml.
 * Veškerá data z API se escapují (escapeHtml) — XSS obrana.
 */
const AML_FACTOR_LABEL = {
    ico_neplatne: 'Neplatné IČO', insolvence: 'Insolvence (ISIR)', registry_nedostupne: 'Registry nedostupné',
    ico_chybi: 'Chybí IČO', identifikace_neuplna: 'Neúplná identifikace', nazev_nesouhlasi: 'Název neodpovídá IČO',
    pep_shoda: 'Shoda s PEP seznamem', sankcni_shoda: 'Shoda se sankčním seznamem kanceláře', sankcni_shoda_oficialni: 'Shoda s oficiálním sankčním seznamem'
};
const SPIS_STAV_LABEL = { aktivni: 'aktivní', archiv: 'archiv', skartace: 'ke skartaci' };

Object.assign(LexisLocalApp.prototype, {

    // --- Fetch helpery ------------------------------------------------------
    async ssGet(path) {
        const res = await fetch(`${this.apiBase}${path}`, { headers: this.getHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    },
    async ssSend(path, method, body) {
        const res = await fetch(`${this.apiBase}${path}`, {
            method: method,
            headers: this.getHeaders({ 'Content-Type': 'application/json' }),
            body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    },

    // ===================== SPISOVÁ SLUŽBA ==================================
    async loadSpisovaTab() {
        this.loadSpisyList();
        this.loadLhutnik();
        this.loadSkartace();
        this.loadFakturace();
        this.loadUnfiled();
        this.loadNezarazenoDrafts();
    },

    async loadSpisyList() {
        const el = document.getElementById('ss-spisy-list');
        if (!el) return;
        try {
            const { spisy } = await this.ssGet('/spisy');
            if (!spisy.length) {
                el.innerHTML = '<div style="opacity:0.6;padding:20px;text-align:center;">Zatím žádné spisy. Použij „Synchronizovat z inboxu".</div>';
                return;
            }
            const stavBadge = { aktivni: '#22c55e', archiv: '#eab308', skartace: '#ef4444' };
            el.innerHTML = spisy.map(s => `
                <div class="glass" style="padding:14px;border-radius:12px;border:1px solid var(--border-glass);display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer;"
                     onclick="window.appInstance.openSpis('${safeId(s.id)}')">
                    <div>
                        <div style="font-weight:600;">${escapeHtml(s.spisZn || s.nazev || 'Bez značky')}</div>
                        <div style="font-size:0.8rem;opacity:0.7;">${escapeHtml(s.klient || 'Klient nezadán')}${s.protistrana ? ' × ' + escapeHtml(s.protistrana) : ''}</div>
                    </div>
                    <span style="font-size:0.7rem;padding:3px 8px;border-radius:20px;background:${stavBadge[s.stav] || '#64748b'}22;color:${stavBadge[s.stav] || '#94a3b8'};">${escapeHtml(SPIS_STAV_LABEL[s.stav] || s.stav)}</span>
                </div>`).join('');
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;padding:12px;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },

    async openSpis(id) {
        const el = document.getElementById('ss-spis-detail');
        if (!el) return;
        el.innerHTML = '<div style="opacity:0.6;padding:20px;">Načítám spis…</div>';
        try {
            const d = await this.ssGet(`/spisy/${id}`);
            const s = d.spis;
            const m = d.metrics;
            const docs = d.documents.map(f => `<li>${escapeHtml(f.fileName || f.id)}</li>`).join('') || '<li style="opacity:0.6;">žádné</li>';
            const dls = d.deadlines.map(dl => `<li>${escapeHtml(dl.date || '—')} — ${escapeHtml(String(dl.amount || ''))} ${escapeHtml(unitLabelCs(dl.unit, dl.amount))}${dl.needsReview ? ' <span style="color:#eab308;">(k ověření)</span>' : ''}</li>`).join('') || '<li style="opacity:0.6;">žádné</li>';
            const events = d.events.slice(-8).reverse().map(ev => `<li style="font-size:0.8rem;"><b>${escapeHtml(ev.type)}</b> — ${escapeHtml(ev.note)} <span style="opacity:0.5;">${escapeHtml((ev.createdAt || '').split('T')[0])}</span></li>`).join('') || '<li style="opacity:0.6;">žádné</li>';
            el.innerHTML = `
                <h3 style="margin-top:0;">${escapeHtml(s.spisZn || s.nazev)}</h3>
                <div style="font-size:0.85rem;opacity:0.8;margin-bottom:12px;">
                    Klient: ${escapeHtml(s.klient || '—')} · Protistrana: ${escapeHtml(s.protistrana || '—')} · Stav: <b>${escapeHtml(SPIS_STAV_LABEL[s.stav] || s.stav)}</b>
                    ${s.retentionUntil ? ' · Retence do: ' + escapeHtml(s.retentionUntil) : ''}
                </div>
                <div style="font-size:0.82rem;margin:-6px 0 12px;">
                    ⚖️ Soud: <b>${escapeHtml(s.soud || '—')}</b>${s.soudKod ? ' (kód ' + escapeHtml(s.soudKod) + ')' : ''} · Advokát: <b>${escapeHtml(s.odpovednyAdvokat || '—')}</b> ·
                    ${!(s.soud || s.soudKod) ? '<span style="color:#d97706;">jednání se nehlídají — doplňte soud</span>'
                        : s.hearingsCheckError ? '<span style="color:#d97706;">InfoJednání neověřeno: ' + escapeHtml(s.hearingsCheckError) + '</span>'
                        : s.hearingsCheckedAt ? 'InfoJednání ověřeno ' + escapeHtml(new Date(s.hearingsCheckedAt).toLocaleString('cs-CZ')) : 'čeká na první kontrolu'}
                    <button class="btn btn-secondary" style="font-size:0.72rem;padding:3px 8px;margin-left:6px;" onclick="window.appInstance.upravitSoudSpisu('${String(s.id).replace(/[^A-Za-z0-9_.:-]/g, '')}')">Upravit soud / advokáta</button>
                </div>
                ${this._isirSpisLine(s)}
                <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;font-size:0.85rem;">
                    <span>📄 Dokumentů: <b>${escapeHtml(String(m.documentsCount))}</b></span>
                    <span>⏳ Lhůt: <b>${escapeHtml(String(m.deadlinesCount))}</b> (${escapeHtml(String(m.deadlinesNeedsReview))} k ověření)</span>
                    <span>⚖️ Jednání: <b>${escapeHtml(String(m.hearingsCount))}</b></span>
                    <span>🕒 Čas: <b>${escapeHtml(String(m.timeHours))} hod</b></span>
                    <span>📅 Nejbližší lhůta: <b>${escapeHtml(m.nextDeadline || '—')}</b></span>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
                    <button class="btn btn-secondary" style="font-size:0.8rem;padding:6px 12px;" onclick="window.appInstance.setSpisStav('${safeId(s.id)}','aktivni')">Aktivní</button>
                    <button class="btn btn-secondary" style="font-size:0.8rem;padding:6px 12px;" onclick="window.appInstance.setSpisStav('${safeId(s.id)}','archiv')">Archivovat</button>
                    <button class="btn btn-secondary" style="font-size:0.8rem;padding:6px 12px;" onclick="window.appInstance.setSpisStav('${safeId(s.id)}','skartace')">Ke skartaci</button>
                    <button class="btn btn-primary" style="font-size:0.8rem;padding:6px 12px;" onclick="window.appInstance.fakturaZeSpisu('${safeId(s.id)}')">💶 Vystavit fakturu</button>
                    <button class="btn btn-secondary" style="font-size:0.8rem;padding:6px 12px;" onclick="window.appInstance.openSpisTimeline('${safeId(s.id)}')">🕒 Časová osa</button>
                    <button class="btn btn-secondary" style="font-size:0.8rem;padding:6px 12px;" onclick="window.appInstance.openSpisDrafts('${safeId(s.id)}')">📄 Koncepty</button>
                </div>
                <div id="ss-spis-access" style="margin-bottom:14px;"></div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
                    <div><h4 style="margin:0 0 6px;">Dokumenty</h4><ul style="margin:0;padding-left:18px;font-size:0.85rem;">${docs}</ul></div>
                    <div><h4 style="margin:0 0 6px;">Lhůty</h4><ul style="margin:0;padding-left:18px;font-size:0.85rem;">${dls}</ul></div>
                </div>
                <h4 style="margin:14px 0 6px;">Spisový deník</h4>
                <ul style="margin:0;padding-left:18px;">${events}</ul>`;
            if (typeof this.renderSpisAccess === 'function') this.renderSpisAccess(s.id);
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;padding:12px;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },

    async openSpisTimeline(id) {
        const el = document.getElementById('ss-spis-detail');
        if (!el) return;
        el.innerHTML = '<div style="opacity:0.6;padding:20px;">Načítám časovou osu…</div>';
        try {
            const tl = await this.ssGet(`/spisy/${id}/timeline`);
            const icon = { denik: '📝', audit: '🔒', dokument: '📄', lhuta: '⏳', jednani: '⚖️' };
            const rows = (tl.timeline || []).map(i => `<li style="font-size:0.82rem;margin-bottom:4px;">${icon[i.kind] || '•'} <span style="opacity:0.55;">${escapeHtml((i.time || '').replace('T', ' ').slice(0, 16))}</span> — ${escapeHtml(i.label || '')} <span style="opacity:0.4;">[${escapeHtml(i.kind)}]</span></li>`).join('') || '<li style="opacity:0.6;">Zatím žádné události.</li>';
            el.innerHTML = `
                <button class="btn btn-secondary" style="font-size:0.8rem;padding:6px 12px;margin-bottom:12px;" onclick="window.appInstance.openSpis('${safeId(id)}')">← Zpět na spis</button>
                <h3 style="margin:0 0 8px;">🕒 Časová osa spisu</h3>
                <div style="font-size:0.8rem;opacity:0.7;margin-bottom:10px;">Sloučeno: deník, audit, dokumenty, lhůty, jednání (${escapeHtml(String(tl.count))} událostí).</div>
                <ul style="margin:0;padding-left:18px;list-style:none;">${rows}</ul>`;
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;padding:12px;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },

    async openSpisDrafts(id) {
        const el = document.getElementById('ss-spis-detail');
        if (!el) return;
        el.innerHTML = '<div style="opacity:0.6;padding:20px;">Načítám koncepty…</div>';
        try {
            const { drafts } = await this.ssGet(`/spisy/${id}/drafts`);
            const rows = (drafts || []).map(d => `<li style="font-size:0.85rem;margin-bottom:4px;">📄 ${escapeHtml(d.fileName)} <span style="opacity:0.5;">${d.mtime ? escapeHtml(d.mtime.replace('T', ' ').slice(0, 16)) : ''}${d.size != null ? ' · ' + Math.round(d.size / 1024) + ' kB' : ''}</span></li>`).join('') || '<li style="opacity:0.6;">Ve složce spisu (03_Koncepty) zatím nejsou žádné koncepty.</li>';
            el.innerHTML = `
                <button class="btn btn-secondary" style="font-size:0.8rem;padding:6px 12px;margin-bottom:12px;" onclick="window.appInstance.openSpis('${safeId(id)}')">← Zpět na spis</button>
                <h3 style="margin:0 0 8px;">📄 Koncepty ve spisu</h3>
                <div style="font-size:0.8rem;opacity:0.7;margin-bottom:10px;">Soubory uložené ve složce <b>03_Koncepty</b> tohoto spisu.</div>
                <ul style="margin:0;padding-left:18px;list-style:none;">${rows}</ul>`;
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;padding:12px;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },

    async loadNezarazenoDrafts() {
        const el = document.getElementById('ss-nezarazeno-drafts');
        if (!el) return;
        try {
            const { files } = await this.ssGet('/spisy/nezarazeno-drafts');
            if (!files || !files.length) { el.innerHTML = '<div style="opacity:0.6;">Žádné koncepty ve složce _Nezařazeno. 👍</div>'; return; }
            el.innerHTML = files.map(f => `
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:0.85rem;">
                    <span style="flex:1;">📄 ${escapeHtml(f.fileName)}</span>
                    <span style="opacity:0.5;font-size:0.78rem;">${f.mtime ? escapeHtml(f.mtime.replace('T', ' ').slice(0, 16)) : ''}</span>
                </div>`).join('');
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },

    _mtgPayload() {
        const g = (id) => (document.getElementById(id) || {}).value || '';
        return {
            title: g('mtg-title') || 'Schůzka',
            location: g('mtg-loc'),
            date: g('mtg-date'),
            time: g('mtg-time'),
            durationMin: parseInt(g('mtg-dur'), 10) || 60,
            travelBufferMin: parseInt(g('mtg-buffer'), 10)
        };
    },
    async checkMeetingAvailability() {
        const el = document.getElementById('mtg-result');
        const p = this._mtgPayload();
        if (!p.date) { if (el) el.innerHTML = '<span style="color:#eab308;">Vyberte datum.</span>'; return; }
        if (el) el.textContent = 'Kontroluji…';
        try {
            const body = { date: p.date, durationMin: p.durationMin, travelBufferMin: p.travelBufferMin };
            if (p.time) body.time = p.time;
            const r = await this.ssSend('/calendar/availability', 'POST', body);
            if (p.time) {
                if (r.check && r.check.free) {
                    el.innerHTML = `<span style="color:#34d399;">✅ ${escapeHtml(r.check.start)}–${escapeHtml(r.check.end)} je volno (i s rezervou na dopravu).</span>`;
                } else {
                    const alts = (r.suggestions || []).map(s => escapeHtml(s.start)).slice(0, 8).join(', ');
                    el.innerHTML = `<span style="color:#f87171;">❌ Termín obsazený/mimo hodiny.</span>` + (alts ? `<div style="margin-top:4px;opacity:0.85;">Volné alternativy: ${alts}</div>` : '');
                }
            } else {
                const slots = (r.freeSlots || []).map(s => escapeHtml(s.start)).slice(0, 16).join(', ');
                el.innerHTML = slots ? `<div>Volné termíny (${escapeHtml(p.date)}): <b>${slots}</b></div>` : '<span style="opacity:0.7;">Ten den nejsou volné termíny.</span>';
            }
        } catch (e) { if (el) el.innerHTML = `<span style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</span>`; }
    },
    async bookMeeting() {
        const el = document.getElementById('mtg-result');
        const p = this._mtgPayload();
        if (!p.date || !p.time) { if (el) el.innerHTML = '<span style="color:#eab308;">Vyplňte datum i čas.</span>'; return; }
        if (el) el.textContent = 'Rezervuji…';
        try {
            const res = await fetch(`${this.apiBase}/calendar/book`, {
                method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(p)
            });
            const d = await res.json();
            if (res.status === 201 && d.success) {
                el.innerHTML = `<span style="color:#34d399;">✅ Rezervováno: ${escapeHtml(d.meeting.date)} ${escapeHtml(d.meeting.time)} (${escapeHtml(String(d.meeting.durationMin))} min).</span>`;
            } else if (res.status === 409) {
                const alts = (d.suggestions || []).map(s => escapeHtml(s.start)).slice(0, 8).join(', ');
                el.innerHTML = `<span style="color:#f87171;">❌ ${escapeHtml(d.error || 'Kolize.')}</span>` + (alts ? `<div style="margin-top:4px;opacity:0.85;">Volné alternativy: ${alts}</div>` : '');
            } else {
                el.innerHTML = `<span style="color:#f87171;">Chyba: ${escapeHtml(d.error || 'nezdařilo se')}</span>`;
            }
        } catch (e) { if (el) el.innerHTML = `<span style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</span>`; }
    },

    async syncSpisy() {
        try {
            const r = await this.ssSend('/spisy/sync', 'POST');
            alert(`Synchronizace hotova: založeno ${r.created} spisů, napojeno ${r.linkedFiles} dokumentů (${r.skippedNoCase} bez sp. zn.).`);
            this.loadSpisovaTab();
        } catch (e) { alert('Chyba synchronizace: ' + e.message); }
    },

    // Import stávajících spisů z CSV: nejdřív náhled, založení až po potvrzení.
    async importSpisyCsv(input) {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        const panel = document.getElementById('ss-import-panel');
        panel.hidden = false;
        panel.innerHTML = 'Načítám ' + escapeHtml(file.name) + '…';
        let csv;
        try {
            const buf = await file.arrayBuffer();
            csv = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch (e) {
            // Starší český Excel ukládá CSV ve Windows-1250.
            try { csv = new TextDecoder('windows-1250').decode(await file.arrayBuffer()); }
            catch (e2) { panel.innerHTML = '<span style="color:#f87171;">Soubor nejde přečíst.</span>'; return; }
        }
        this._ssImportCsv = csv;
        try {
            const r = await this.ssSend('/spisy/import', 'POST', { csv, dryRun: true });
            const s = r.summary;
            const rows = r.rows.filter(x => x.status !== 'nový' || x.reason).slice(0, 50);
            panel.innerHTML = `
                <h3 style="margin:0 0 6px;">Náhled importu: ${escapeHtml(file.name)}</h3>
                <p style="margin:0 0 8px;font-size:0.85rem;">Řádků ${s.total} · <b>nových ${s.nove}</b> · už existuje ${s.existuje} · duplicit v souboru ${s.duplicita} · chyb ${s.chyba}${s.upozorneni ? ` · upozornění ${s.upozorneni}` : ''}</p>
                <p style="margin:0 0 8px;font-size:0.78rem;opacity:0.8;">Rozpoznané sloupce: ${escapeHtml(r.columns.join(', '))}${r.unknownColumns.length ? ` · nerozpoznané (vynechají se): ${escapeHtml(r.unknownColumns.join(', '))}` : ''}</p>
                ${rows.length ? `<div style="max-height:180px;overflow:auto;font-size:0.78rem;margin-bottom:10px;">${rows.map(x => `<div>řádek ${x.line}: <b>${escapeHtml(x.status)}</b> ${escapeHtml(x.spisZn || x.nazev || '')}${x.reason ? ' — ' + escapeHtml(x.reason) : ''}</div>`).join('')}</div>` : ''}
                <div style="display:flex;gap:10px;">
                    <button class="btn btn-primary" id="ss-import-go" ${s.nove ? '' : 'disabled'}>Založit ${s.nove} spisů</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('ss-import-panel').hidden=true">Zrušit</button>
                </div>`;
            const go = document.getElementById('ss-import-go');
            if (go) go.addEventListener('click', async () => {
                go.disabled = true; go.textContent = 'Zakládám…';
                try {
                    const done = await this.ssSend('/spisy/import', 'POST', { csv: this._ssImportCsv, dryRun: false });
                    panel.innerHTML = `✅ Založeno ${done.summary.nove} spisů (už existovalo ${done.summary.existuje}, chyb ${done.summary.chyba}). Hlídače jednání a insolvencí je zkontrolují při nejbližším běhu.`;
                    this._ssImportCsv = null;
                    this.loadSpisovaTab();
                } catch (e) { panel.innerHTML = '<span style="color:#f87171;">Import selhal: ' + escapeHtml(e.message) + '</span>'; }
            });
        } catch (e) {
            panel.innerHTML = '<span style="color:#f87171;">' + escapeHtml(e.message) + '</span><p style="font-size:0.78rem;opacity:0.8;">Očekávaná hlavička např.: Spisová značka; Název; Klient; Protistrana; Soud; Advokát; Insolvence</p>';
        }
    },

    async novySpis() {
        const spisZn = await LexisUI.prompt('Spisová značka (např. 23 C 120/2026):');
        if (spisZn === null) return;
        const klient = await LexisUI.prompt('Klient (nepovinné):') || '';
        const soud = await LexisUI.prompt('Soud (např. Okresní soud v Jihlavě) — nutné pro hlídání jednání na InfoJednání:') || '';
        try {
            await this.ssSend('/spisy', 'POST', { spisZn: spisZn, klient: klient, soud: soud });
            this.loadSpisyList();
        } catch (e) { alert('Chyba: ' + e.message); }
    },

    // Insolvence (ISIR): sp. zn. „… INS …“ ze spisu nebo z pole insZn → hodinový hlídač stavu.
    _isirSpisLine(s) {
        const zn = s.insZn || (/\bINS\s*\d+\s*\/\s*\d{4}/i.test(s.spisZn || '') ? s.spisZn : '');
        const id = String(s.id).replace(/[^A-Za-z0-9_.:-]/g, '');
        const btn = `<button class="btn btn-secondary" style="font-size:0.72rem;padding:3px 8px;margin-left:6px;" onclick="window.appInstance.upravitInsZnSpisu('${id}')">${zn ? 'Změnit' : 'Sledovat insolvenci'}</button>`;
        if (!zn) return `<div style="font-size:0.82rem;margin:-6px 0 12px;opacity:0.85;">🏦 Insolvence (ISIR): nesleduje se ${btn}</div>`;
        const st = s.isirError ? `<span style="color:#d97706;">neověřeno: ${escapeHtml(s.isirError)}</span>`
            : s.isirStav ? `stav <b>${escapeHtml(s.isirStav)}</b>${s.isirCheckedAt ? ' · ověřeno ' + escapeHtml(new Date(s.isirCheckedAt).toLocaleString('cs-CZ')) : ''}`
            : 'čeká na první kontrolu';
        return `<div style="font-size:0.82rem;margin:-6px 0 12px;">🏦 Insolvence (ISIR): <b>${escapeHtml(zn)}</b> · ${st} ${btn}</div>`;
    },

    async upravitInsZnSpisu(id) {
        try {
            const d = await this.ssGet(`/spisy/${id}`);
            const s = d.spis || {};
            const v = await LexisUI.prompt('Spisová značka insolvenčního řízení ke sledování v ISIR (např. KSBR 56 INS 1000/2026; prázdné = nesledovat):', s.insZn || '');
            if (v === null) return;
            if (v.trim() && !/\bINS\s*\d+\s*\/\s*\d{4}/i.test(v)) { alert('Zadejte sp. zn. ve tvaru „KSBR 56 INS 1000/2026“ nebo „INS 1000/2026“.'); return; }
            await this.ssSend(`/spisy/${id}`, 'PATCH', { insZn: v.trim() });
            if (v.trim()) { try { await this.ssSend('/registries/isir/check-now', 'POST', {}); } catch (e) { /* ověří hodinový hlídač */ } }
            this.openSpis ? this.openSpis(id) : this.loadSpisyList();
        } catch (e) { alert('Chyba: ' + e.message); }
    },

    async upravitSoudSpisu(id) {
        try {
            const d = await this.ssGet(`/spisy/${id}`);
            const s = d.spis || {};
            const soud = await LexisUI.prompt('Soud (např. Okresní soud v Jihlavě):', s.soud || '');
            if (soud === null) return;
            const soudKod = await LexisUI.prompt('Kód soudu pro InfoJednání (nepovinné — jen pokud ho znáte):', s.soudKod || '');
            if (soudKod === null) return;
            const adv = await LexisUI.prompt('Odpovědný advokát:', s.odpovednyAdvokat || '');
            if (adv === null) return;
            await this.ssSend(`/spisy/${id}`, 'PATCH', { soud, soudKod, odpovednyAdvokat: adv });
            this.openSpis ? this.openSpis(id) : this.loadSpisyList();
        } catch (e) { alert('Chyba: ' + e.message); }
    },

    async setSpisStav(id, stav) {
        try {
            await this.ssSend(`/spisy/${id}/stav`, 'POST', { stav: stav });
            this.openSpis(id);
            this.loadSpisyList();
            this.loadSkartace();
        } catch (e) { alert('Chyba: ' + e.message); }
    },

    // --- Lhůtník ------------------------------------------------------------
    async loadLhutnik() {
        const el = document.getElementById('ss-lhutnik');
        if (!el) return;
        try {
            const { items, summary } = await this.ssGet('/lhutnik');
            const color = { overdue: '#ef4444', urgent: '#f97316', soon: '#eab308', ok: '#22c55e', unknown: '#64748b' };
            const head = `<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.8rem;margin-bottom:10px;">
                <span style="color:#ef4444;">Po termínu: ${escapeHtml(String(summary.overdue))}</span>
                <span style="color:#f97316;">Urgentní: ${escapeHtml(String(summary.urgent))}</span>
                <span style="color:#eab308;">Brzy: ${escapeHtml(String(summary.soon))}</span>
                <span style="color:#94a3b8;">K ověření: ${escapeHtml(String(summary.needsReview))}</span></div>`;
            if (!items.length) { el.innerHTML = head + '<div style="opacity:0.6;">Žádné lhůty.</div>'; return; }
            const rows = items.map(i => `
                <tr>
                    <td style="padding:6px;color:${color[i.urgency]};">${escapeHtml(i.date || '—')}</td>
                    <td style="padding:6px;">${escapeHtml(String(i.amount || ''))} ${escapeHtml(unitLabelCs(i.unit, i.amount))}</td>
                    <td style="padding:6px;font-size:0.8rem;">${escapeHtml(i.caseNumber || '—')}</td>
                    <td style="padding:6px;">${escapeHtml(daysLeftCs(i.daysLeft))}</td>
                    <td style="padding:6px;">${i.needsReview
                        ? `<button class="btn btn-primary" style="font-size:0.7rem;padding:3px 8px;" onclick="window.appInstance.confirmLhuta('${safeId(i.fileId)}',${Number(i.index)})">Potvrdit</button>
                           <button class="btn btn-secondary" style="font-size:0.7rem;padding:3px 8px;" onclick="window.appInstance.dismissLhuta('${safeId(i.fileId)}',${Number(i.index)})">Odložit</button>`
                        : '<span style="opacity:0.5;font-size:0.75rem;">✓</span>'}</td>
                </tr>`).join('');
            el.innerHTML = head + `<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
                <thead><tr style="opacity:0.6;text-align:left;"><th style="padding:6px;">Datum</th><th style="padding:6px;">Lhůta</th><th style="padding:6px;">Sp. zn.</th><th style="padding:6px;">Zbývá</th><th style="padding:6px;"></th></tr></thead>
                <tbody>${rows}</tbody></table>`;
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },
    async confirmLhuta(fileId, index) {
        try { await this.ssSend('/lhutnik/confirm', 'POST', { fileId, index }); this.loadLhutnik(); }
        catch (e) { alert('Chyba: ' + e.message); }
    },
    async dismissLhuta(fileId, index) {
        try { await this.ssSend('/lhutnik/dismiss', 'POST', { fileId, index }); this.loadLhutnik(); }
        catch (e) { alert('Chyba: ' + e.message); }
    },

    // --- Skartace -----------------------------------------------------------
    async loadSkartace() {
        const el = document.getElementById('ss-skartace');
        if (!el) return;
        try {
            const n = await this.ssGet('/skartace/navrh');
            const line = (arr, label, color) => arr.length
                ? `<div style="margin-bottom:8px;"><b style="color:${color};">${label} (${arr.length})</b><ul style="margin:4px 0;padding-left:18px;font-size:0.85rem;">${arr.map(s => `<li>${escapeHtml(s.spisZn)} ${s.retentionUntil ? '· do ' + escapeHtml(s.retentionUntil) : ''}</li>`).join('')}</ul></div>`
                : '';
            el.innerHTML =
                line(n.expired, '⚠️ Retence uplynula — návrh ke skartaci', '#ef4444') +
                line(n.inSkartace, '🗑️ Ve stavu skartace', '#f97316') +
                line(n.retained, '📦 V archivu (retence běží)', '#eab308') +
                (n.summary.expired + n.summary.inSkartace + n.summary.retained === 0 ? '<div style="opacity:0.6;">Žádné archivované spisy.</div>' : '') +
                (n.expired.length ? `<button class="btn btn-primary" style="font-size:0.8rem;padding:6px 12px;margin-top:6px;" onclick="window.appInstance.vytvorProtokol(${escapeHtml(JSON.stringify(n.expired.map(s => s.id)))})">Vytvořit skartační protokol</button>` : '');
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },
    async vytvorProtokol(ids) {
        if (!await LexisUI.confirm(`Vytvořit skartační protokol pro ${ids.length} spisů? (nic se nesmaže, jen se zaeviduje návrh)`)) return;
        try {
            const r = await this.ssSend('/skartace/protokol', 'POST', { spisIds: ids });
            alert(`Protokol vytvořen (${r.protokol.pocet} spisů). Skartaci proveďte vědomě podle předpisů ČAK.`);
            this.loadSkartace();
        } catch (e) { alert('Chyba: ' + e.message); }
    },

    // --- Fakturace ----------------------------------------------------------
    async loadFakturace() {
        const el = document.getElementById('ss-fakturace');
        if (!el) return;
        try {
            const o = await this.ssGet('/fakturace/outstanding');
            const rows = o.invoices.map(i => `<li>${escapeHtml(i.variabilniSymbol)} — ${escapeHtml(i.klient || i.spisZn || '')} — <b>${escapeHtml(String(i.toPay))} Kč</b>
                <button class="btn btn-secondary" style="font-size:0.7rem;padding:2px 8px;" onclick="window.appInstance.oznacUhrazeno('${safeId(i.id)}')">Uhrazeno</button></li>`).join('');
            el.innerHTML = `<div style="margin-bottom:8px;">Neuhrazeno: <b style="color:#f97316;">${escapeHtml(String(o.totalDue))} Kč</b> (${escapeHtml(String(o.count))} faktur)</div>
                <ul style="margin:0;padding-left:18px;font-size:0.85rem;">${rows || '<li style="opacity:0.6;">Žádné neuhrazené.</li>'}</ul>`;
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },
    async fakturaZeSpisu(spisId) {
        const rateStr = await LexisUI.prompt('Hodinová sazba (Kč, prázdné = výchozí z nastavení):', '');
        const dphStr = await LexisUI.prompt('Sazba DPH v % (0 pro neplátce):', '21');
        const body = { spisId, dphRate: parseFloat(dphStr) || 0 };
        if (rateStr && parseFloat(rateStr) > 0) body.rate = parseFloat(rateStr);
        try {
            const r = await this.ssSend('/fakturace/from-spis', 'POST', body);
            alert(`Faktura ${r.invoice.variabilniSymbol} vystavena: ${r.invoice.toPay} Kč.`);
            this.loadFakturace();
        } catch (e) { alert('Chyba: ' + e.message); }
    },
    async oznacUhrazeno(id) {
        try { await this.ssSend(`/fakturace/${id}/paid`, 'POST', {}); this.loadFakturace(); }
        catch (e) { alert('Chyba: ' + e.message); }
    },

    // --- Nezařazené dokumenty ----------------------------------------------
    async loadUnfiled() {
        const el = document.getElementById('ss-unfiled');
        if (!el) return;
        try {
            const [{ files }, { spisy }] = await Promise.all([this.ssGet('/spisy/unfiled'), this.ssGet('/spisy')]);
            if (!files.length) { el.innerHTML = '<div style="opacity:0.6;">Vše zařazeno. 👍</div>'; return; }
            const opts = spisy.filter(s => s.spisZn).map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.spisZn)}</option>`).join('');
            el.innerHTML = files.map(f => `
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:0.85rem;">
                    <span style="flex:1;">${escapeHtml(f.fileName || f.id)}</span>
                    <select id="assign-${escapeHtml(f.id)}" style="background:var(--sunken-1);color:var(--text-primary);border:1px solid var(--border-glass);border-radius:6px;padding:4px;">${opts}</select>
                    <button class="btn btn-secondary" style="font-size:0.7rem;padding:3px 8px;" onclick="window.appInstance.zaradit('${safeId(f.id)}')">Zařadit</button>
                </div>`).join('');
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },
    async zaradit(fileId) {
        const sel = document.getElementById(`assign-${fileId}`);
        if (!sel || !sel.value) { alert('Nejdřív vytvoř nějaký spis se sp. zn.'); return; }
        try {
            await this.ssSend(`/spisy/${sel.value}/assign-file`, 'POST', { fileId });
            this.loadUnfiled();
            this.loadSpisyList();
        } catch (e) { alert('Chyba: ' + e.message); }
    },

    // ===================== AML / ONBOARDING ================================
    async loadAmlTab() {
        this.loadAmlChecks();
        this.loadWatchlist();
    },
    async loadAmlChecks() {
        const el = document.getElementById('aml-checks');
        if (!el) return;
        try {
            const { checks } = await this.ssGet('/aml/checks');
            const color = { high: '#ef4444', medium: '#eab308', low: '#22c55e' };
            if (!checks.length) { el.innerHTML = '<div style="opacity:0.6;">Zatím žádné AML prověrky.</div>'; return; }
            el.innerHTML = checks.slice().reverse().map(c => `
                <div class="glass" style="padding:12px;border-radius:10px;border:1px solid var(--border-glass);margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;">
                        <b>${escapeHtml(c.jmeno)}</b>
                        <span style="color:${color[c.risk]};font-weight:600;">${escapeHtml(c.risk.toUpperCase())}</span>
                    </div>
                    <div style="font-size:0.8rem;opacity:0.8;">${escapeHtml(c.typ)}${c.ico ? ' · IČO ' + escapeHtml(c.ico) : ''}${c.registry && c.registry.inInsolvency ? ' · ⚠️ INSOLVENCE' : ''}</div>
                    ${c.factors.length ? `<div style="font-size:0.78rem;opacity:0.7;margin-top:4px;">${c.factors.map(f => `<div>• ${escapeHtml(AML_FACTOR_LABEL[f.code] || f.code)}${f.detail ? ` — <span style="opacity:0.85;">${escapeHtml(f.detail)}</span>` : ''}</div>`).join('')}</div>` : ''}
                    <div style="font-size:0.72rem;color:#eab308;margin-top:4px;">⚠️ Ověřte i vůči oficiálním PEP/sankčním seznamům.</div>
                </div>`).join('');
        } catch (e) {
            el.innerHTML = `<div style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</div>`;
        }
    },
    async loadWatchlist() {
        const el = document.getElementById('aml-watchlist');
        if (!el) return;
        try {
            const { watchlist } = await this.ssGet('/aml/watchlist');
            el.innerHTML = watchlist.length
                ? watchlist.map(w => `<li>${escapeHtml(w.name)} <span style="opacity:0.6;">(${escapeHtml(w.type)})</span></li>`).join('')
                : '<li style="opacity:0.6;">Prázdný lokální seznam.</li>';
        } catch (e) {
            el.innerHTML = `<li style="color:#f87171;">Chyba: ${escapeHtml(e.message)}</li>`;
        }
    },
    async amlIdentify(event) {
        if (event) event.preventDefault();
        const val = id => (document.getElementById(id) || {}).value || '';
        const body = {
            typ: val('aml-typ'), jmeno: val('aml-jmeno'), ico: val('aml-ico'),
            rc: val('aml-rc'), adresa: val('aml-adresa'), provedl: val('aml-provedl')
        };
        if (!body.jmeno.trim()) { alert('Zadej jméno/název klienta.'); return; }
        try {
            const r = await this.ssSend('/aml/identify', 'POST', body);
            alert(`AML prověrka hotova — riziko: ${r.check.risk.toUpperCase()}. Nezapomeňte na oficiální PEP/sankční screening.`);
            this.loadAmlChecks();
        } catch (e) { alert('Chyba: ' + e.message); }
    },
    async amlAddWatch(event) {
        if (event) event.preventDefault();
        const name = (document.getElementById('aml-watch-name') || {}).value || '';
        const type = (document.getElementById('aml-watch-type') || {}).value || 'PEP';
        if (!name.trim()) { alert('Zadej jméno.'); return; }
        try {
            await this.ssSend('/aml/watchlist', 'POST', { name, type });
            document.getElementById('aml-watch-name').value = '';
            this.loadWatchlist();
        } catch (e) { alert('Chyba: ' + e.message); }
    }
});
