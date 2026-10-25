/**
 * LexisLocal — Fakturace / vyúčtování.
 *
 * Navazuje na time-tracking (kolekce `activities`, agregovaný přes spis) a na
 * ceník odměn v manažerském modulu (`settings.default_hourly_rate`, `fees`).
 * Vytvoří fakturu ze zaznamenaného času spisu a/nebo z ručně zadaných položek,
 * spočítá DPH, odečte zálohu a vede přehled (ne)uhrazených faktur.
 *
 * POZNÁMKA k advokátnímu tarifu (vyhl. 177/1996 Sb.): tarifní odměna za úkon se
 * ZÁMĚRNĚ nepočítá automaticky — konkrétní sazby jsou právní parametr. Tarif lze
 * zadat jako ruční položku (`type: 'tarif'`). Časová a paušální fakturace je plně
 * automatická.
 */
'use strict';

const db = require('./database');
const spisy = require('./spisy');

function _round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

// Výchozí hodinová sazba z manažerských nastavení (jinak 2500 Kč).
function defaultHourlyRate() {
    const settings = db.get('settings') || [];
    const s = settings.find(x => x.key === 'default_hourly_rate');
    const r = s ? parseFloat(s.value) : NaN;
    return Number.isFinite(r) && r > 0 ? r : 2500;
}

// --- Položky faktury --------------------------------------------------------
function timeItem(hours, rate) {
    const h = _round2(hours);
    const r = _round2(rate);
    return { type: 'time', popis: `Právní služby dle časové dotace (${h} hod × ${r} Kč)`, hours: h, rate: r, amount: _round2(h * r) };
}
function normalizeItem(raw) {
    raw = raw || {};
    const popis = String(raw.popis || 'Položka').trim();
    // Záporné či nečíselné položky odmítnout (test 2. 10. 2026: faktura s −500 Kč prošla).
    for (const k of ['qty', 'unitPrice', 'amount']) {
        if (raw[k] != null && (!Number.isFinite(Number(raw[k])) || Number(raw[k]) < 0)) {
            throw new Error(`Položka „${popis}“: ${k} musí být nezáporné číslo.`);
        }
    }
    // qty × unitPrice má přednost; jinak přímá amount.
    if (raw.qty != null && raw.unitPrice != null) {
        const qty = Number(raw.qty) || 0;
        const unitPrice = _round2(raw.unitPrice);
        return { type: raw.type || 'flat', popis, qty, unitPrice, amount: _round2(qty * unitPrice) };
    }
    return { type: raw.type || 'flat', popis, amount: _round2(raw.amount) };
}

/**
 * Spočítá součty faktury z položek.
 * @param items pole položek s `amount`
 * @param opts { dphRate=21 (0 pro neplátce), zaloha=0 }
 */
function computeTotals(items, opts) {
    opts = opts || {};
    const dphRate = Number.isFinite(opts.dphRate) ? opts.dphRate : 21;
    const zaloha = _round2(opts.zaloha || 0);
    const subtotal = _round2((items || []).reduce((s, i) => s + (Number(i.amount) || 0), 0));
    const dphAmount = _round2(subtotal * (dphRate / 100));
    const total = _round2(subtotal + dphAmount);
    const toPay = _round2(Math.max(0, total - zaloha));
    return { subtotal, dphRate, dphAmount, total, zaloha, toPay };
}

function _nextVarSymbol() {
    // Variabilní symbol: RRRR + pořadí (nekolizní v rámci roku). Bez Date.now,
    // aby byl deterministický vůči počtu existujících faktur.
    const year = new Date().getFullYear();
    const seq = ((db.get('invoices') || []).length + 1).toString().padStart(4, '0');
    return `${year}${seq}`;
}

/**
 * Vytvoří fakturu ze spisu: čas (z activities přes spis) + volitelné položky.
 * @param spisId
 * @param opts { rate, includeTime=true, items=[], dphRate=21, zaloha=0, splatnostDni=14, zpracoval }
 */
