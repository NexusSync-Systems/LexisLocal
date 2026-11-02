/**
 * email_auth.js — ověření původu e-mailového zadání (revize 2. 11. 2026).
 *
 * Adresa v hlavičce From se dá snadno podvrhnout, takže samotná shoda s authorized_sender nestačí.
 * Zadání projde jen tehdy, když přijímající server schránky zapsal do hlavičky Authentication-Results
 * (RFC 8601), že pro doménu odesílatele prošel DMARC, nebo prošel DKIM podpis zarovnaný s doménou From.
 *
 * Kterým hlavičkám věřit: odesílatel může do zprávy vložit vlastní (falešnou) Authentication-Results.
 * Přijímající server přidává svou NAHORU, proto:
 *   • s nastaveným authserv-id (email_authserv_id, např. „mx.google.com“) se berou jen hlavičky s tímto id,
 *   • bez něj jen nejvyšší (první) hlavička.
 * Vypnutí (jen když schránka hlavičku nepřidává): nastavení email_require_auth=false nebo LEXIS_EMAIL_OVERENI=0.
 */
'use strict';

function domena(adresa) {
    const m = String(adresa || '').trim().toLowerCase().match(/@([a-z0-9.-]+)>?$/);
    return m ? m[1].replace(/\.$/, '') : '';
}

// Volné zarovnání (DMARC relaxed): stejná doména nebo jedna je subdoménou druhé.
function zarovnano(d, from) {
    d = String(d || '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
    if (d.includes('@')) d = d.slice(d.lastIndexOf('@') + 1);
    if (!d || !from) return false;
    return d === from || from.endsWith('.' + d) || d.endsWith('.' + from);
}

/** Rozebere jednu hlavičku Authentication-Results → { authserv, vysledky[{ metoda, vysledek, props }] } | null. */
function rozeber(hlavicka) {
    let s = String(hlavicka || '').replace(/^authentication-results\s*:/i, '').replace(/\r?\n[ \t]+/g, ' ');
    for (let i = 0; i < 3; i++) s = s.replace(/\([^()]*\)/g, ' ');   // komentáře (i vnořené)
    const casti = s.split(';').map(x => x.trim()).filter(Boolean);
    if (!casti.length) return null;
    const authserv = casti[0].split(/\s+/)[0].toLowerCase();
    const vysledky = [];
    for (const c of casti.slice(1)) {
        const m = c.match(/^([a-z0-9_-]+)\s*=\s*([a-z0-9_-]+)([\s\S]*)$/i);
        if (!m) continue;
        const props = {};
        (m[3].match(/[a-z0-9_.-]+\s*=\s*[^\s;]+/gi) || []).forEach(p => {
            const i = p.indexOf('=');
            props[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, '');
        });
        vysledky.push({ metoda: m[1].toLowerCase(), vysledek: m[2].toLowerCase(), props });
    }
    return { authserv, vysledky };
}

function _vypnuto(settings) {
    const env = String(process.env.LEXIS_EMAIL_OVERENI == null ? '' : process.env.LEXIS_EMAIL_OVERENI).trim().toLowerCase();
    if (['0', 'false', 'no', 'off', 'vypnuto'].includes(env)) return true;
    return !!(settings && settings.email_require_auth === false);
}

/**
 * Ověří původ zprávy. hlavicky = pole hlaviček Authentication-Results v pořadí ve zprávě (shora dolů)
 * nebo jeden řetězec. Vrací { ok, metoda?, duvod? }.
 */
function overPuvod(from, hlavicky, settings) {
    if (_vypnuto(settings)) return { ok: true, metoda: 'vypnuto' };
    const fromDom = domena(from);
    if (!fromDom) return { ok: false, duvod: 'odesílatel bez platné adresy' };
    const seznam = (Array.isArray(hlavicky) ? hlavicky : (hlavicky ? [hlavicky] : [])).map(rozeber).filter(Boolean);
    if (!seznam.length) return { ok: false, duvod: 'zpráva nemá hlavičku Authentication-Results (nelze ověřit DKIM/DMARC)' };
    const ids = String((settings && settings.email_authserv_id) || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    const duveryhodne = ids.length ? seznam.filter(h => ids.includes(h.authserv)) : [seznam[0]];
    if (!duveryhodne.length) return { ok: false, duvod: 'chybí Authentication-Results od serveru ' + ids.join(', ') };
    for (const h of duveryhodne) {
        for (const v of h.vysledky) {
            if (v.metoda === 'dmarc' && v.vysledek === 'pass') {
                const hf = v.props['header.from'];
                if (!hf || zarovnano(hf, fromDom)) return { ok: true, metoda: 'dmarc' };
            }
        }
        for (const v of h.vysledky) {
            if (v.metoda === 'dkim' && v.vysledek === 'pass') {
                const d = v.props['header.d'] || v.props['header.i'] || '';
                if (zarovnano(d, fromDom)) return { ok: true, metoda: 'dkim' };
            }
        }
    }
    return { ok: false, duvod: 'DKIM ani DMARC pro doménu ' + fromDom + ' neprošel' };
}

module.exports = { overPuvod, rozeber, domena, zarovnano };
