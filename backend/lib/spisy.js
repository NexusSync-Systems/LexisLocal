/**
 * LexisLocal — Spisová služba: SPIS jako entita prvního řádu.
 *
 * Dosud byl systém dokumentově orientovaný: soubory žily v `inbox_files`,
 * čas ve `activities` (klíč = název dokumentu), rozpočty v `managerial`.
 * Tento modul povyšuje SPIS na samostatný objekt, který drží pohromadě klienta,
 * protistranu, agendu, odpovědného advokáta, ŽIVOTNÍ CYKLUS (aktivní → archiv →
 * skartace) a agreguje na sebe navázané dokumenty, lhůty, jednání, čas a úkony.
 *
 * Zásady:
 *  • Nedestruktivní — nesahá na `inbox_files`; spisy jsou nová vrstva nad nimi.
 *  • Napojení přes spisovou značku (sp. zn.) — tolerantní na mezery/velikost písmen.
 *  • Nic se automaticky nemaže (skartace jen navrhne; smazání je vědomý úkon uživatele).
 *
 * Kolekce v database.js: `spisy`, `spis_events` (chronologický přehled úkonů).
 */
'use strict';

const db = require('./database');

// Životní cyklus spisu.
const STAVY = ['aktivni', 'archiv', 'skartace'];

// Výchozí retenční doba (roky) pro archivaci. POZOR: konkrétní délka je právní
// rozhodnutí (stavovské předpisy ČAK, u AML agend zák. 253/2008 delší) — proto
// je jen VÝCHOZÍ a lze ji na spisu přepsat polem `retentionYears`. Nic se ale
// nikdy nemaže automaticky, i po uplynutí retence se spis jen označí k návrhu.
const DEFAULT_RETENTION_YEARS = 5;

// --- Pomocné: normalizace sp. zn. pro párování ------------------------------
function _normCase(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}
function _caseKey(s) {
    return _normCase(s).toLowerCase();
}
// „Neznámá sp. zn." a prázdné hodnoty NEjsou platný párovací klíč.
function _isRealCase(s) {
    const k = _caseKey(s);
    return k.length > 0 && k !== _caseKey('Neznámá sp. zn.');
}

// --- Přístup k inbox dokumentům bez závislosti na watcher/chokidar ----------
// watcher.js táhne chokidar (a další); pro čtení stačí kolekce z databáze, kterou
// watcher stejně používá jako úložiště (`inbox_files`).
function _allInboxFiles() {
    return db.get('inbox_files') || [];
}
function _filesForCase(spisZn) {
    if (!_isRealCase(spisZn)) return [];
    const key = _caseKey(spisZn);
    return _allInboxFiles().filter(f => _caseKey(f.caseNumber) === key);
}

