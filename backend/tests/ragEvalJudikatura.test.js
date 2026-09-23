/**
 * Validace golden setu judikatury (backend/eval/rag_eval_judikatura.json):
 * dobře utvořený, scope odpovídá kanonické taxonomii oborů, každý case má dotaz
 * i relevant. Nesahá na model — jen kontroluje strukturu sady + run přes rag_eval
 * jádro se stubovaným searchFn (deterministicky).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { oborSlug } = require('../lib/obory');
const { runEval } = require('../lib/rag_eval');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eval', 'rag_eval_judikatura.json'), 'utf8'));

describe('golden set judikatury — struktura', () => {
    test('má k a neprázdné cases', () => {
        expect(SPEC.k).toBeGreaterThan(0);
        expect(Array.isArray(SPEC.cases)).toBe(true);
        expect(SPEC.cases.length).toBeGreaterThanOrEqual(8);
    });

    test('každý case má query, relevant[] a scope _kb_obor_<validní slug>', () => {
        const validScopes = new Set(); // odvozené z labelů kanonické taxonomie
        for (const label of ['Pracovní právo','Rodinné právo','Insolvenční právo','Náhrada škody a odpovědnost','Občanské právo','Dědické právo','Spotřebitelské právo','Nemovitosti a nájemní právo','Trestní právo','Správní právo','Ústavní právo a lidská práva','Daňové a finanční právo','Právo duševního vlastnictví','Obchodní a korporátní právo','Ochrana osobních údajů (GDPR)']) {
            validScopes.add('_kb_obor_' + oborSlug(label));
        }
        for (const c of SPEC.cases) {
            expect(typeof c.query).toBe('string');
            expect(c.query.trim().length).toBeGreaterThan(10);
            expect(Array.isArray(c.relevant) && c.relevant.length > 0).toBe(true);
            expect(c.filters && Array.isArray(c.filters.scopes)).toBe(true);
            expect(c.filters.clientAccess).toBe(false);
            for (const sc of c.filters.scopes) expect(validScopes.has(sc)).toBe(true);
        }
    });

    test('runEval jádro sedí na sadě (stub searchFn vrací relevantní soubor na 1. místě)', async () => {
        const searchFn = async (query, filters) => {
            // Najdi case dle query a vrať jeho relevant jako top hit → hit-rate 100 %.
            const c = SPEC.cases.find(x => x.query === query);
            const name = c ? c.relevant[0] : 'nic';
            return [{ fileName: name + '.txt', score: 0.9 }, { fileName: 'jiny.txt', score: 0.5 }];
        };
        const report = await runEval({ cases: SPEC.cases, searchFn, k: SPEC.k });
        expect(report.summary.hitRate).toBe(1);
        expect(report.perCase.every(p => !p.skipped)).toBe(true);
    });
});
