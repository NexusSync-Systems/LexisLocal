/**
 * E-mailový agent v AWS (scripts/aws/email-agent/index.js) — bez sítě, se zástupnými službami:
 *  • jen povolený odesílatel s DMARC PASS, bez viru/spamu; cizím se neodpovídá,
 *  • osobní údaje → Claude se nevolá, odpověď vysvětlí,
 *  • každá zpráva jednou, denní limit, žádná odpověď na automatické zprávy,
 *  • MIME: base64/QP, windows-1250, RFC 2047 předmět; odpověď s In-Reply-To a Auto-Submitted.
 */
'use strict';

const A = require('../../scripts/aws/email-agent/index.js')._t;

process.env.AGENT_ADRESA = 'asistent@ukoly.example.cz';
process.env.POVOLENI = 'advokat@dias.cz, druhy@dias.cz';
process.env.DENNI_LIMIT = '2';

const PASS = { status: 'PASS' };
const RECEIPT = { virusVerdict: PASS, spamVerdict: PASS, dmarcVerdict: PASS, dkimVerdict: PASS, spfVerdict: PASS };

function zprava({ subject = 'Dotaz', body = 'Jaká je lhůta k podání odvolání?', extra = '' } = {}) {
    return 'From: Advokát <advokat@dias.cz>\r\nTo: asistent@ukoly.example.cz\r\nSubject: ' + subject +
        '\r\nMessage-ID: <abc123@dias.cz>\r\n' + extra + 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(body, 'utf8').toString('base64') + '\r\n';
}
function udalost({ id = 'msgid0001', from = ['Advokát <advokat@dias.cz>'], receipt = RECEIPT } = {}) {
    return { Records: [{ ses: { mail: { messageId: id, commonHeaders: { from } }, receipt } }] };
}
function sluzby(raw) {
    const s3 = new Map(); if (raw != null) s3.set('prijem/msgid0001', Buffer.from(raw, 'latin1'));
    const d = {
        s3, odeslane: [], volani: 0,
        async nacti(k) { return s3.has(k) ? s3.get(k) : null; },
        async uloz(k, v) { s3.set(k, Buffer.from(v, 'utf8')); },
        async claude() { d.volani++; return { text: 'Odvolání se podává do 15 dnů (§ 204 o. s. ř.).', vstup: 900, vystup: 120 }; },
        async odesli(raw, komu) { d.odeslane.push({ raw: raw.toString('utf8'), komu }); }
    };
    return d;
}
const dekodujOdpoved = raw => Buffer.from(raw.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString('utf8');

describe('e-mailový agent v AWS', () => {
    test('povolený advokát + obecný dotaz → Claude a odpověď jen jemu', async () => {
        const d = sluzby(zprava());
        const r = await A.zpracuj(udalost(), d);
        expect(r.vysledek).toBe('odpovezeno');
        expect(d.volani).toBe(1);
        expect(d.odeslane).toHaveLength(1);
        expect(d.odeslane[0].komu).toBe('advokat@dias.cz');
        expect(d.odeslane[0].raw).toMatch(/In-Reply-To: <abc123@dias.cz>/);
        expect(d.odeslane[0].raw).toMatch(/Auto-Submitted: auto-replied/);
        expect(dekodujOdpoved(d.odeslane[0].raw)).toMatch(/umělá inteligence[\s\S]*§ 204/);
    });

    test('cizí odesílatel → bez Clauda a bez odpovědi', async () => {
        const d = sluzby(zprava());
        const r = await A.zpracuj(udalost({ from: ['x@zlo.cz'] }), d);
        expect(r.vysledek).toBe('odesilatel-nepovoleny');
        expect(d.volani).toBe(0); expect(d.odeslane).toHaveLength(0);
    });

    test('podvržený From (DMARC FAIL) → bez odpovědi', async () => {
        const d = sluzby(zprava());
        const r = await A.zpracuj(udalost({ receipt: Object.assign({}, RECEIPT, { dmarcVerdict: { status: 'FAIL' } }) }), d);
        expect(r.vysledek).toBe('neovereny-puvod');
        expect(d.odeslane).toHaveLength(0);
    });

    test('virus / spam / chybějící verdikt → zamítnuto', () => {
        expect(A.overVerdikty(Object.assign({}, RECEIPT, { virusVerdict: { status: 'FAIL' } })).ok).toBe(false);
        expect(A.overVerdikty(Object.assign({}, RECEIPT, { spamVerdict: { status: 'GRAY' } })).ok).toBe(false);
        expect(A.overVerdikty({ virusVerdict: PASS, spamVerdict: PASS }).ok).toBe(false);
    });

    test('osobní údaje → Claude se nevolá, odpověď vysvětlí (bez hodnot)', async () => {
        const d = sluzby(zprava({ body: 'Připrav dopis pro Jana Nováka, r. č. 850101/1234.' }));
        const r = await A.zpracuj(udalost(), d);
        expect(r.vysledek).toBe('osobni-udaje');
        expect(d.volani).toBe(0);
        const t = dekodujOdpoved(d.odeslane[0].raw);
        expect(t).toMatch(/rodné číslo/);
        expect(t).not.toMatch(/850101/);
    });

    test('podpis advokáta se nepočítá jako osobní údaj', async () => {
        const d = sluzby(zprava({ body: 'Jaká je lhůta k odvolání?\n\nS pozdravem\nJUDr. Petr Dvořák\n+420 777 123 456' }));
        expect((await A.zpracuj(udalost(), d)).vysledek).toBe('odpovezeno');
    });

    test('stejná zpráva podruhé → nic', async () => {
        const d = sluzby(zprava());
        await A.zpracuj(udalost(), d);
        const r = await A.zpracuj(udalost(), d);
        expect(r.vysledek).toBe('uz-zpracovano');
        expect(d.volani).toBe(1);
    });

    test('denní limit', async () => {
        const d = sluzby(zprava());
        const den = new Date().toISOString().slice(0, 10);
        d.s3.set('stav/den-' + den + '.json', Buffer.from(JSON.stringify({ pocet: 2 })));
        const r = await A.zpracuj(udalost(), d);
        expect(r.vysledek).toBe('limit');
        expect(d.volani).toBe(0);
    });

    test('automatická zpráva (Auto-Submitted / seznam) → bez odpovědi', async () => {
        const d = sluzby(zprava({ extra: 'Auto-Submitted: auto-replied\r\n' }));
        expect((await A.zpracuj(udalost(), d)).vysledek).toBe('automaticka-zprava');
        const d2 = sluzby(zprava({ extra: 'List-Id: <x.example>\r\n' }));
        expect((await A.zpracuj(udalost(), d2)).vysledek).toBe('automaticka-zprava');
        expect(d.odeslane.length + d2.odeslane.length).toBe(0);
    });

    test('více adres ve From → zamítnuto', async () => {
        const d = sluzby(zprava());
        expect((await A.zpracuj(udalost({ from: ['advokat@dias.cz', 'x@zlo.cz'] }), d)).vysledek).toBe('odesilatel-neplatny');
    });

    test('MIME: multipart s QP windows-1250, předmět RFC 2047, příloha se nečte', () => {
        const qp = 'Jaká je lhůta?';
        const enc = Buffer.from(new Uint8Array([0x4a, 0x61, 0x6b, 0xe1, 0x20, 0x6a, 0x65, 0x20, 0x6c, 0x68, 0xf9, 0x74, 0x61, 0x3f]));  // cp1250
        const qpTxt = [...enc].map(b => (b > 127 ? '=' + b.toString(16).toUpperCase() : String.fromCharCode(b))).join('');
        const raw = 'Subject: =?UTF-8?B?' + Buffer.from('Dotaz – lhůta').toString('base64') + '?=\r\nMessage-ID: <m1@x.cz>\r\n' +
            'Content-Type: multipart/mixed; boundary="B1"\r\n\r\n--B1\r\nContent-Type: text/plain; charset=windows-1250\r\n' +
            'Content-Transfer-Encoding: quoted-printable\r\n\r\n' + qpTxt + '\r\n--B1\r\nContent-Type: application/pdf\r\n' +
            'Content-Disposition: attachment; filename="a.pdf"\r\n\r\nJVBERi0=\r\n--B1--\r\n';
        const z = A.rozeberZpravu(raw);
        expect(z.predmet).toBe('Dotaz – lhůta');
        expect(z.text.trim()).toBe(qp);
        expect(z.prilohy).toBe(1);
        expect(z.messageId).toBe('<m1@x.cz>');
    });

    test('odpověď: předmět zakódovaný (bez vložení hlaviček)', () => {
        const raw = A.sestavOdpoved({ od: 'a@b.cz', komu: 'c@d.cz', predmet: 'X\r\nBcc: zlo@x.cz', text: 'ahoj', messageId: null }).toString('utf8');
        expect(raw).not.toMatch(/\r\nBcc:/);
    });
});
