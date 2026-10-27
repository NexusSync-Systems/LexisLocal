/**
 * OCR bez internetu: jazyková data jsou přibalená v assets/tessdata (simulace kanceláře 26. 10. 2026 —
 * bez sítě tesseract.js nestáhl data z CDN a skeny z doručené pošty zmizely). Sken je syntetický.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_ocr_'));
delete process.env.LEXIS_TESSDATA_DIR;

test('přibalená data se najdou (ces + eng, gzip)', () => {
    const td = require('../lib/ocr').tessdataDir();
    expect(td).toBeTruthy();
    expect(td.gzip).toBe(true);
    expect(fs.existsSync(path.join(td.dir, 'ces.traineddata.gz'))).toBe(true);
});

test('sken výzvy soudu se přečte z lokálních dat — v samostatném procesu se zakázanou sítí', () => {
    // OCR běží v podprocesu: worker tesseract.js v procesu jestu ovlivňoval ostatní testy (mock v ocr.test.js)
    // a držel jest naživu. Síť je v podprocesu zakázaná — kdyby OCR sáhlo na CDN, selže.
    const { spawnSync } = require('child_process');
    const img = path.join(__dirname, '..', 'eval', 'server_suite', 'fixtures', 'sken_vyzva_soudu_8C211-2026.png');
    const code = `
        const https = require('https'), http = require('http');
        const no = () => { throw new Error('síť zakázána'); };
        https.request = no; https.get = no; http.request = no; http.get = no; globalThis.fetch = async () => { throw new Error('síť zakázána'); };
        require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'ocr'))}).extractTextFromFile(${JSON.stringify(img)})
            .then(r => { process.stdout.write('\\n@@OCR@@' + JSON.stringify(typeof r === 'string' ? r : (r && r.text) || '')); process.exit(0); })
            .catch(e => { console.error(e.message); process.exit(1); });`;
    const r = spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, { LEXIS_DATA_DIR: process.env.LEXIS_DATA_DIR }), encoding: 'utf8', timeout: 110000 });
    const out = String(r.stdout || '');
    expect(out).toContain('@@OCR@@');
    const text = JSON.parse(out.slice(out.lastIndexOf('@@OCR@@') + 7));
    expect(text).toMatch(/8 C 211\/2026/);
    expect(text).toMatch(/Doručeno: 22\. 9\. 2026/);
}, 120000);
