/**
 * lib/drafts.js — sdílené KONCEPTY dokumentů (webový „LexisEditor Lite“ v LexisLocalu).
 *
 * Obsah konceptu = LexisEditor „spec“ ({ blocks: [...] }) — stejný formát, jaký LexisEditor
 * vnořuje do .docx. Díky tomu jde koncept bez ztráty struktury otevřít v desktopovém
 * editoru (export .docx s vnořeným spec) a agenti pracují se strukturou, ne s HTML.
 *
 * Pravidla:
 *  • Každé uložení = nová VERZE (kdo, kdy, AI/člověk, poznámka). Nic se nepřepisuje.
 *  • Optimistická kontrola souběhu: ukládá se vůči `baseVersion` → při rozdílu 409
 *    (nikdo nepřepíše cizí změny potichu — ani agent úpravy advokáta).
 *  • Zámek při editaci (TTL) — dokud koncept upravuje člověk, agent do něj nezapíše.
 *  • Stavy: koncept → ke_kontrole → schvaleno. SCHVÁLIT smí jen člověk (ne agent);
 *    schválený koncept je jen pro čtení (pro úpravu ho člověk vrátí do konceptu).
 *  • Výstup AI je označen (aiGenerated, verze kind:'ai') — EU AI Act čl. 50; schválením
 *    se u zdrojového záznamu v transparency ledgeru nastaví humanApproved.
 *  • Podpis a odeslání se tu NEdělají (podpis = LexisEditor u advokáta).
 *
 * Úložiště: šifrované JSON přes lib/store (kolekce 'drafts').
 */
'use strict';

const crypto = require('crypto');
const store = require('./store');

const COLLECTION = 'drafts';
const STATUSES = ['koncept', 'ke_kontrole', 'schvaleno'];
const STATUS_LABELS = { koncept: 'Koncept', ke_kontrole: 'Ke kontrole', schvaleno: 'Schváleno' };
const LOCK_TTL_MS = 10 * 60 * 1000;
const MAX_VERSIONS = 50;
const MAX_BLOCKS = 5000;
const MAX_TEXT = 20000;
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const ALIGNS = ['left', 'center', 'right', 'justify'];

class DraftError extends Error {
    constructor(message, status, extra) { super(message); this.status = status || 400; Object.assign(this, extra || {}); }
}

const _s = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max || MAX_TEXT);
const _id = (v) => (typeof v === 'string' && /^[A-Za-z0-9_\-:.]{1,64}$/.test(v)) ? v : undefined;
const _now = () => new Date().toISOString();

function _safeLink(u) {
    const s = String(u || '').trim();
    return /^(https?:\/\/|mailto:)/i.test(s) ? s.slice(0, 2000) : undefined;
}

// ── Validace spec (whitelist) ─────────────────────────────────────────────────
function _runs(runs) {
    if (!Array.isArray(runs)) return [];
    return runs.slice(0, 2000).map(r => {
        const o = { text: _s(r && r.text) };
        if (r && r.bold) o.bold = true;
        if (r && r.italic) o.italic = true;
        if (r && r.underline) o.underline = true;
        const l = r && _safeLink(r.link); if (l) o.link = l;
        return o;
    }).filter(r => r.text !== '');
}

function _block(b) {
    if (!b || typeof b !== 'object') return null;
    const id = _id(b.id);
    let o = null;
    switch (b.type) {
        case 'paragraph': {
            o = { type: 'paragraph' };
            const runs = _runs(b.runs);
            if (runs.length && runs.some(r => r.bold || r.italic || r.underline || r.link)) o.runs = runs;
            else o.text = runs.length ? runs.map(r => r.text).join('') : _s(b.text);
            if (ALIGNS.includes(b.align) && b.align !== 'left') o.align = b.align;
            if (b.footnote != null && b.footnote !== '') o.footnote = _s(b.footnote, 4000);
            break;
        }
        case 'heading': {
            const lvl = parseInt(b.level, 10);
            o = { type: 'heading', level: lvl >= 1 && lvl <= 3 ? lvl : 2, text: _s(b.text, 1000) };
            break;
        }
        case 'list':
            o = { type: 'list', ordered: !!b.ordered, items: (Array.isArray(b.items) ? b.items : []).slice(0, 1000).map(i => _s(i)) };
            break;
        case 'table':
            o = {
                type: 'table',
                cells: (Array.isArray(b.cells) ? b.cells : []).slice(0, 500)
                    .map(row => (Array.isArray(row) ? row : []).slice(0, 30).map(c => _s(c, 4000)))
            };
            break;
        case 'pageBreak': o = { type: 'pageBreak' }; break;
        case 'toc': o = { type: 'toc' }; break;
        default: return null; // neznámé typy (a cokoli s HTML) zahodíme
    }
    if (id) o.id = id;
    return o;
}

