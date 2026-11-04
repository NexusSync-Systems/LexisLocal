/**
 * calendarInjection.test.js — texty události se do AppleScriptu / PowerShellu nevkládají (review 2, skupina 5).
 */
'use strict';
jest.mock('child_process', () => {
    const calls = [];
    return {
        __calls: calls,
        execFile: jest.fn((cmd, args, opts, cb) => {
            if (typeof opts === 'function') { cb = opts; opts = {}; }
            const call = { cmd, args, opts, script: '' };
            calls.push(call);
            setImmediate(() => cb(null, 'created', ''));
            return { stdin: { write: (s) => { call.script += s; }, end: () => {} } };
        })
    };
});
const cp = require('child_process');
const { writeToSystemCalendar } = require('../lib/calendar');
const ZLY = 'Jednání"\n do shell script "touch /tmp/x" ’; Remove-Item C:\\ -Recurse #';

function platform(p) { Object.defineProperty(process, 'platform', { value: p }); }
const puvodni = process.platform;
afterAll(() => platform(puvodni));

test('macOS: název jde jako argument, ve skriptu není', async () => {
    platform('darwin');
    await writeToSystemCalendar({ title: ZLY, date: '2026-12-01', time: '10:00', description: ZLY, location: 'Brno' });
    const c = cp.__calls.pop();
    expect(c.cmd).toBe('osascript');
    expect(c.args).toEqual(['-', ZLY, ZLY, 'Brno']);
    expect(c.script).not.toMatch(/touch|Jednání/);
    expect(c.script).toMatch(/on run argv/);
});

test('Windows: název jde v proměnné prostředí, ve skriptu není', async () => {
    platform('win32');
    await writeToSystemCalendar({ title: ZLY, date: '2026-12-01', time: '10:00', description: 'x', location: 'y' });
    const c = cp.__calls.pop();
    expect(c.cmd).toBe('powershell');
    expect(c.opts.env.LEXIS_CAL_TITLE).toBe(ZLY);
    expect(c.script).not.toMatch(/Remove-Item|Jednání/);
});

describe('ICS: pevný tvar data, času a UID', () => {
    const { buildIcs } = require('../lib/ics');
    test('nový řádek v datu / čase / UID neprojde', () => {
        expect(() => buildIcs({ title: 'x', date: '2026-12-01\r\nATTACH:http://zlo' })).toThrow(/Datum/);
        expect(() => buildIcs({ title: 'x', date: '2026-12-01', time: '10:00\r\nX:1' })).toThrow(/Čas/);
        const ics = buildIcs({ id: 'a\r\nATTACH:x', title: 'Název, s; čárkou\nřádek', date: '2026-12-01', time: '9:05' });
        expect(ics).not.toMatch(/\r\nATTACH/);
        expect(ics).toContain('SUMMARY:Název\\, s\\; čárkou\\nřádek');
        expect(ics).toMatch(/DTSTART;TZID=Europe\/Prague:20261201T090500/);
    });
});
