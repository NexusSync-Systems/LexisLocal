/**
 * Soudní poplatek z peněžitého plnění (lib/court_fees.js) — zákon č. 549/1991 Sb., sazebník od 1. 1. 2026.
 */
'use strict';
const F = require('../lib/court_fees');
const p = (c, o) => F.poplatekPenezite(c, o).poplatek;

test('položka 1: do 20 000 Kč pevně 1 000 Kč, pak 5 % ze základu zaokrouhleného na desítky nahoru', () => {
    expect(p(15000)).toBe(1000);
    expect(p(20000)).toBe(1000);
    expect(p(20001)).toBe(1000.5);        // základ 20 010 Kč
    expect(p(64300)).toBe(3215);
    expect(p(285000)).toBe(14250);
    expect(p(40000000)).toBe(2000000);
});
test('položka 1 písm. c): nad 40 mil. 2 mil. + 1 %, nad 250 mil. se nezapočítává', () => {
    expect(p(50000000)).toBe(2100000);
    expect(p(300000000)).toBe(4100000);
});
test('položka 2: elektronický platební rozkaz 400 / 800 Kč / 4 %', () => {
    expect(p(9000, { epr: true })).toBe(400);
    expect(p(15000, { epr: true })).toBe(800);
    expect(p(64300, { epr: true })).toBe(2572);
});
test('fakta pro model jen u otázky na poplatek / žalobu; částka ze zadání nebo z podkladů u slov o dluhu', () => {
    expect(F.buildFeeFacts({ prompt: 'Shrň smlouvu', context: 'Cena 64 300 Kč.' })).toBeNull();
    const a = F.buildFeeFacts({ prompt: 'Jaký bude soudní poplatek?', context: 'Žalobce požaduje zaplatit 64 300 Kč s úrokem z prodlení 1 200 Kč.' });
    expect(a.castky).toEqual([64300]);
    expect(a.text).toMatch(/3 215 Kč/);
    expect(F.buildFeeFacts({ prompt: 'Kolik bude stát podat žalobu na 120 000 Kč?' }).castky).toEqual([120000]);
});
test('odpověď se špatnou sazbou → program doplní správný výpočet; správná odpověď bez doplnění', () => {
    const ff = F.buildFeeFacts({ prompt: 'Varianty postupu?', context: 'Dlužná částka k zaplacení 64 300 Kč.' });
    const spatne = F.feeAppendix('Proti: náklady řízení (soudní poplatek 4 % z hodnoty sporu, min. 1 000 Kč).', ff);
    expect(spatne).toMatch(/4 %.*u žaloby o peněžité plnění je 5 %/);
    expect(spatne).toMatch(/3 215 Kč/);
    expect(F.feeAppendix('Soudní poplatek za žalobu činí 5 %, tj. 3 215 Kč.', ff)).toBe('');
    expect(F.feeAppendix('Soudní poplatek za elektronický platební rozkaz je 4 %, tj. 2 572 Kč; u žaloby 3 215 Kč.', ff)).toBe('');
    expect(F.feeAppendix('Odpověď bez poplatku.', ff)).toBe('');
});
