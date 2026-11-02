/**
 * email_pending.js — e-maily od cizích adres čekající na schválení advokátem (revize 2. 11. 2026).
 *
 * Nastavení email_cizi rozhoduje, co s e-mailem od adresy, která není advokát ani na seznamu důvěryhodných:
 *   • 'ke_schvaleni' (výchozí) — uloží se sem; agenti ho zpracují až po kliknutí advokáta „Zpracovat“,
 *   • 'ignorovat'              — jen záznam v auditu,
 *   • 'automaticky'            — zpracuje se hned (jen s ověřeným původem DKIM/DMARC, jinak sem).
 * Ve všech případech jde výsledek jen advokátovi, cizímu se nic neposílá, a spis se k zadání podle textu
 * cizího NIKDY nepřiřadí sám (sp. zn. může zadat jen advokát při schválení).
 */
'use strict';

const db = require('./database');

const KOLEKCE = 'email_pending';
const MAX_POLOZEK = 300;
const MAX_TEXT = 20000;
const REZIMY = ['ke_schvaleni', 'ignorovat', 'automaticky'];

function rezimCizich(settings) {
    const r = String((settings && settings.email_cizi) || '').trim().toLowerCase();
    return REZIMY.includes(r) ? r : 'ke_schvaleni';
}

/** Seznam důvěryhodných adres (koncipient, asistentka) — zpracují se jako od advokáta. */
function duveryhodni(settings) {
    const raw = settings && settings.email_duveryhodni;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/);
    return [...new Set(list.map(a => String(a || '').trim().toLowerCase()).filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)))];
}

function seznam() {
    const all = db.get(KOLEKCE) || [];
    return [...all].sort((a, b) => {
        if ((a.stav === 'ceka') !== (b.stav === 'ceka')) return a.stav === 'ceka' ? -1 : 1;
        return String(b.prijato || '').localeCompare(String(a.prijato || ''));
    });
}

function najdi(id) { return (db.get(KOLEKCE) || []).find(p => String(p.id) === String(id)) || null; }

function pridej({ od, predmet, text, overeni, overeniDuvod }) {
    const all = db.get(KOLEKCE) || [];
    // Nad limit: nejdřív se zahodí nejstarší vyřízené, pak nejstarší čekající.
    if (all.length >= MAX_POLOZEK) {
        const serazene = [...all].sort((a, b) => String(a.prijato || '').localeCompare(String(b.prijato || '')));
        const pryc = serazene.find(p => p.stav !== 'ceka') || serazene[0];
        if (pryc) db.delete(KOLEKCE, pryc.id);
    }
    return db.insert(KOLEKCE, {
        od: String(od || '').trim(), predmet: String(predmet || '').slice(0, 300), text: String(text || '').slice(0, MAX_TEXT),
        overeni: overeni || null, overeniDuvod: overeniDuvod || null, prijato: new Date().toISOString(), stav: 'ceka'
    });
}

function oznac(id, stav, extra) {
    const p = najdi(id);
    if (!p) return null;
    db.update(KOLEKCE, p.id, Object.assign({ stav, vyrizeno: new Date().toISOString() }, extra || {}));
    return najdi(id);
}

module.exports = { rezimCizich, duveryhodni, seznam, najdi, pridej, oznac, REZIMY };