/** Vrátí bezpečnou kopii spec. letterheadHtml/watermark z API NEPŘEBÍRÁ (viz preserved). */
function validateSpec(spec) {
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.blocks)) throw new DraftError('Obsah konceptu musí mít tvar { blocks: [...] }.');
    if (spec.blocks.length > MAX_BLOCKS) throw new DraftError('Dokument je příliš dlouhý.');
    const out = { blocks: spec.blocks.map(_block).filter(Boolean) };
    if (Buffer.byteLength(JSON.stringify(out)) > MAX_SPEC_BYTES) throw new DraftError('Dokument je příliš velký.', 413);
    return out;
}

// ── Převody ───────────────────────────────────────────────────────────────────
function _inline(line) {
    // **tučně**, *kurzíva*, __podtržení__ (výstup jazykových modelů je markdown)
    const runs = [];
    const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*)/g;
    let last = 0, m;
    while ((m = re.exec(line))) {
        if (m.index > last) runs.push({ text: line.slice(last, m.index) });
        if (m[2] != null) runs.push({ text: m[2], bold: true });
        else if (m[3] != null) runs.push({ text: m[3], underline: true });
        else runs.push({ text: m[4], italic: true });
        last = re.lastIndex;
    }
    if (last < line.length) runs.push({ text: line.slice(last) });
    return runs;
}

