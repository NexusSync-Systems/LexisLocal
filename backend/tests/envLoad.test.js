'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../lib/env_load');

describe('env_load: odkud server čte .env (aplikace z .dmg i ze zdrojů)', () => {
    let tmp, keys;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envload-')); keys = ['ENVT_A', 'ENVT_B', 'ENVT_C']; keys.forEach(k => delete process.env[k]); });
    afterEach(() => { keys.forEach(k => delete process.env[k]); fs.rmSync(tmp, { recursive: true, force: true }); });

    test('pořadí: LEXIS_ENV_FILE → pracovní složka → datová složka aplikace', () => {
        const k = E.kandidati({ LEXIS_ENV_FILE: '/x/vlastni.env', LEXIS_DATA_DIR: '/data' }, '/proj', 'darwin');
        expect(k).toEqual(['/x/vlastni.env', '/proj/.env', '/data/.env']);
        expect(E.vychoziDatovaSlozka({}, 'darwin')).toMatch(/Library\/Application Support\/LexisLocal$/);
    });

    test('nainstalovaná aplikace: bez .env v pracovní složce se načte .env z datové složky', () => {
        const data = path.join(tmp, 'data'); fs.mkdirSync(data);
        fs.writeFileSync(path.join(data, '.env'), 'ENVT_A=z-datove-slozky\n');
        const n = E.nacti({ env: { LEXIS_DATA_DIR: data }, cwd: path.join(tmp, 'jinde') });
        expect(n).toEqual([path.join(data, '.env')]);
        expect(process.env.ENVT_A).toBe('z-datove-slozky');
    });

    test('první nalezená hodnota vyhrává, proměnné prostředí se nepřepisují', () => {
        const data = path.join(tmp, 'data'); fs.mkdirSync(data);
        fs.writeFileSync(path.join(tmp, '.env'), 'ENVT_A=projekt\nENVT_B=projekt\n');
        fs.writeFileSync(path.join(data, '.env'), 'ENVT_A=data\nENVT_C=data\n');
        process.env.ENVT_B = 'prostredi';
        E.nacti({ env: { LEXIS_DATA_DIR: data }, cwd: tmp });
        expect(process.env.ENVT_A).toBe('projekt');
        expect(process.env.ENVT_B).toBe('prostredi');
        expect(process.env.ENVT_C).toBe('data');
    });
});
