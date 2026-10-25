/**
 * Vyprázdnění auditního logu jen s výslovným potvrzením a s archivací (UX kontrola 5. 10. 2026:
 * „Vymazat logy“ hned vedle „Obnovit“ smazalo audit natrvalo jedním potvrzením).
 */
'use strict';
const path = require('path'); const os = require('os'); const fs = require('fs');
const tmp = path.join(os.tmpdir(), `lexis_test_auditclear_${Date.now()}`); fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test'; process.env.WATCH_DIR = tmp; process.env.LEXIS_KEY_DIR = tmp + '_key';
const request = require('supertest');
const app = require('../server');
const audit = require('../lib/audit');
const H = (r) => r.set('X-API-Token', 'tok-test');

test('bez potvrzení 400, nic se nesmaže', async () => {
    audit.logEvent('Test', 'Úkon', 'cíl', {});
    const before = audit.loadAuditLogs().length;
    const r = await H(request(app).post('/api/audit/clear')).send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('confirm_required');
    expect(audit.loadAuditLogs().length).toBe(before);
});

test('s potvrzením SMAZAT: původní log se archivuje, pak vyprázdní', async () => {
    audit.logEvent('Test', 'Úkon 2', 'cíl', {});
    const r = await H(request(app).post('/api/audit/clear')).send({ confirm: 'SMAZAT' });
    expect(r.status).toBe(200);
    expect(r.body.archive).toMatch(/^audit_.*\.json$/);
    const { dataPath } = require('../lib/config');
    expect(fs.existsSync(path.join(dataPath('.audit_archiv'), r.body.archive))).toBe(true);
    expect(audit.loadAuditLogs().length).toBeLessThanOrEqual(1); // jen záznam o pročištění
});
