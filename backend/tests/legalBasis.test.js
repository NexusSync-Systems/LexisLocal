/**
 * Povinné zdůvodnění doporučení právních agentů (lib/legal_basis.js, 4. 11. 2026).
 */
'use strict';
const LB = require('../lib/legal_basis');
const { checkOutput, retryMessage } = require('../lib/output_checks');

describe('legal_basis', () => {
    test('pravidlo jen pro právní agenty (a vlastní s judikaturou), vypnutelné', () => {
        expect(LB.jePravniAgent({ id: 'resersnik', isSystem: true })).toBe(true);
        expect(LB.jePravniAgent({ id: 'kontrolor', isSystem: true })).toBe(true);
        expect(LB.jePravniAgent({ id: 'spisovatel', isSystem: true })).toBe(true);
        expect(LB.jePravniAgent({ id: 'stylista', isSystem: true })).toBe(false);
        expect(LB.jePravniAgent({ id: 'sekretarka', isSystem: true })).toBe(false);
        expect(LB.jePravniAgent({ id: 'pracovni', isSystem: false, useJudikatura: true })).toBe(true);
        expect(LB.jePravniAgent({ id: 'resersnik', isSystem: true, zduvodneni: false })).toBe(false);
        expect(LB.systemPrompt({ id: 'resersnik', systemPrompt: 'X' })).toMatch(/^X\n\nZDŮVODNĚNÍ \(povinné\)/);
        expect(LB.systemPrompt({ id: 'stylista', systemPrompt: 'X' })).toBe('X');
    });

    test('najde doporučení bez opory; § / čl. / sp. zn. / číslo předpisu = opora', () => {
        const t = [
            '1. Stručná odpověď',
            'Doporučuji zaslat předžalobní výzvu.',
            'Nárok lze uplatnit žalobou podle § 79 o. s. ř.',
            'Smlouva je neplatná, jak uvádí rozsudek 33 Cdo 1234/2019.',
            'Je třeba postupovat podle zákona č. 182/2006 Sb.',
            'Klient má právo odstoupit (čl. 7 smlouvy).',
            '- Doporučení: podat odvolání',
            '  — Opora: § 204 o. s. ř. — Proč: lhůta 15 dnů od doručení.',
            '- Doporučení: požadovat úrok — Opora: nenalezena v podkladech — ověřit',
            'Co ještě ověřit:',
            '- Je třeba zjistit, zda dlužník nepodal insolvenční návrh.',
            'Klient dodal zboží 3. 3. 2025.'
        ].join('\n');
        const k = LB.kontrolaOpory(t);
        expect(k.bezOpory).toEqual(['Doporučuji zaslat předžalobní výzvu.']);
        expect(k.vyslovneBez).toHaveLength(1);
        expect(k.doporuceni).toBe(7);
        expect(LB.upozorneni(k)).toMatch(/Bez uvedené právní opory \(1 z 7/);
    });

    test('vše podložené → bez upozornění', () => {
        const k = LB.kontrolaOpory('Doporučuji podat žalobu, protože dluh je splatný (§ 1958 OZ).');
        expect(k.bezOpory).toEqual([]);
        expect(LB.upozorneni(k)).toBe('');
    });

    test('output_checks: u právního agenta výtka bez_opory k jedné opravě, u dopisu protistraně ne', () => {
        const text = 'Rozbor věci.\nDoporučuji podat žalobu co nejdříve, protože jinak hrozí promlčení nároku klienta.';
        const ck = checkOutput({ text, agentId: 'resersnik', legal: true });
        expect(ck.issues.map(i => i.code)).toContain('bez_opory');
        expect(retryMessage(ck.issues)).toMatch(/nemají uvedenou právní oporu/);
        expect(checkOutput({ text, agentId: 'resersnik', legal: false }).issues.map(i => i.code)).not.toContain('bez_opory');
        expect(checkOutput({ text, agentId: 'spisovatel', legal: true, demand: true }).issues.map(i => i.code)).not.toContain('bez_opory');
    });
});

describe('varianty s pro a proti (4. 11. 2026)', () => {
    test('řádky Pro / Proti nejsou samostatná doporučení', () => {
        const t = 'Varianta A: předžalobní výzva — Opora: § 142a o. s. ř.\n- Pro: lze rychle a levně, dlužník může zaplatit dobrovolně.\n- Proti: dlužník musí dostat 7 dní, oddálí žalobu.\nDoporučená varianta: A, protože bez výzvy nelze přiznat náhradu nákladů (§ 142a o. s. ř.).';
        expect(LB.kontrolaOpory(t).bezOpory).toEqual([]);
    });
    test('osnova rozboru chce varianty s Pro/Proti a doporučenou variantu', () => {
        const { taskProfile } = require('../lib/agent_outlines');
        const p = taskProfile({ agentId: 'resersnik', prompt: 'Rozbor: může klient vymáhat dluh, do kdy?' });
        expect(p.outline).toMatch(/Varianty postupu[\s\S]*Pro:[\s\S]*Proti:[\s\S]*Doporučená varianta/);
    });
});

describe('kb_case_index: judikatura jen z ověřených zdrojů', () => {
    const CI = require('../lib/kb_case_index');
    const { verifyCitations } = require('../lib/citation_verifier');
    afterEach(() => CI._reset());
    const fake = (n) => { const s = new Set(); for (let i = 0; i < n; i++) s.add(`25 cdo ${i}/2020`); return s; };

    test('index ze souborů NS / ÚS / NSS', () => {
        const s = CI.indexZNazvu(['NS_123_31_Cdo_2273_2022.txt', 'US_II._ÚS_3335_11_1.txt', 'NSS_4414_2023_8_As_29_2021-36.txt', 'OZ 89-2012 § 629.txt']);
        expect(s.has('31 cdo 2273/2022')).toBe(true);
        expect(s.has('ii. ús 3335/11')).toBe(true);
        expect(s.has('8 as 29/2021')).toBe(true);
    });

    test('rozhodnutí z báze ověřeno, vymyšlené vypuštěno; zákon v podkladech zůstane ověřený', () => {
        const set = fake(200); set.add('31 cdo 2273/2022');
        CI._setForTest(set);
        const text = 'Podle rozsudku sp. zn. 31 Cdo 2273/2022 a 33 Cdo 9999/2019 je nárok dán (zákon č. 89/2012 Sb.).';
        const r = verifyCitations(text, { referenceIndex: CI.referenceIndex(), contextChunks: [{ text: 'zákon č. 89/2012 Sb.' }] });
        const st = Object.fromEntries(r.citations.map(c => [c.raw, c.status]));
        expect(st['31 Cdo 2273/2022']).toBe('verified');
        expect(st['33 Cdo 9999/2019']).toBe('unverified_case');
        expect(st['zákon č. 89/2012 Sb.']).toBe('verified');
        const v = CI.vypustNeoverene(text, r.citations);
        expect(v.vypusteno).toEqual(['33 Cdo 9999/2019']);
        expect(v.text).toMatch(/31 Cdo 2273\/2022 a \[rozhodnutí neověřeno — vypuštěno\]/);
        expect(CI.upozorneni(v.vypusteno)).toMatch(/Vypuštěno 1× rozhodnutí/);
    });

    test('bez báze judikatury (malý index) se nic nevypouští', () => {
        CI._setForTest(fake(10));
        const text = 'Viz 33 Cdo 9999/2019.';
        const r = verifyCitations(text, { referenceIndex: CI.referenceIndex() });
        expect(CI.vypustNeoverene(text, r.citations).vypusteno).toEqual([]);
    });

    test('LEXIS_NEOVERENE_JUDIKATY=oznacit → jen označit', () => {
        CI._setForTest(fake(200));
        process.env.LEXIS_NEOVERENE_JUDIKATY = 'oznacit';
        try {
            const r = verifyCitations('Viz 33 Cdo 9999/2019.', { referenceIndex: CI.referenceIndex() });
            expect(CI.vypustNeoverene('Viz 33 Cdo 9999/2019.', r.citations).vypusteno).toEqual([]);
        } finally { delete process.env.LEXIS_NEOVERENE_JUDIKATY; }
    });
});
