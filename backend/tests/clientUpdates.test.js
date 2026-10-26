/**
 * Souhrny pro klienta: text skládá program jen z událostí určených klientovi,
 * odchází jen po schválení advokátem (scope approve + zápis do spisu).
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const ADMIN_TOKEN = 'cu-admin-token';
process.env.API_TOKEN = ADMIN_TOKEN;
process.env.WATCH_DIR = path.join(os.tmpdir(), `lexis_test_cu_${Date.now()}`);
process.env.LEXIS_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_cu_key_'));
process.env.LEXIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis_test_cu_data_'));
delete process.env.LEXIS_FIRM_MODE;

jest.mock('../lib/mailer', () => ({
    validateSmtp: jest.fn(() => []),
    sendMail: jest.fn(async () => ({ messageId: 'x' }))
}));

const request = require('supertest');
const app = require('../server');
const access = require('../lib/access');
const mailer = require('../lib/mailer');
const cu = require('../lib/client_updates');

const ADMIN = { 'X-API-Token': ADMIN_TOKEN };
const as = (t) => ({ 'X-API-Token': t });
let ADV, SEK, CIZI, spis;

afterAll(() => {
    access.setFirmMode(null);
    for (const d of [process.env.WATCH_DIR, process.env.LEXIS_KEY_DIR, process.env.LEXIS_DATA_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

describe('composeSummary (čistá funkce)', () => {
    const base = {
        spis: { id: 's1', spisZn: '12 C 45/2026', nazev: 'Novák vs. PRIMA', klient: 'Jan Novák', stav: 'aktivni', odpovednyAdvokat: 'JUDr. Anna Advokátní' },
        events: [
            { id: 'e1', type: 'poznamka', note: 'Interní: klient asi nemluví pravdu', createdAt: '2026-10-01T10:00:00Z' },
            { id: 'e2', type: 'zarazeni', note: 'Do spisu zařazen dokument „svedek_Petr_Dvorak.pdf".', createdAt: '2026-10-02T10:00:00Z' },
            { id: 'e3', type: 'aml', note: 'AML identifikace klienta — riziko: HIGH.', createdAt: '2026-10-03T10:00:00Z' },
            { id: 'e4', type: 'sdileni', note: 'Spis sdílen s „u_x".', createdAt: '2026-10-03T11:00:00Z' },
            { id: 'e5', type: 'schuzka', note: 'Rezervována schůzka „Porada" na 2026-10-20 14:00 (60 min).', createdAt: '2026-10-04T10:00:00Z' },
            { id: 'e6', type: 'faktura', note: 'Vystavena faktura 2026015 na 12100 Kč.', createdAt: '2026-10-05T10:00:00Z' },
            { id: 'e7', type: 'uprava', note: 'Údaje spisu upraveny.', createdAt: '2026-10-05T11:00:00Z' }
        ],
        deadlines: [
            { date: '2026-11-15', needsReview: false },
            { date: '2026-11-20', needsReview: true },
            { date: '2026-01-01', needsReview: false }
        ],
        hearings: [{ dueDate: '2026-12-03', time: '09:30', location: 'Městský soud v Brně' }]
    };

    test('jen klientské události, bez interních poznámek, AML, sdílení a názvů souborů', () => {
        const c = cu.composeSummary(base, { today: '2026-10-14' });
        expect(c.body).not.toMatch(/Interní|pravdu|AML|sdílen|svedek|Dvorak|upraveny/i);
        expect(c.body).toMatch(/^Vážený pane Nováku,/);
        expect(c.body).toContain('Do spisu byl zařazen 1 nový dokument.');
        expect(c.body).toContain('schůzku na 20. 10. 2026 v 14:00');
        expect(c.body).toContain('fakturu č. 2026015 na 12100 Kč');
        expect(c.body).toContain('Jednání u soudu 3. 12. 2026 v 09:30 (Městský soud v Brně).');
        expect(c.body).toContain('Lhůta končí 15. 11. 2026.');
        expect(c.body).not.toContain('20. 11. 2026'); // neověřená lhůta se klientovi nesděluje
        expect(c.body).toContain('JUDr. Anna Advokátní');
        expect(c.subject).toContain('12 C 45/2026');
        expect(c.eventIds.sort()).toEqual(['e2', 'e5', 'e6']);
    });

    test('od posledního souhrnu jen novější události; firma = neutrální oslovení', () => {
        const d = Object.assign({}, base, { spis: Object.assign({}, base.spis, { klient: 'PRIMA s.r.o.' }) });
        const c = cu.composeSummary(d, { since: '2026-10-04T12:00:00Z', today: '2026-10-14' });
        expect(c.body).toMatch(/^Dobrý den,/);
        expect(c.body).not.toContain('nový dokument');
        expect(c.body).toContain('fakturu');
        expect(c.body).toContain('od 4. 10. 2026');
    });
});

describe('fronta ke schválení (firemní režim)', () => {
    beforeAll(async () => {
        ADV = (await request(app).post('/api/users').set(ADMIN).send({ name: 'JUDr. Anna Advokátní', role: 'advokat' })).body;
        SEK = (await request(app).post('/api/users').set(ADMIN).send({ name: 'Bc. Simona Sekretářová', role: 'asistent' })).body;
        CIZI = (await request(app).post('/api/users').set(ADMIN).send({ name: 'JUDr. Cyril Cizí', role: 'advokat' })).body;
        expect((await request(app).post('/api/settings/firm-mode').set(ADMIN).send({ enabled: true })).statusCode).toBe(200);
        access.setFirmMode(true);
    });

    test('neplatný e-mail klienta se do spisu neuloží', async () => {
        const r = await request(app).post('/api/spisy').set(as(ADV.token)).send({ nazev: 'Špatný e-mail', klientEmail: 'neni-email' });
        expect(r.statusCode).toBe(400);
    });

    test('bez e-mailu klienta návrh nevznikne', async () => {
        const s = (await request(app).post('/api/spisy').set(as(ADV.token)).send({ nazev: 'Bez e-mailu', klient: 'Jan Novák' })).body.spis;
        const r = await request(app).post('/api/client-updates').set(as(ADV.token)).send({ spisId: s.id });
        expect(r.statusCode).toBe(400);
        expect(r.body.code).toBe('NO_CLIENT_EMAIL');
    });

    test('sekretářka navrhne, sama neodešle; advokát schválí a odešle', async () => {
        spis = (await request(app).post('/api/spisy').set(as(ADV.token)).send({ nazev: 'Novák — nájem', spisZn: '22 C 7/2026', klient: 'Jan Novák', klientEmail: 'jan.novak@example.cz', odpovednyAdvokat: 'JUDr. Anna Advokátní' })).body.spis;
        expect(spis.klientEmail).toBe('jan.novak@example.cz');
        // bez sdílení sekretářka návrh nesestaví
        expect((await request(app).post('/api/client-updates').set(as(SEK.token)).send({ spisId: spis.id })).statusCode).toBe(403);
        await request(app).post(`/api/spisy/${spis.id}/share`).set(as(ADV.token)).send({ userId: SEK.user.id, level: 'write' });
        const d = await request(app).post('/api/client-updates').set(as(SEK.token)).send({ spisId: spis.id });
        expect(d.statusCode).toBe(201);
        const id = d.body.update.id;
        expect(d.body.update.status).toBe('ke_schvaleni');
        expect(d.body.update.createdBy.id).toBe(SEK.user.id);
        // úprava textu sekretářkou je v pořádku
        expect((await request(app).patch(`/api/client-updates/${id}`).set(as(SEK.token)).send({ body: 'Vážený pane Nováku,\n\nupravený text.\n' })).statusCode).toBe(200);
        // sekretářka (asistent) schválit nesmí
        expect((await request(app).post(`/api/client-updates/${id}/approve`).set(as(SEK.token))).statusCode).toBe(403);
        expect(mailer.sendMail).not.toHaveBeenCalled();
        // cizí advokát bez přístupu ke spisu taky ne; frontu tohoto spisu nevidí
        expect((await request(app).post(`/api/client-updates/${id}/approve`).set(as(CIZI.token))).statusCode).toBe(403);
        expect((await request(app).get('/api/client-updates').set(as(CIZI.token))).body.updates).toHaveLength(0);
        const q = (await request(app).get('/api/client-updates').query({ status: 'ke_schvaleni' }).set(as(ADV.token))).body.updates;
        expect(q.map(u => u.id)).toContain(id);
        // advokát schválí → odejde s confirmedByLawyer a zapíše se do spisu
        const a = await request(app).post(`/api/client-updates/${id}/approve`).set(as(ADV.token));
        expect(a.statusCode).toBe(200);
        expect(a.body.update.status).toBe('odeslano');
        expect(a.body.update.approvedBy.id).toBe(ADV.user.id);
        expect(mailer.sendMail).toHaveBeenCalledTimes(1);
        const msg = mailer.sendMail.mock.calls[0][1];
        expect(msg).toMatchObject({ to: 'jan.novak@example.cz', confirmedByLawyer: true });
        expect(msg.body).toContain('upravený text');
        const detail = (await request(app).get(`/api/spisy/${spis.id}`).set(as(ADV.token))).body;
        expect(detail.events.some(e => e.type === 'email' && /souhrn/.test(e.note))).toBe(true);
        // podruhé už ne; odeslaný nejde upravit
        expect((await request(app).post(`/api/client-updates/${id}/approve`).set(as(ADV.token))).statusCode).toBe(409);
        expect((await request(app).patch(`/api/client-updates/${id}`).set(as(SEK.token)).send({ body: 'x' })).statusCode).toBe(409);
    });

    test('změna e-mailu klienta po sestavení návrhu → neodešle se', async () => {
        const id = (await request(app).post('/api/client-updates').set(as(ADV.token)).send({ spisId: spis.id })).body.update.id;
        await request(app).patch(`/api/spisy/${spis.id}`).set(as(ADV.token)).send({ klientEmail: 'jiny@example.cz' });
        const r = await request(app).post(`/api/client-updates/${id}/approve`).set(as(ADV.token));
        expect(r.statusCode).toBe(409);
        expect(r.body.code).toBe('RECIPIENT_CHANGED');
        expect(mailer.sendMail).not.toHaveBeenCalled(); // jest clearMocks: počítadlo se mezi testy nuluje
        expect((await request(app).post(`/api/client-updates/${id}/reject`).set(as(ADV.token)).send({ reason: 'nový e-mail' })).body.update.status).toBe('zamitnuto');
    });

    test('selhání SMTP → stav chyba, lze zopakovat', async () => {
        const id = (await request(app).post('/api/client-updates').set(as(ADV.token)).send({ spisId: spis.id })).body.update.id;
        mailer.sendMail.mockRejectedValueOnce(Object.assign(new Error('SMTP timeout'), { code: 'SEND_FAILED' }));
        const r = await request(app).post(`/api/client-updates/${id}/approve`).set(as(ADV.token));
        expect(r.statusCode).toBe(502);
        expect(cu.get(id).status).toBe('chyba');
        expect((await request(app).post(`/api/client-updates/${id}/approve`).set(as(ADV.token))).statusCode).toBe(200);
    });
});

test('/api/email/send: příznak confirmedByLawyer od asistentky nestačí', async () => {
    const r = await request(app).post('/api/email/send').set(as(SEK.token)).send({ to: 'jan.novak@example.cz', subject: 'x', body: 'y', confirmedByLawyer: true });
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe('forbidden_role');
    expect(mailer.sendMail).not.toHaveBeenCalled();
    const ok = await request(app).post('/api/email/send').set(as(ADV.token)).send({ to: 'jan.novak@example.cz', subject: 'x', body: 'y', confirmedByLawyer: true });
    expect(ok.statusCode).toBe(200);
});

test('inventář před skartací: ukáže, co zůstane (deník, souhrny), jen vlastník/správce', async () => {
    const r = await request(app).get(`/api/spisy/${spis.id}/skartace-inventar`).set(as(ADV.token));
    expect(r.statusCode).toBe(200);
    const byKind = Object.fromEntries(r.body.items.map(i => [i.kind, i]));
    expect(byKind.client_updates.count).toBeGreaterThanOrEqual(1);
    expect(byKind.client_updates.action).toBe('smazat');
    expect(byKind.spis_events.count).toBeGreaterThanOrEqual(1);
    expect(byKind.aml_checks.action).toBe('ponechat');
    expect(byKind.audit.action).toBe('pseudonymizovat');
    expect((await request(app).get(`/api/spisy/${spis.id}/skartace-inventar`).set(as(SEK.token))).statusCode).toBe(403);
});

test('plán skartace: konkrétní ID položek ke smazání / ponechání, jen čte, jen vlastník/správce', async () => {
    const r = await request(app).get(`/api/spisy/${spis.id}/skartace-plan`).set(as(ADV.token));
    expect(r.statusCode).toBe(200);
    expect(r.body.smazat.spis).toEqual([spis.id]);
    expect(r.body.smazat.client_updates.length).toBeGreaterThanOrEqual(1);
    expect(r.body.smazat.spis_events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.ponechat).toHaveProperty('aml_checks');
    expect(r.body.souhrn.smazat).toBeGreaterThanOrEqual(3);
    // nic se nesmazalo
    const inv = await request(app).get(`/api/spisy/${spis.id}/skartace-inventar`).set(as(ADV.token));
    expect(inv.statusCode).toBe(200);
    expect((await request(app).get(`/api/spisy/${spis.id}/skartace-plan`).set(as(SEK.token))).statusCode).toBe(403);
});
