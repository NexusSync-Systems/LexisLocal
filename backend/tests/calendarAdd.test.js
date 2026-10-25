/** Test 2. 10. 2026 (C13): událost z POST /api/calendar/add nebyla vidět v /events. */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `lexis_test_caladd_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.API_TOKEN = 'tok-test';
process.env.WATCH_DIR = tmp;
process.env.LEXIS_KEY_DIR = tmp + '_key';

jest.mock('../lib/calendar', () => ({ writeToSystemCalendar: jest.fn(async () => 'unsupported') }));

const request = require('supertest');
const app = require('../server');
const H = (r) => r.set('X-API-Token', 'tok-test');

test('událost přidaná přes /add je ve výpisu /events (i po opakovaném přidání jen jednou)', async () => {
    const a = await H(request(app).post('/api/calendar/add')).send({ id: 'dl_e2e_1', title: 'E2E lhůta', dueDate: '2027-01-05', time: '10:00' });
    expect(a.status).toBe(200);
    await H(request(app).post('/api/calendar/add')).send({ id: 'dl_e2e_1', title: 'E2E lhůta', dueDate: '2027-01-05', time: '10:00' });
    const e = await H(request(app).get('/api/calendar/events'));
    expect(e.status).toBe(200);
    const mine = e.body.events.filter(x => x.id === 'dl_e2e_1');
    expect(mine.length).toBe(1);
    expect(mine[0]).toMatchObject({ date: '2027-01-05', time: '10:00', type: 'deadline' });
    expect(mine[0].title).toMatch(/E2E lhůta/);
});
