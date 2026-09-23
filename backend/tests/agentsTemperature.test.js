/**
 * #4: teplota per agent — normalizeAgent doplní default dle role, validuje rozsah,
 * a helper agentTemperature() bezpečně vytáhne hodnotu s fallbackem.
 */
'use strict';
const { normalizeAgent, agentTemperature, ROLE_TEMP } = require('../lib/agents');

describe('#4 teplota per agent', () => {
    test('normalizeAgent doplní default teplotu dle systémové role', () => {
        const a = normalizeAgent({ id: 'kontrolor', isSystem: true, permissions: { read_files: true } });
        expect(a.temperature).toBe(ROLE_TEMP.kontrolor);
        const s = normalizeAgent({ id: 'stylista', isSystem: true, permissions: {} });
        expect(s.temperature).toBe(ROLE_TEMP.stylista);
    });

    test('nastavenou platnou hodnotu zachová', () => {
        const a = normalizeAgent({ id: 'spisovatel', isSystem: true, temperature: 0.42, permissions: {} });
        expect(a.temperature).toBe(0.42);
    });

    test('mimo rozsah → zahodí (undefined), vlastní agent bez role → undefined', () => {
        const a = normalizeAgent({ id: 'muj_agent', temperature: 1.7, permissions: {} });
        expect(a.temperature).toBeUndefined();
        const b = normalizeAgent({ id: 'muj_agent2', permissions: {} });
        expect(b.temperature).toBeUndefined();
    });

    test('agentTemperature: platná hodnota vs fallback', () => {
        expect(agentTemperature({ temperature: 0.3 }, 0.9)).toBe(0.3);
        expect(agentTemperature({ temperature: 0 }, 0.9)).toBe(0);
        expect(agentTemperature({ temperature: 5 }, 0.9)).toBe(0.9);
        expect(agentTemperature({}, 0.9)).toBe(0.9);
        expect(agentTemperature(null, 0.25)).toBe(0.25);
    });
});
