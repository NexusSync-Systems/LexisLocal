/**
 * lib/signature_check.js — ověření elektronických podpisů v PDF pro LexisLocal.
 *
 * Doručené PDF (rozhodnutí soudu, podání protistrany, smlouva od klienta) se při
 * zpracování zkontroluje: je podepsané? kým? je podpis neporušený? má časové razítko?
 * Výsledek se uloží k dokumentu v doručené poště (pole `signatures`).
 *
 * Podpisy SE NA SERVERU NEVYTVÁŘEJÍ — soukromý klíč advokáta patří do jeho počítače
 * (LexisEditor), ne na sdílený server. Tady se jen ověřuje (veřejná data z PDF).
 *
 * Kontroluje se integrita, podpis, platnost certifikátu, razítko a příznaky
 * kvalifikovaného certifikátu. Důvěryhodnost vystavitele vůči EU Trusted List se
 * offline NEověřuje (trustChecked: false) — to výslovně říkáme i uživateli.
 */
'use strict';

const fs = require('fs');

let _mod; // null = modul/závislost není k dispozici
function _lib() {
    if (_mod === undefined) {
        try { _mod = require('./pdf-signature'); }
        catch (e) { _mod = null; console.warn('ℹ️ Ověření podpisů PDF nedostupné (chybí node-forge? spusťte npm install):', e.message); }
    }
    return _mod;
}

const MAX_BYTES = 60 * 1024 * 1024;

/** Kompaktní souhrn pro doručenou poštu / API. Vrací null, když nejde o PDF nebo chybí knihovna. */
function summarize(result) {
    const sigs = (result.signatures || []).map(s => ({
        index: s.index,
        valid: !!s.valid,
        integrity: s.integrity !== false,
        level: s.level || null,
        signer: s.signer ? s.signer.name : null,
        issuer: s.signer ? s.signer.issuer : null,
        signingTime: s.signingTime || null,
        qualifiedCertificate: !!s.qualifiedCertificate,
        timestamp: s.timestamp && s.timestamp.present ? { valid: !!s.timestamp.valid, time: s.timestamp.time || null } : null,
        coversWholeDocument: s.coversWholeDocument !== false,
        warnings: s.warnings || []
    }));
    const validCount = sigs.filter(s => s.valid).length;
    return {
        signed: sigs.length > 0,
        count: sigs.length,
        allValid: sigs.length > 0 && validCount === sigs.length,
        anyInvalid: sigs.some(s => !s.valid),
        signatures: sigs,
        summary: result.summary || '',
        trustChecked: false,
        checkedAt: new Date().toISOString()
    };
}

function checkPdfBuffer(buf) {
    const lib = _lib();
    if (!lib) return null;
    if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.slice(0, 5).toString('latin1') !== '%PDF-') return null;
    if (buf.length > MAX_BYTES) return { signed: false, count: 0, signatures: [], error: 'Soubor je příliš velký pro ověření podpisu.' };
    try { return summarize(lib.verifyPdfSignatures(buf)); }
    catch (e) { return { signed: false, count: 0, signatures: [], error: 'Podpisy nejde přečíst: ' + e.message }; }
}

function checkPdfFile(filePath) {
    if (!/\.pdf$/i.test(String(filePath || ''))) return null;
    let buf;
    try { buf = fs.readFileSync(filePath); } catch (e) { return null; }
    return checkPdfBuffer(buf);
}

/** Krátká věta do shrnutí dokumentu (prázdná, když PDF není podepsané). */
function summaryNote(sig) {
    if (!sig || !sig.signed) return '';
    const who = sig.signatures.map(s => s.signer).filter(Boolean).join(', ');
    if (sig.anyInvalid) return `⚠️ NEPLATNÝ ELEKTRONICKÝ PODPIS${who ? ' (' + who + ')' : ''} — dokument mohl být po podpisu změněn, ověřte originál. `;
    return `🔏 Elektronicky podepsáno${who ? ': ' + who : ''}. `;
}

module.exports = { checkPdfBuffer, checkPdfFile, summarize, summaryNote, MAX_BYTES, _reset: () => { _mod = undefined; } };