/** Text (i markdown z modelu) → spec. Každý neprázdný řádek = odstavec (adresy, hlavičky podání). */
function textToSpec(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let list = null, table = null;
    const flush = () => { if (list) { blocks.push(list); list = null; } if (table) { blocks.push(table); table = null; } };
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        const t = line.trim();
        if (!t) { flush(); continue; }
        let m;
        if (/^\|.*\|$/.test(t)) {
            if (list) { blocks.push(list); list = null; }
            if (/^\|[\s:\-|]+\|$/.test(t)) continue; // oddělovač tabulky
            table = table || { type: 'table', cells: [] };
            table.cells.push(t.slice(1, -1).split('|').map(c => c.trim().replace(/\*\*/g, '')));
            continue;
        }
        if (table) { blocks.push(table); table = null; }
        if ((m = t.match(/^(#{1,3})\s+(.+)$/))) { flush(); blocks.push({ type: 'heading', level: m[1].length, text: m[2].replace(/\*\*/g, '') }); continue; }
        if ((m = t.match(/^(?:[-*•])\s+(.+)$/))) {
            if (!list || list.ordered) { flush(); list = { type: 'list', ordered: false, items: [] }; }
            list.items.push(m[1].replace(/\*\*/g, '')); continue;
        }
        if ((m = t.match(/^\d{1,3}[.)]\s+(.+)$/))) {
            if (!list || !list.ordered) { flush(); list = { type: 'list', ordered: true, items: [] }; }
            list.items.push(m[1].replace(/\*\*/g, '')); continue;
        }
        flush();
        if (/^[-_*]{3,}$/.test(t)) continue; // horizontální čára z markdownu
        const runs = _inline(t);
        const plain = runs.map(r => r.text).join('');
        const p = { type: 'paragraph' };
        // Krátký řádek VELKÝMI písmeny (ŽALOBA, PLNÁ MOC) = titulek podání → tučně na střed.
        if (plain.length <= 60 && /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(plain) && plain === plain.toUpperCase() && /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]{3}/.test(plain)) {
            p.runs = [{ text: plain, bold: true }]; p.align = 'center';
        } else if (runs.some(r => r.bold || r.italic || r.underline)) p.runs = runs;
        else p.text = plain;
        blocks.push(p);
    }
    flush();
    return validateSpec({ blocks });
}

function _blockText(b) {
    switch (b.type) {
        case 'heading': return b.text;
        case 'paragraph': return (b.runs ? b.runs.map(r => r.text).join('') : (b.text || '')) + (b.footnote ? ` [pozn.: ${b.footnote}]` : '');
        case 'list': return b.items.map((it, i) => (b.ordered ? `${i + 1}. ` : '- ') + it).join('\n');
        case 'table': return b.cells.map(r => '| ' + r.join(' | ') + ' |').join('\n');
        default: return '';
    }
}
/** spec → prostý text (pro agenty, RAG, náhledy). */
function specToText(spec) {
    return ((spec && spec.blocks) || []).map(_blockText).filter(s => s !== '').join('\n\n');
}

const _e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function _runsHtml(b) {
    if (!b.runs) return _e(b.text || '');
    return b.runs.map(r => {
        let h = _e(r.text);
        if (r.bold) h = `<strong>${h}</strong>`;
        if (r.italic) h = `<em>${h}</em>`;
        if (r.underline) h = `<u>${h}</u>`;
        if (r.link) h = `<a href="${_e(r.link)}">${h}</a>`;
        return h;
    }).join('');
}
/** spec → HTML (vše escapované) — pro export .docx a náhled. */
function specToHtml(spec) {
    return ((spec && spec.blocks) || []).map(b => {
        switch (b.type) {
            case 'heading': return `<h${b.level}>${_e(b.text)}</h${b.level}>`;
            case 'paragraph': {
                const st = b.align ? ` style="text-align:${b.align}"` : '';
                return `<p${st}>${_runsHtml(b)}${b.footnote ? ` <sup>[${_e(b.footnote)}]</sup>` : ''}</p>`;
            }
            case 'list': { const t = b.ordered ? 'ol' : 'ul'; return `<${t}>${b.items.map(i => `<li>${_e(i)}</li>`).join('')}</${t}>`; }
            case 'table': return `<table border="1" style="border-collapse:collapse;width:100%">${b.cells.map(r => `<tr>${r.map(c => `<td>${_e(c)}</td>`).join('')}</tr>`).join('')}</table>`;
            case 'pageBreak': return '<p style="page-break-after:always"></p>';
            default: return '';
        }
    }).join('\n');
}

// ── Úložiště ─────────────────────────────────────────────────────────────────
function _all() { return store.get(COLLECTION) || []; }
function _find(id) { return _all().find(d => d.id === id && !d.deleted) || null; }
function _put(draft) {
    draft.updatedAt = _now();
    const all = _all();
    const i = all.findIndex(d => d.id === draft.id);
    if (i === -1) all.push(draft); else all[i] = draft;
    store.set(COLLECTION, all);
    return draft;
}

function _who(principal) {
    const p = principal || {};
    return { userId: p.userId || 'local', name: p.name || 'Místní uživatel', kind: p.kind === 'agent' ? 'agent' : (p.kind || 'user') };
}
const _isAgent = (principal, source) => (principal && principal.kind === 'agent') || !!(source && source.agentId);

function _lockActive(d) { return d.lock && Date.parse(d.lock.until) > Date.now(); }

function summary(d) {
    const cur = d.versions[d.versions.length - 1];
    const text = specToText(cur.spec);
    return {
        id: d.id, title: d.title, spisId: d.spisId || null, caseNumber: d.caseNumber || null,
        status: d.status, statusLabel: STATUS_LABELS[d.status], version: d.version,
        aiGenerated: !!d.aiGenerated, source: d.source || null,
        createdBy: d.createdBy, lastAuthor: cur.author, lastKind: cur.kind,
        lock: _lockActive(d) ? { userId: d.lock.userId, name: d.lock.name, until: d.lock.until } : null,
        openComments: (d.comments || []).filter(c => !c.resolved).length,
        preview: text.slice(0, 240), createdAt: d.createdAt, updatedAt: d.updatedAt,
        approvedBy: d.approvedBy || null, approvedAt: d.approvedAt || null
    };
}

function view(d) {
    const cur = d.versions[d.versions.length - 1];
    return Object.assign(summary(d), {
        spec: cur.spec,
        hasLetterhead: !!(d.preserved && d.preserved.letterheadHtml),
        versions: d.versions.map(v => ({ v: v.v, at: v.at, author: v.author, kind: v.kind, note: v.note || '' })),
        comments: d.comments || []
    });
}

/**
 * Založí koncept. { title, spisId, caseNumber, spec | text, source, preserved, status }
 * source = { type:'agent'|'orchestrator'|'user'|'import', agentId, agentName, model, transparencyId }
 */
function createDraft(input, principal) {
    input = input || {};
    const spec = input.spec ? validateSpec(input.spec) : textToSpec(input.text || '');
    if (!spec.blocks.length) throw new DraftError('Koncept je prázdný.');
    const who = _who(principal);
    const ai = _isAgent(principal, input.source) || input.source && (input.source.type === 'agent' || input.source.type === 'orchestrator');
    const title = _s(input.title, 200).trim() || (specToText(spec).split('\n')[0] || 'Koncept').slice(0, 80);
    const d = {
        id: 'drf_' + crypto.randomBytes(8).toString('hex'),
        title,
        spisId: _id(input.spisId) || null,
        caseNumber: input.caseNumber ? _s(input.caseNumber, 80) : null,
        status: ai ? 'ke_kontrole' : (STATUSES.includes(input.status) && input.status !== 'schvaleno' ? input.status : 'koncept'),
        aiGenerated: !!ai,
        source: input.source ? {
            type: _s(input.source.type, 20) || null, agentId: input.source.agentId ? _s(input.source.agentId, 64) : null,
            agentName: input.source.agentName ? _s(input.source.agentName, 100) : null, model: input.source.model ? _s(input.source.model, 100) : null,
            transparencyIds: [].concat(input.source.transparencyId || [], input.source.transparencyIds || []).map(x => _s(x, 64)).slice(0, 20)
        } : null,
        createdBy: who,
        createdAt: _now(),
        version: 1,
        versions: [{ v: 1, at: _now(), author: who, kind: ai ? 'ai' : 'human', note: _s(input.note || (ai ? 'Návrh AI' : 'Založení'), 300), spec }],
        comments: [],
        lock: null,
        preserved: input.preserved && input.preserved.letterheadHtml ? { letterheadHtml: _s(input.preserved.letterheadHtml, 200000) } : null
    };
    return _put(d);
}

function listDrafts(filter) {
    filter = filter || {};
    return _all().filter(d => !d.deleted)
        .filter(d => !filter.spisId || d.spisId === filter.spisId)
        .filter(d => !filter.status || d.status === filter.status)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map(summary);
}

function getDraft(id) { return _find(id); }

function getVersion(id, v) {
    const d = _find(id); if (!d) return null;
    return d.versions.find(x => x.v === parseInt(v, 10)) || null;
}

/** Uloží novou verzi. { spec|text, baseVersion, note } */
function saveVersion(id, input, principal) {
    input = input || {};
    const d = _find(id);
    if (!d) throw new DraftError('Koncept nenalezen.', 404);
    const who = _who(principal);
    const agent = _isAgent(principal, input.source);
    if (d.status === 'schvaleno') throw new DraftError('Koncept je schválený — pro úpravu ho nejdřív vraťte do stavu Koncept.', 409, { code: 'approved' });
    if (_lockActive(d) && d.lock.userId !== who.userId) {
        throw new DraftError(`Koncept právě upravuje ${d.lock.name} — zkuste to později.`, 423, { code: 'locked', lock: d.lock });
    }
    const base = parseInt(input.baseVersion, 10);
    if (!Number.isFinite(base)) throw new DraftError('Chybí baseVersion (verze, ze které úprava vychází).');
    if (base !== d.version) {
        throw new DraftError(`Koncept mezitím změnil(a) ${d.versions[d.versions.length - 1].author.name} (verze ${d.version}). Načtěte aktuální verzi a úpravu zopakujte.`, 409, { code: 'conflict', currentVersion: d.version });
    }
    const spec = input.spec ? validateSpec(input.spec) : textToSpec(input.text || '');
    if (!spec.blocks.length) throw new DraftError('Koncept nesmí být prázdný.');
    const prev = d.versions[d.versions.length - 1].spec;
    if (JSON.stringify(prev) === JSON.stringify(spec)) return { draft: d, unchanged: true };
    d.version += 1;
    d.versions.push({ v: d.version, at: _now(), author: who, kind: agent ? 'ai' : 'human', note: _s(input.note || (agent ? 'Úprava AI' : ''), 300), spec });
    if (d.versions.length > MAX_VERSIONS) d.versions.splice(1, d.versions.length - MAX_VERSIONS); // první verzi necháváme
    if (agent) {
        d.aiGenerated = true;
        d.status = 'ke_kontrole';
        if (input.source && input.source.transparencyId) {
            d.source = d.source || { type: 'agent', transparencyIds: [] };
            d.source.transparencyIds = (d.source.transparencyIds || []).concat(_s(input.source.transparencyId, 64)).slice(-20);
        }
    }
    _put(d);
    return { draft: d, unchanged: false };
}

function acquireLock(id, principal) {
    const d = _find(id);
    if (!d) throw new DraftError('Koncept nenalezen.', 404);
    const who = _who(principal);
    if (who.kind === 'agent') throw new DraftError('Agent koncept nezamyká — ukládá verze přes baseVersion.', 403);
    if (_lockActive(d) && d.lock.userId !== who.userId) throw new DraftError(`Koncept právě upravuje ${d.lock.name}.`, 423, { code: 'locked', lock: d.lock });
    d.lock = { userId: who.userId, name: who.name, until: new Date(Date.now() + LOCK_TTL_MS).toISOString() };
    _put(d);
    return d.lock;
}

function releaseLock(id, principal) {
    const d = _find(id);
    if (!d) throw new DraftError('Koncept nenalezen.', 404);
    const who = _who(principal);
    if (d.lock && (d.lock.userId === who.userId || !_lockActive(d))) { d.lock = null; _put(d); }
    return true;
}

/** Změna stavu. Schválit smí jen člověk. Vrací draft. */
function setStatus(id, status, principal) {
    const d = _find(id);
    if (!d) throw new DraftError('Koncept nenalezen.', 404);
    if (!STATUSES.includes(status)) throw new DraftError('Neznámý stav.');
    const who = _who(principal);
    if (who.kind === 'agent' && status === 'schvaleno') throw new DraftError('Agent nesmí koncept schválit — schvaluje advokát.', 403);
    if (who.kind === 'agent' && d.status === 'schvaleno') throw new DraftError('Agent nesmí měnit schválený koncept.', 403);
    if (_lockActive(d) && d.lock.userId !== who.userId) throw new DraftError(`Koncept právě upravuje ${d.lock.name}.`, 423, { code: 'locked', lock: d.lock });
    d.status = status;
    if (status === 'schvaleno') {
        d.approvedBy = who; d.approvedAt = _now(); d.approvedVersion = d.version;
        _markHumanApproved(d);
    } else { d.approvedBy = null; d.approvedAt = null; d.approvedVersion = null; }
    return _put(d);
}

// Schválení člověkem → transparency ledger (pole humanApproved/approvedAt nejsou v hashi řetězce).
function _markHumanApproved(d) {
    const ids = (d.source && d.source.transparencyIds) || [];
    if (!ids.length) return;
    try {
        const db = require('./database');
        ids.forEach(tid => { try { db.update('transparency_logs', tid, { humanApproved: true, approvedAt: _now() }); } catch (e) { /* záznam nemusí existovat */ } });
    } catch (e) { /* ledger je doplněk */ }
}

function addComment(id, input, principal) {
    const d = _find(id);
    if (!d) throw new DraftError('Koncept nenalezen.', 404);
    const text = _s(input && input.text, 4000).trim();
    if (!text) throw new DraftError('Komentář je prázdný.');
    const c = { id: 'c_' + crypto.randomBytes(5).toString('hex'), at: _now(), author: _who(principal), text, blockId: _id(input && input.blockId) || null, resolved: false };
    d.comments = (d.comments || []).concat(c).slice(-500);
    _put(d);
    return c;
}

function resolveComment(id, commentId, principal) {
    const d = _find(id);
    if (!d) throw new DraftError('Koncept nenalezen.', 404);
    const c = (d.comments || []).find(x => x.id === commentId);
    if (!c) throw new DraftError('Komentář nenalezen.', 404);
    c.resolved = true; c.resolvedBy = _who(principal); c.resolvedAt = _now();
    _put(d);
    return c;
}

function deleteDraft(id, principal) {
    const d = _find(id);
    if (!d) throw new DraftError('Koncept nenalezen.', 404);
    if (_who(principal).kind === 'agent') throw new DraftError('Agent koncept mazat nesmí.', 403);
    d.deleted = true; d.deletedAt = _now(); d.deletedBy = _who(principal);
    _put(d);
    return true;
}

/** Spec pro LexisEditor (vč. zachované hlavičky a označení AI). */
function editorSpec(d) {
    const cur = d.versions[d.versions.length - 1];
    const spec = JSON.parse(JSON.stringify(cur.spec));
    // Název NEdáváme do spec.title — LexisEditor ho vykreslí jako tučný řádek navíc a po
    // uložení zpět by se titulek v textu zdvojil (test 2. 10. 2026). Název nese pole `title`.
    if (d.preserved && d.preserved.letterheadHtml) spec.letterheadHtml = d.preserved.letterheadHtml;
    if (d.aiGenerated) spec.aiDisclosure = { generatedBy: 'LexisLocal AI', humanApproved: d.status === 'schvaleno' };
    return spec;
}

/** .docx s vnořeným spec (LexisEditor ho otevře bez ztráty struktury). */
async function exportDocx(d) {
    const HTMLtoDOCX = require('html-to-docx');
    const spec = editorSpec(d);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${_e(d.title)}</title></head><body>${specToHtml(spec)}</body></html>`;
    const out = await HTMLtoDOCX(html, null, { title: d.title, creator: 'LexisLocal', lang: 'cs-CZ', table: { row: { cantSplit: true } } });
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(out instanceof ArrayBuffer ? new Uint8Array(out) : await out.arrayBuffer());
    return embedSpec(buf, spec);
}

// Stejný formát jako LexisEditor js/export/spec-embed.js (customXml/item1.xml).
const SPEC_NS = 'urn:lexiseditor:spec';
async function embedSpec(docxBuffer, spec) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(docxBuffer);
    const b64 = Buffer.from(JSON.stringify(spec || {}), 'utf-8').toString('base64');
    zip.file('customXml/item1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><lexisSpec xmlns="${SPEC_NS}" enc="base64">${b64}</lexisSpec>`);
    const relsPath = 'word/_rels/document.xml.rels';
    const relsFile = zip.file(relsPath);
    if (relsFile) {
        let rels = await relsFile.async('string');
        if (!rels.includes('customXml/item1.xml')) {
            rels = rels.replace('</Relationships>', '<Relationship Id="rIdLexisSpec" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/></Relationships>');
            zip.file(relsPath, rels);
        }
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Je výstup agenta vhodný jako koncept? (odmítnutí / offline náhradní odpověď ne) */
function isDraftWorthy(text) {
    const t = String(text || '').trim();
    if (t.length < 40) return false;
    if (/^Nedostatek podkladů/i.test(t)) return false;
    if (/ZADÁNÍ NEBYLO ZPRACOVÁNO|NEVZNIKL žádný výstup|simulovan/i.test(t.slice(0, 600))) return false;
    return true;
}

// ── Napojení agentů ───────────────────────────────────────────────────────────
/** Ukládá agent výstup automaticky do konceptů? (spisovatel ano; jinak agent.autoDraft) */
function autoDraftFor(agentId, agent) {
    if (process.env.AGENT_AUTO_DRAFTS === '0') return false;
    if (agent && typeof agent.autoDraft === 'boolean') return agent.autoDraft;
    return agentId === 'spisovatel';
}

/** Přístup volajícího ke spisu konceptu. Vrací null (OK) nebo { status, error }. */
function checkAccess(principal, spisId, level) {
    const principalLib = require('./principal');
    const access = require('./access');
    if (level === 'write' && principal && principal.kind === 'agent' && !principalLib.hasScope(principal, 'write')) {
        return { status: 403, error: 'Agent nemá oprávnění zapisovat koncepty (scope write).' };
    }
    if (!spisId || !access.isFirmMode()) return null;
    let spis = null;
    try { spis = require('./spisy').getSpis(spisId); } catch (e) { spis = null; }
    return access.canAccess(spis, principal, level) ? null : { status: 403, error: 'Přístup ke spisu odepřen.' };
}

/** Kontext pro agenta, který reviduje koncept: aktuální znění + otevřené připomínky. */
function revisionContext(d) {
    const cur = d.versions[d.versions.length - 1];
    const open = (d.comments || []).filter(c => !c.resolved);
    return `AKTUÁLNÍ ZNĚNÍ KONCEPTU „${d.title}“ (verze ${d.version}):\n${specToText(cur.spec)}` +
        (open.length ? `\n\nPŘIPOMÍNKY ADVOKÁTA K ZAPRACOVÁNÍ:\n${open.map(c => '- ' + c.text).join('\n')}` : '') +
        '\n\nVrať CELÉ nové znění dokumentu (ne jen změny), bez komentářů k úpravám.';
}

/**
 * Uloží výstup agenta: nový koncept, nebo novou verzi existujícího (draftId + baseVersion).
 * Nikdy nepřepíše cizí změny (409 → vrátí conflict) ani zamčený koncept.
 */
function saveAgentOutput(o) {
    o = o || {};
    if (!isDraftWorthy(o.text)) return { skipped: 'not-a-document' };
    const agentPrincipal = { userId: 'agent:' + (o.agentId || 'agent'), name: o.agentName || o.agentId || 'AI agent', kind: 'agent', scopes: ['read', 'write'] };
    const source = { type: o.type || 'agent', agentId: o.agentId, agentName: o.agentName, model: o.model, transparencyId: o.transparencyId };
    try {
        let d, created;
        if (o.draftId) {
            const r = saveVersion(o.draftId, { text: o.text, baseVersion: o.baseVersion, note: o.note || `Revize: ${o.agentName || o.agentId}`, source }, agentPrincipal);
            d = r.draft; created = false;
        } else {
            d = createDraft({ title: o.title, spisId: o.spisId, caseNumber: o.caseNumber, text: o.text, source, note: o.note || `Návrh: ${o.agentName || o.agentId}` }, agentPrincipal);
            created = true;
        }
        if (o.warnings && String(o.warnings).trim()) {
            addComment(d.id, { text: 'Automatická kontrola výstupu AI:\n' + String(o.warnings).trim() }, { userId: 'system:output_guard', name: 'Kontrola výstupu', kind: 'system' });
        }
        return { id: d.id, title: d.title, version: d.version, status: d.status, created };
    } catch (e) {
        return { error: e.message, code: e.code || null, status: e.status || 500 };
    }
}

module.exports = {
    DraftError, STATUSES, STATUS_LABELS, LOCK_TTL_MS,
    validateSpec, textToSpec, specToText, specToHtml, editorSpec, embedSpec,
    createDraft, listDrafts, getDraft, getVersion, saveVersion, acquireLock, releaseLock,
    setStatus, addComment, resolveComment, deleteDraft, exportDocx, summary, view, isDraftWorthy,
    autoDraftFor, checkAccess, revisionContext, saveAgentOutput
};
