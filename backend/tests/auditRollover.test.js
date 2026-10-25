/**
 * Audit: přebytek nad AUDIT_LOG_CAP se odkládá do šifrovaného archivu, nic se neztrácí
 * (nález 14. 10. 2026 — dřív slice(-1000) historii tiše zahazoval). Export CSV.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_audroll_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_audroll_data_'));
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_audroll_${Date.now()}`);
process.env.AUDIT_LOG_CAP = '10';

const audit = require('../lib/audit');
const ax = require('../lib/audit_export');

afterAll(() => {
    delete process.env.AUDIT_LOG_CAP;
    for (const d of [process.env.LEXIS_KEY_DIR, process.env.LEXIS_DATA_DIR, process.env.WATCH_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

test('rollover: aktivní log je omezený, celá historie spisu zůstává (archiv je šifrovaný)', () => {
    for (let i = 0; i < 45; i++) audit.logEvent('Test', `Úkon ${i}`, 'X', { spisId: 's_roll', i });
    const active = audit.loadAuditLogs();
    expect(active.length).toBeLessThanOrEqual(10 + 50);
    const all = audit.getLogsForSpis('s_roll');
    expect(all).toHaveLength(45);
    expect(all.map(e => e.details.i)).toEqual([...Array(45).keys()]);
    const dir = path.join(process.env.LEXIS_DATA_DIR, '.audit_archiv');
    if (fs.existsSync(dir)) {
        for (const n of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, n), 'utf-8')).not.toMatch(/Úkon/);
    }
});

test('rollover po dávkách: při 75 záznamech vznikne archivní segment', () => {
    for (let i = 45; i < 75; i++) audit.logEvent('Test', `Úkon ${i}`, 'X', { spisId: 's_roll', i });
    const dir = path.join(process.env.LEXIS_DATA_DIR, '.audit_archiv');
    expect(fs.readdirSync(dir).filter(n => n.startsWith('rollover_')).length).toBeGreaterThanOrEqual(1);
    expect(audit.loadAuditLogs().length).toBeLessThan(75);
    expect(audit.getLogsForSpis('s_roll')).toHaveLength(75);
    expect(audit.verifyAuditChain().ok).toBe(true);
});

test('CSV: BOM, středník, ochrana proti vzorcům, čtení vs. změna', () => {
    audit.logEvent('Test', 'Otevření spisu', '=HYPERLINK("x")', { spisId: 's_csv', access: 'read' });
    audit.logEvent('Test', 'Změna stavu', 'Spis; "B"', { spisId: 's_csv', stav: 'archiv' });
    const csv = ax.toCsv(ax.rowsForSpis('s_csv'));
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(";čtení;Otevření spisu;\"'=HYPERLINK(\"\"x\"\")\"");
    expect(lines[2]).toContain('změna');
    expect(lines[2]).toContain('"Spis; ""B"""');
    expect(lines[2]).toContain('stav: archiv');
    expect(ax._csvCell('-1+2')).toBe("'-1+2");
});
