/**
 * lib/hearings_health.js — stav hlídače soudních jednání.
 *
 * Výpadek zdroje (InfoJednání) se NESMÍ tvářit jako „beze změny“. Evidujeme poslední
 * pokus a poslední úspěch; když zdroj neodpovídá déle než LEXIS_HEARINGS_OUTAGE_ALERT_H
 * (výchozí 6 h), vznikne JEDNO upozornění pro advokáta a po obnovení se uzavře.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ALERT_AFTER_H = () => parseFloat(process.env.LEXIS_HEARINGS_OUTAGE_ALERT_H || '') || 6;
const FILE = dir => path.join(dir, '.hearings_health.json');

function load(dir) {
    try { return JSON.parse(fs.readFileSync(FILE(dir), 'utf8')); } catch (e) { return {}; }
}
function save(dir, s) {
    try { fs.writeFileSync(FILE(dir), JSON.stringify(s, null, 2), 'utf8'); } catch (e) { /* best effort */ }
}

function recordSuccess(dir, now = new Date()) {
    const s = load(dir);
    const recovered = !!s.outageSince;
    const prevOutage = s.outageSince || null;
    Object.assign(s, { lastAttemptAt: now.toISOString(), lastSuccessAt: now.toISOString(), consecutiveFailures: 0, lastError: null, outageSince: null });
    save(dir, s);
    return { recovered, outageSince: prevOutage };
}

function recordFailure(dir, reason, now = new Date()) {
    const s = load(dir);
    s.lastAttemptAt = now.toISOString();
    s.consecutiveFailures = (s.consecutiveFailures || 0) + 1;
    s.lastError = String(reason || 'neznámá chyba');
    if (!s.outageSince) s.outageSince = now.toISOString();
    save(dir, s);
    return s;
}

/**
 * Souhrn pro UI/readiness: status ∈ never | ok | degraded | down
 *  • never    — ještě nic nehlídá / neproběhla žádná kontrola
 *  • degraded — poslední pokus selhal, ale kratší dobu než práh
 *  • down     — zdroj nedostupný déle než práh → advokát musí ověřit ručně
 */
function summary(dir, now = new Date()) {
    const s = load(dir);
    if (!s.lastAttemptAt) return { status: 'never', ...s };
    if (!s.outageSince) return { status: 'ok', ...s };
    const hours = (now - new Date(s.outageSince)) / 3600000;
    return { status: hours >= ALERT_AFTER_H() ? 'down' : 'degraded', outageHours: Math.round(hours * 10) / 10, ...s };
}

module.exports = { load, recordSuccess, recordFailure, summary, ALERT_AFTER_H };