// --- Chronologický přehled úkonů (spisový deník) ----------------------------
function addEvent(spisId, type, note, meta) {
    if (!spisId) return null;
    return db.insert('spis_events', {
        spisId: spisId,
        type: String(type || 'poznamka'),
        note: note ? String(note) : '',
        meta: meta && typeof meta === 'object' ? meta : undefined
    });
}
function getEvents(spisId) {
    return (db.get('spis_events') || [])
        .filter(e => e.spisId === spisId)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// --- CRUD -------------------------------------------------------------------
function listSpisy() {
    return db.get('spisy') || [];
}
function getSpis(id) {
    return (db.get('spisy') || []).find(s => s.id === id) || null;
}
// Najde spis podle sp. zn. (tolerantně). Vrací první shodu nebo null.
function findByCase(spisZn) {
    if (!_isRealCase(spisZn)) return null;
    const key = _caseKey(spisZn);
    return (db.get('spisy') || []).find(s => _caseKey(s.spisZn) === key) || null;
}

function createSpis(data) {
    data = data || {};
    const spisZn = _normCase(data.spisZn);
    const nazev = data.nazev ? String(data.nazev).trim() : '';
    if (!spisZn && !nazev) {
        throw new Error('Spis musí mít alespoň spisovou značku nebo název.');
    }
    // Nezakládat duplicitu na stejnou reálnou sp. zn.
    if (_isRealCase(spisZn)) {
        const existing = findByCase(spisZn);
        if (existing) return existing;
    }
    const stav = STAVY.includes(data.stav) ? data.stav : 'aktivni';
    const spis = db.insert('spisy', {
        spisZn: spisZn,
        nazev: nazev,
        klient: data.klient ? String(data.klient).trim() : '',
        klientIco: data.klientIco ? String(data.klientIco).replace(/\s+/g, '') : '',
        protistrana: data.protistrana ? String(data.protistrana).trim() : '',
        agenda: data.agenda ? String(data.agenda).trim() : '',
        odpovednyAdvokat: data.odpovednyAdvokat ? String(data.odpovednyAdvokat).trim() : '',
        // Soud (název) a volitelně kód soudu pro InfoJednání — bez nich nejde hlídat jednání.
        soud: data.soud ? String(data.soud).trim() : '',
        soudKod: data.soudKod ? String(data.soudKod).trim() : '',
        // ACL přístupu ke spisu (viz access.js). Vlastník = odpovědný advokát,
        // jinak implicitní 'local'. V solo režimu se přístup nevynucuje.
        access: {
            owner: (data.odpovednyAdvokat ? String(data.odpovednyAdvokat).trim() : '') || (data.owner ? String(data.owner) : 'local'),
            readers: [],
            writers: []
        },
        stav: stav,
        poznamka: data.poznamka ? String(data.poznamka) : '',
        retentionYears: Number.isFinite(data.retentionYears) ? data.retentionYears : DEFAULT_RETENTION_YEARS,
        source: data.source || 'manual'
    });
    addEvent(spis.id, 'zalozeni', `Spis založen (${spis.spisZn || spis.nazev}).`);
    return spis;
}

function updateSpis(id, patch) {
    const spis = getSpis(id);
    if (!spis) return null;
    const clean = {};
    ['nazev', 'klient', 'protistrana', 'agenda', 'odpovednyAdvokat', 'poznamka', 'soud', 'soudKod'].forEach(k => {
        if (patch[k] !== undefined) clean[k] = String(patch[k]);
    });
    if (patch.spisZn !== undefined) clean.spisZn = _normCase(patch.spisZn);
    if (patch.klientIco !== undefined) clean.klientIco = String(patch.klientIco).replace(/\s+/g, '');
    if (patch.retentionYears !== undefined && Number.isFinite(patch.retentionYears)) {
        clean.retentionYears = patch.retentionYears;
    }
    const updated = db.update('spisy', id, clean);
    addEvent(id, 'uprava', 'Údaje spisu upraveny.');
    return updated;
}

/**
 * Změna stavu spisu (životní cyklus). Nikdy nemaže data.
 *  • archiv     → doplní archivedAt + retentionUntil (dle retentionYears),
 *  • skartace   → doplní skartaceProposedAt (jen NÁVRH; smazání je vědomý úkon),
 *  • aktivni    → zpět do práce (vyčistí archivní/skartační značky).
 */
function setStav(id, stav, baseNow) {
    const spis = getSpis(id);
    if (!spis) return null;
    if (!STAVY.includes(stav)) {
        throw new Error(`Neplatný stav spisu: ${stav}. Povolené: ${STAVY.join(', ')}.`);
    }
    const now = baseNow ? new Date(baseNow) : new Date();
    const patch = { stav: stav };
    if (stav === 'archiv') {
        patch.archivedAt = now.toISOString();
        const years = Number.isFinite(spis.retentionYears) ? spis.retentionYears : DEFAULT_RETENTION_YEARS;
        const until = new Date(now.getTime());
        until.setFullYear(until.getFullYear() + years);
        patch.retentionUntil = until.toISOString().split('T')[0];
        patch.skartaceProposedAt = null;
    } else if (stav === 'skartace') {
        patch.skartaceProposedAt = now.toISOString();
    } else if (stav === 'aktivni') {
        patch.archivedAt = null;
        patch.retentionUntil = null;
        patch.skartaceProposedAt = null;
    }
    const updated = db.update('spisy', id, patch);
    addEvent(id, 'stav', `Stav spisu změněn na „${stav}".`,
        stav === 'archiv' ? { retentionUntil: patch.retentionUntil } : undefined);
    return updated;
}

// Smazání spisové HLAVIČKY (ne dokumentů). Povoleno jen ve stavu 'skartace' —
// pojistka proti nechtěné ztrátě; skutečné dokumenty v inboxu zůstávají.
function deleteSpis(id) {
    const spis = getSpis(id);
    if (!spis) return null;
    if (spis.stav !== 'skartace') {
        throw new Error('Spis lze odstranit až po jeho převedení do stavu „skartace".');
    }
    return db.delete('spisy', id);
}

// --- Agregace lhůt z navázaných dokumentů -----------------------------------
// Sjednotí primární denní lhůtu (deadlineDate) i jednotkové lhůty
// (detectedDeadlines[] s needsReview) ze všech dokumentů spisu.
function _deadlinesFromFiles(files) {
    const out = [];
    files.forEach(f => {
        if (f.deadlineDate) {
            out.push({
                date: f.deadlineDate,
                unit: 'day',
                amount: f.deadlineDays || null,
                source: 'primary',
                needsReview: false,
                fileName: f.fileName,
                context: f.summary || ''
            });
        }
        (f.detectedDeadlines || []).forEach(d => {
            out.push({
                date: d.deadlineDate || null,
                unit: d.unit,
                amount: d.amount,
                source: d.source || 'detected',
                needsReview: d.needsReview !== false,
                fileName: f.fileName,
                context: d.context || ''
            });
        });
    });
    return out.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

// --- Agregace času z activities (klíč = documentName ~ název souboru) --------
function _timeSecondsForFiles(files) {
    const names = new Set();
    files.forEach(f => {
        if (f.fileName) names.add(f.fileName);
        if (f.relativePath) names.add(f.relativePath);
    });
    if (names.size === 0) return 0;
    return (db.get('activities') || [])
        .filter(a => a.documentName && names.has(a.documentName))
        .reduce((s, a) => s + (a.activeSeconds || 0), 0);
}

// --- Napojení jednání (best-effort, z .hearings.json) -----------------------
function _hearingsForCase(spisZn) {
    if (!_isRealCase(spisZn)) return [];
    try {
        const { loadMonitoredHearings } = require('./hearings');
        const { WATCH_DIR } = require('./config');
        const key = _caseKey(spisZn);
        return (loadMonitoredHearings(WATCH_DIR) || [])
            .filter(h => _caseKey(h.caseNumber || h.spisZn || '') === key);
    } catch (e) {
        return [];
    }
}

/**
 * Kompletní detail spisu se vším navázaným obsahem a spočtenými metrikami.
 */
function getSpisDetail(id) {
    const spis = getSpis(id);
    if (!spis) return null;
    const files = _filesForCase(spis.spisZn);
    const deadlines = _deadlinesFromFiles(files);
    const timeSeconds = _timeSecondsForFiles(files);
    const hearings = _hearingsForCase(spis.spisZn);
    const events = getEvents(id);

    const today = new Date().toISOString().split('T')[0];
    const upcoming = deadlines.filter(d => d.date && d.date >= today);

    return {
        spis: spis,
        documents: files,
        deadlines: deadlines,
        hearings: hearings,
        events: events,
        metrics: {
            documentsCount: files.length,
            deadlinesCount: deadlines.length,
            deadlinesNeedsReview: deadlines.filter(d => d.needsReview).length,
            nextDeadline: upcoming.length ? upcoming[0].date : null,
            hearingsCount: hearings.length,
            timeSeconds: timeSeconds,
            timeHours: parseFloat((timeSeconds / 3600).toFixed(2))
        }
    };
}

/**
 * Migrace/synchronizace: z existujících `inbox_files` odvodí spisy podle sp. zn.
 * Idempotentní a nedestruktivní — existující spisy nemění, jen doplní chybějící.
 * Klienta/protistranu předvyplní z prvního dokumentu (žalobce/žalovaný).
 * Vrací { created, linkedFiles, skippedNoCase }.
 */
function syncFromInbox() {
    const files = _allInboxFiles();
    const byCase = {};
    let skippedNoCase = 0;
    files.forEach(f => {
        if (!_isRealCase(f.caseNumber)) { skippedNoCase++; return; }
        const key = _caseKey(f.caseNumber);
        if (!byCase[key]) byCase[key] = { spisZn: _normCase(f.caseNumber), files: [] };
        byCase[key].files.push(f);
    });

    let created = 0;
    let linkedFiles = 0;
    Object.values(byCase).forEach(group => {
        linkedFiles += group.files.length;
        if (findByCase(group.spisZn)) return; // už existuje
        const first = group.files.find(f => f.plaintiff || f.defendant) || group.files[0];
        createSpis({
            spisZn: group.spisZn,
            klient: (first && first.plaintiff && first.plaintiff !== 'Nezjištěn') ? first.plaintiff : '',
            protistrana: (first && first.defendant && first.defendant !== 'Nezjištěn') ? first.defendant : '',
            klientIco: (first && first.ico) ? first.ico : '',
            soud: (group.files.find(f => f.court) || {}).court || '',
            source: 'inbox-sync'
        });
        created++;
    });

    return { created, linkedFiles, skippedNoCase };
}

// --- Automatické roztřídění dokumentů/ISDS do spisů dle sp. zn. -------------
// Zajistí existenci spisu pro reálnou sp. zn. (volá se při příjmu dokumentu ve
// watcher.js/paperless.js → nový dokument se sám „zařadí" do spisu). Idempotentní.
function ensureSpisForCase(caseNumber, meta) {
    if (!_isRealCase(caseNumber)) return null;
    const existing = findByCase(caseNumber);
    if (existing) return existing;
    meta = meta || {};
    const bad = v => !v || v === 'Nezjištěn' || v === 'Neznámý';
    return createSpis({
        spisZn: caseNumber,
        klient: bad(meta.klient) ? '' : meta.klient,
        protistrana: bad(meta.protistrana) ? '' : meta.protistrana,
        klientIco: meta.klientIco || meta.ico || '',
        source: meta.source || 'auto'
    });
}

// Dokumenty bez rozpoznané sp. zn. — čekají na ruční zařazení do spisu.
function listUnfiled() {
    return _allInboxFiles().filter(f => !_isRealCase(f.caseNumber));
}

// Ruční zařazení dokumentu do spisu: nastaví mu sp. zn. cílového spisu (naváže ho).
function assignFileToSpis(fileId, spisId) {
    const spis = getSpis(spisId);
    if (!spis) throw new Error('Spis nenalezen.');
    if (!_isRealCase(spis.spisZn)) throw new Error('Cílový spis nemá platnou spisovou značku.');
    const files = db.get('inbox_files') || [];
    const idx = files.findIndex(f => f.id === fileId);
    if (idx === -1) throw new Error('Dokument nenalezen.');
    files[idx] = { ...files[idx], caseNumber: spis.spisZn, filedAt: new Date().toISOString() };
    db.set('inbox_files', files);
    addEvent(spis.id, 'zarazeni', `Do spisu zařazen dokument „${files[idx].fileName || fileId}".`);
    return files[idx];
}

/**
 * getSpisTimeline — SJEDNOCENÁ časová osa spisu. Sloučí spisový deník, auditní
 * stopu spisu, příchozí dokumenty, lhůty a jednání do jednoho chronologického
 * proudu. Každá položka: { time, kind, type, label, source, ...meta }.
 * Položky bez data se řadí na konec.
 */
function getSpisTimeline(id) {
    const spis = getSpis(id);
    if (!spis) return null;
    const items = [];

    // 1) spisový deník (úkony)
    getEvents(id).forEach(e => items.push({
        time: e.createdAt || null,
        kind: 'denik',
        type: e.type || 'poznamka',
        label: e.note || '',
        source: 'spis_events',
        meta: e.meta || null
    }));

    // 2) auditní stopa spisu (filtrovaná přes spisId)
    try {
        const audit = require('./audit');
        (audit.getLogsForSpis(id) || []).forEach(e => items.push({
            time: e.timestamp || null,
            kind: 'audit',
            type: e.operation || 'úkon',
            label: ((e.operation || '') + (e.target ? ' — ' + e.target : '')).trim(),
            source: 'audit',
            user: e.user || null,
            meta: e.details || null
        }));
    } catch (e) { /* audit best-effort */ }

    // 3) příchozí dokumenty spisu
    const files = _filesForCase(spis.spisZn);
    files.forEach(f => items.push({
        time: f.filedAt || f.processedAt || null,
        kind: 'dokument',
        type: 'prijem',
        label: f.fileName || f.relativePath || 'dokument',
        source: 'inbox_files',
        meta: { caseNumber: f.caseNumber || null }
    }));

    // 4) lhůty
    _deadlinesFromFiles(files).forEach(d => items.push({
        time: d.date || null,
        kind: 'lhuta',
        type: d.needsReview ? 'lhuta-k-overeni' : 'lhuta',
        label: ('Lhůta' + (d.amount ? ' ' + d.amount + ' ' + (d.unit || '') : '') + (d.date ? ' → ' + d.date : '')).trim(),
        source: 'deadlines',
        meta: { fileName: d.fileName || null, needsReview: !!d.needsReview }
    }));

    // 5) jednání
    _hearingsForCase(spis.spisZn).forEach(h => items.push({
        time: h.date || h.hearingDate || null,
        kind: 'jednani',
        type: 'jednani',
        label: ('Jednání' + (h.date ? ' ' + h.date : '') + (h.court ? ', ' + h.court : '')).trim(),
        source: 'hearings',
        meta: h
    }));

    items.sort((a, b) => {
        const ta = a.time || '', tb = b.time || '';
        if (!ta && !tb) return 0;
        if (!ta) return 1;
        if (!tb) return -1;
        return String(ta).localeCompare(String(tb));
    });

    return { spis: spis, timeline: items, count: items.length };
}

/**
 * Sdílení spisu s kolegou (firemní režim). Přidá userId do readers/writers ACL,
 * zapíše do spisového deníku i auditu (se spisId) a promítne owner/přístup do
 * vizitky složky. level: 'read' | 'write'.
 */
function shareSpis(id, userId, level) {
    const spis = getSpis(id);
    if (!spis) throw new Error('Spis nenalezen.');
    if (!userId) throw new Error('Chybí userId příjemce.');
    const lvl = level === 'write' ? 'write' : 'read';
    const access = require('./access').grant(spis, userId, lvl);
    const updated = db.update('spisy', id, { access });
    addEvent(id, 'sdileni', 'Spis sdílen s „' + userId + '" (' + (lvl === 'write' ? 'čtení+zápis' : 'jen čtení') + ').', { userId, level: lvl });
    try { require('./audit').logEvent('Spisová služba', 'Sdílení spisu', spis.spisZn || spis.nazev, { spisId: id, userId, level: lvl }); } catch (e) { /* audit best-effort */ }
    try {
        const sf = require('./spisFolders');
        const f = sf.findFolderBySpisId(id);
        if (f && f.folderPath) { const m = sf.readMarker(f.folderPath) || {}; m.access = access; sf.writeMarker(f.folderPath, m); }
    } catch (e) { /* vizitka best-effort */ }
    return updated;
}

/** Odebrání přístupu kolegovi (owner nelze odebrat). */
function revokeSpisAccess(id, userId) {
    const spis = getSpis(id);
    if (!spis) throw new Error('Spis nenalezen.');
    const access = require('./access').revoke(spis, userId);
    const updated = db.update('spisy', id, { access });
    addEvent(id, 'odebrani-pristupu', 'Odebrán přístup „' + userId + '".', { userId });
    try { require('./audit').logEvent('Spisová služba', 'Odebrání přístupu ke spisu', spis.spisZn || spis.nazev, { spisId: id, userId }); } catch (e) { /* audit best-effort */ }
    try {
        const sf = require('./spisFolders');
        const f = sf.findFolderBySpisId(id);
        if (f && f.folderPath) { const m = sf.readMarker(f.folderPath) || {}; m.access = access; sf.writeMarker(f.folderPath, m); }
    } catch (e) { /* vizitka best-effort */ }
    return updated;
}

/** Aktuální ACL spisu (owner/readers/writers). */
function getSpisAccess(id) {
    const spis = getSpis(id);
    if (!spis) return null;
    return require('./access').normalizeAccess(spis);
}

module.exports = {
    STAVY,
    DEFAULT_RETENTION_YEARS,
    listSpisy,
    getSpis,
    findByCase,
    createSpis,
    updateSpis,
    setStav,
    deleteSpis,
    addEvent,
    getEvents,
    getSpisDetail,
    getSpisTimeline,
    syncFromInbox,
    ensureSpisForCase,
    listUnfiled,
    assignFileToSpis,
    shareSpis,
    revokeSpisAccess,
    getSpisAccess,
    // exportováno pro testy
    _normCase,
    _caseKey,
    _isRealCase
};