function createInvoiceFromSpis(spisId, opts) {
    opts = opts || {};
    const spis = spisy.getSpis(spisId);
    if (!spis) throw new Error('Spis nenalezen.');

    const detail = spisy.getSpisDetail(spisId);
    const rate = Number.isFinite(opts.rate) && opts.rate > 0 ? opts.rate : defaultHourlyRate();

    const items = [];
    if (opts.includeTime !== false && detail.metrics.timeHours > 0) {
        items.push(timeItem(detail.metrics.timeHours, rate));
    }
    (opts.items || []).forEach(it => items.push(normalizeItem(it)));

    if (items.length === 0) {
        throw new Error('Faktura nemá co fakturovat (nulový čas i žádné položky).');
    }

    const totals = computeTotals(items, { dphRate: opts.dphRate, zaloha: opts.zaloha });
    return _persistInvoice({
        spisId: spis.id,
        spisZn: spis.spisZn,
        klient: spis.klient || '',
        klientIco: spis.klientIco || '',
        items,
        ...totals,
        splatnostDni: Number.isFinite(opts.splatnostDni) ? opts.splatnostDni : 14,
        zpracoval: opts.zpracoval ? String(opts.zpracoval) : ''
    });
}

/**
 * Vytvoří fakturu z ručních položek (bez vazby na spis nebo mimo časovou dotaci).
 */
function createInvoice(data) {
    data = data || {};
    const items = (data.items || []).map(normalizeItem);
    if (items.length === 0) throw new Error('Faktura musí obsahovat alespoň jednu položku.');
    const totals = computeTotals(items, { dphRate: data.dphRate, zaloha: data.zaloha });
    return _persistInvoice({
        spisId: data.spisId || null,
        spisZn: data.spisZn || '',
        klient: data.klient || '',
        klientIco: data.klientIco || '',
        items,
        ...totals,
        splatnostDni: Number.isFinite(data.splatnostDni) ? data.splatnostDni : 14,
        zpracoval: data.zpracoval ? String(data.zpracoval) : ''
    });
}

function _persistInvoice(fields) {
    const invoice = db.insert('invoices', {
        ...fields,
        variabilniSymbol: _nextVarSymbol(),
        status: fields.toPay > 0 ? 'unpaid' : 'paid',
        paidAmount: 0
    });
    if (invoice.spisId) {
        spisy.addEvent(invoice.spisId, 'faktura', `Vystavena faktura ${invoice.variabilniSymbol} na ${invoice.toPay} Kč.`);
    }
    return invoice;
}

// Seznam faktur; filtr { status:'unpaid'|'paid', spisId }.
function listInvoices(filter) {
    filter = filter || {};
    let list = db.get('invoices') || [];
    if (filter.status) list = list.filter(i => i.status === filter.status);
    if (filter.spisId) list = list.filter(i => i.spisId === filter.spisId);
    return list;
}

// Přehled neuhrazených + celková dlužná částka.
function getOutstanding() {
    const unpaid = listInvoices({ status: 'unpaid' }).concat(listInvoices({ status: 'partial' }));
    const totalDue = _round2(unpaid.reduce((s, i) => s + (i.toPay - (i.paidAmount || 0)), 0));
    return { count: unpaid.length, totalDue, invoices: unpaid };
}

// Zaznamená (částečnou) úhradu. Nastaví status paid/partial dle částky.
function markPaid(id, paidAmount) {
    const inv = (db.get('invoices') || []).find(i => i.id === id);
    if (!inv) throw new Error('Faktura nenalezena.');
    const paid = _round2((inv.paidAmount || 0) + (Number(paidAmount) || inv.toPay));
    const status = paid >= inv.toPay ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
    const updated = db.update('invoices', id, { paidAmount: paid, status, paidAt: new Date().toISOString() });
    if (updated.spisId) spisy.addEvent(updated.spisId, 'faktura', `Úhrada faktury ${updated.variabilniSymbol}: ${paid} Kč (${status}).`);
    return updated;
}

module.exports = {
    defaultHourlyRate,
    timeItem,
    normalizeItem,
    computeTotals,
    createInvoiceFromSpis,
    createInvoice,
    listInvoices,
    getOutstanding,
    markPaid
};
