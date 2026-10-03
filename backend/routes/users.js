/**
 * routes/users.js — uživatelé kanceláře.
 *
 *   /api/users   (jen správce — vynucuje lib/authz.js)
 *     GET    /                          seznam uživatelů (bez tokenů)
 *     POST   /                          { name, role, deviceLabel } → účet + první zařízení (token jen jednou) + párování
 *     PATCH  /:id                       { name?, role?, disabled? }
 *     POST   /:id/devices               { label } → nové zařízení (token jen jednou) + párování
 *     DELETE /:id/devices/:deviceId     zrušit zařízení (ztracený telefon …)
 *
 *   /api/me      (kdokoli přihlášený)
 *     GET    /                          kdo jsem (jméno, role, oprávnění, moje zařízení)
 *     DELETE /devices/:deviceId         zrušit vlastní zařízení
 *
 * Párování: odpověď nese jednorázový kód (2 min) + hotové odkazy — pro LexisEditor
 * `lexis://host/?fp=<otisk>&code=…`, pro telefon `/m?pair=…`. Token se v odkazech nikdy
 * neobjevuje; přímo ho dostane jen správce v odpovědi (pro ruční zadání).
 */
'use strict';

const express = require('express');
const users = require('../lib/users');
const pairing = require('../lib/pairing');
const { logEvent } = require('../lib/audit');

function fail(res, e) { res.status(e.status || 500).json({ error: e.message }); }

function pairingFor(req, token) {
    const { code, ttl } = pairing.createCode(token);
    const isHttps = req.secure || process.env.USE_HTTPS === 'true';
    const port = req.app.locals.port || process.env.PORT || 4000;
    const pin = isHttps ? (req.app.locals.tlsPin || null) : null;
    const tlsId = require('../lib/tls_identity');
    return {
        code, ttl,
        urls: pairing.buildUrls(port, code, { https: isHttps, host: req.headers.host }),
        editor: pin ? { connectUrl: tlsId.buildConnectUrl({ host: req.headers.host, pin, code }), pinShort: tlsId.shortPin(pin) } : null
    };
}

function by(req) { const p = req.principal || {}; return p.name || 'Správce'; }
function audit(op, target, details) { try { logEvent('Uživatelé', op, target, details || {}); } catch (e) { /* best-effort */ } }

// ── správa (admin) ───────────────────────────────────────────────────────────
const admin = express.Router();

admin.get('/', (req, res) => {
    res.json({ users: users.listUsers(), roles: Object.entries(users.ROLES).map(([id, r]) => ({ id, label: r.label, scopes: r.scopes })) });
});

admin.post('/', (req, res) => {
    try {
        const b = req.body || {};
        const r = users.createUser({ name: b.name, role: b.role, deviceLabel: b.deviceLabel }, by(req));
        audit('Založení uživatele', r.user.name, { userId: r.user.id, role: r.user.role, by: by(req) });
        res.status(201).json({ user: r.user, device: r.device, token: r.token, pairing: pairingFor(req, r.token) });
    } catch (e) { fail(res, e); }
});

admin.patch('/:id', (req, res) => {
    try {
        const before = users.getUser(req.params.id);
        const u = users.updateUser(req.params.id, req.body || {});
        const changes = {};
        if (before && before.role !== u.role) changes.role = `${before.role} → ${u.role}`;
        if (before && before.name !== u.name) changes.name = `${before.name} → ${u.name}`;
        if (before && before.disabled !== u.disabled) changes.disabled = u.disabled;
        audit(u.disabled && before && !before.disabled ? 'Deaktivace uživatele' : 'Úprava uživatele', u.name, Object.assign({ userId: u.id, by: by(req) }, changes));
        res.json({ user: u });
    } catch (e) { fail(res, e); }
});

admin.post('/:id/devices', (req, res) => {
    try {
        const r = users.addDevice(req.params.id, (req.body || {}).label);
        const u = users.getUser(req.params.id);
        audit('Nové zařízení uživatele', u.name, { userId: u.id, device: r.device.label, by: by(req) });
        res.status(201).json({ user: u, device: r.device, token: r.token, pairing: pairingFor(req, r.token) });
    } catch (e) { fail(res, e); }
});

admin.delete('/:id/devices/:deviceId', (req, res) => {
    try {
        const u = users.revokeDevice(req.params.id, req.params.deviceId);
        audit('Zrušení zařízení uživatele', u.name, { userId: u.id, deviceId: req.params.deviceId, by: by(req) });
        res.json({ user: u });
    } catch (e) { fail(res, e); }
});

// ── já ───────────────────────────────────────────────────────────────────────
const me = express.Router();

me.get('/', (req, res) => {
    const p = req.principal;
    if (!p) return res.status(401).json({ error: 'Nepřihlášen.' });
    const role = users.ROLES[p.role] || null;
    const out = {
        userId: p.userId, name: p.name, kind: p.kind, role: p.role || null, roleLabel: role ? role.label : null,
        scopes: p.scopes || [], device: p.deviceLabel || null,
        // Hlavní token / solo režim = sdílená identita „Místní uživatel“ → UI doporučí vlastní účty.
        sharedIdentity: p.kind === 'local-token' || p.kind === 'implicit',
        usersConfigured: users.listUsers().length > 0
    };
    if (p.kind === 'user') { const u = users.getUser(p.userId); out.devices = u ? u.devices : []; }
    res.json(out);
});

// Kolegové pro sdílení spisu / koncepty (jen jméno a role — bez zařízení a tokenů).
me.get('/colleagues', (req, res) => {
    res.json({ users: users.listUsers().filter(u => !u.disabled).map(u => ({ id: u.id, name: u.name, role: u.role, roleLabel: u.roleLabel })) });
});

me.delete('/devices/:deviceId', (req, res) => {
    const p = req.principal;
    if (!p || p.kind !== 'user') return res.status(400).json({ error: 'Zařízení spravuje jen uživatel s vlastním účtem.' });
    try {
        const u = users.revokeDevice(p.userId, req.params.deviceId);
        audit('Zrušení vlastního zařízení', u.name, { userId: u.id, deviceId: req.params.deviceId });
        res.json({ user: u });
    } catch (e) { fail(res, e); }
});

module.exports = { admin, me };
