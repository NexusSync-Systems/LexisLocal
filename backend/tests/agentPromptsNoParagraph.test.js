/**
 * Systémové prompty nesmí obsahovat konkrétní číslo paragrafu (zátěžový den 27.–28. 10. 2026:
 * vzor „§ 2248 OZ“ model přebíral jako obsah — u moderace smluvní pokuty § 2248 místo § 2051 OZ).
 */
const fs = require('fs');
const path = require('path');
const { DEFAULT_AGENTS, migratePrompt } = require('../lib/agents');

const PAR = /§\s*\d/;

describe('prompty agentů bez konkrétního §', () => {
    test('výchozí agenti (vč. prompts.json)', () => {
        for (const [id, a] of Object.entries(DEFAULT_AGENTS)) expect([id, PAR.test(a.systemPrompt || '')]).toEqual([id, false]);
    });
    test('prompts.json', () => {
        const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'prompts.json'), 'utf8'));
        for (const [id, t] of Object.entries(p)) expect([id, PAR.test(t)]).toEqual([id, false]);
    });
    test('pokyn k podkladům z báze (routes/agent.js)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'agent.js'), 'utf8');
        const line = src.split('\n').find(l => l.includes('cituj jen ustanovení, která v nich jsou'));
        expect(line).toBeTruthy();
        expect(PAR.test(line)).toBe(false);
    });
    test('uložený starý prompt se opraví, vlastní text zůstane', () => {
        const old = 'Vlastní úvod kanceláře. U každého paragrafu vždy uveď i zákon, ke kterému patří (např. „§ 2248 OZ“, „§ 204 o. s. ř.“ nebo „§ 2248 zákona č. 89/2012 Sb.“) — holé „§ 629“ nelze ověřit, protože stejné číslo má více zákonů. Vlastní závěr.';
        const t = migratePrompt(old);
        expect(PAR.test(t)).toBe(false);
        expect(t).toMatch(/^Vlastní úvod kanceláře\./);
        expect(t).toMatch(/Vlastní závěr\.$/);
        expect(t).toContain('§ [číslo] OZ');
        expect(migratePrompt('Jen vlastní prompt.')).toBe('Jen vlastní prompt.');
    });
});
