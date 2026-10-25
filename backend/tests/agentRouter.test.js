/**
 * #1: deterministický router intentů — sanitizeSteps() + routeByIntent().
 */
'use strict';
const { routeByIntent, sanitizeSteps, KNOWN_AGENTS } = require('../lib/agent_router');

describe('#1 sanitizeSteps', () => {
    test('zahodí neznámé agenty a prázdné instrukce, přečísluje', () => {
        const out = sanitizeSteps([
            { agentId: 'resersnik', instruction: 'a' },
            { agentId: 'xxx', instruction: 'b' },
            { agentId: 'spisovatel', instruction: '' },
            { agentId: 'kontrolor', instruction: 'c', tier: 'light' }
        ]);
        expect(out.map(s => s.agentId)).toEqual(['resersnik', 'kontrolor']);
        expect(out[0].step).toBe(1);
        expect(out[1].step).toBe(2);
        expect(out[1].tier).toBe('light');
    });
    test('výchozí tier je advanced; ořez na max 4', () => {
        const many = Array.from({ length: 8 }, () => ({ agentId: 'resersnik', instruction: 'x' }));
        const out = sanitizeSteps(many);
        expect(out).toHaveLength(4);
        expect(out[0].tier).toBe('advanced');
    });
    test('nevalidní vstup → []', () => {
        expect(sanitizeSteps(null)).toEqual([]);
        expect(sanitizeSteps([{ foo: 1 }])).toEqual([]);
    });
});

describe('#1 routeByIntent', () => {
    test('tvorba dokumentu → rešeršník → spisovatel', () => {
        const r = routeByIntent('Sepiš předžalobní výzvu k úhradě dluhu');
        expect(r.map(s => s.agentId)).toEqual(['resersnik', 'spisovatel']);
    });
    test('kontrola/oponentura → kontrolor', () => {
        expect(routeByIntent('Zkontroluj tento návrh na rizika').map(s => s.agentId)).toEqual(['kontrolor']);
    });
    test('styl → stylista', () => {
        expect(routeByIntent('Přepiš tento odstavec do elegantnějšího stylu').map(s => s.agentId)).toEqual(['stylista']);
    });
    test('kalendář/e-mail → sekretářka', () => {
        expect(routeByIntent('Naplánuj schůzku a připrav e-mail klientovi').map(s => s.agentId)).toEqual(['sekretarka']);
    });
    test('čistá rešerše → rešeršník', () => {
        expect(routeByIntent('Najdi judikaturu k promlčení').map(s => s.agentId)).toEqual(['resersnik']);
    });
    test('bez jasného záměru → null', () => {
        expect(routeByIntent('ahoj')).toBeNull();
        expect(routeByIntent('   ')).toBeNull();
    });
    test('priorita: draft předběhne rešerši i kontrolu', () => {
        // „sepiš" (draft) i „judikatura" (rešerše) → draft pipeline
        const r = routeByIntent('Sepiš žalobu a najdi k tomu judikaturu');
        expect(r.map(s => s.agentId)).toEqual(['resersnik', 'spisovatel']);
    });
    test('všechny vrácené kroky mají známého agenta', () => {
        const r = routeByIntent('Sepiš smlouvu');
        expect(r.every(s => KNOWN_AGENTS.includes(s.agentId))).toBe(true);
    });
});
