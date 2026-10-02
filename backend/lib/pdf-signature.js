/**
 * pdf-signature.js — ověření elektronických podpisů v PDF a časové razítko (RFC 3161).
 *
 * Sdílený modul LexisEditoru (js/core/) a LexisLocalu (backend/lib/) — STEJNÝ soubor
 * v obou repech. Čistý Node (crypto + node-forge pro ASN.1), bez sítě kromě TSA.
 *
 *  • verifyPdfSignatures(pdf) — pro každý podpis: integrita (hash podepsaných bajtů),
 *    platnost kryptografického podpisu, podepisující, čas podpisu, časové razítko,
 *    kvalifikovaný certifikát (QcStatements), klíč na kvalifikovaném prostředku (QcSSCD),
 *    zda podpis kryje celý dokument (jinak byl dokument po podpisu doplněn).
 *    ⚠️ Důvěryhodnost vystavitele vůči EU Trusted List se offline NEOVĚŘUJE — výsledek
 *    to výslovně říká (trustChecked:false).
 *  • timestampCms(cms, {tsaUrl}) — doplní do podpisu časové razítko z TSA (RFC 3161)
 *    jako nepodepsaný atribut signature-time-stamp (PAdES-B-T).
 */
'use strict';

const crypto = require('crypto');
const forge = require('node-forge');

const asn1 = forge.asn1;
const OID = {
    signedData: '1.2.840.113549.1.7.2',
    messageDigest: '1.2.840.113549.1.9.4',
    signingTime: '1.2.840.113549.1.9.5',
    timeStampToken: '1.2.840.113549.1.9.16.2.14',
    tstInfo: '1.2.840.113549.1.9.16.1.4',
    sha1: '1.3.14.3.2.26', sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3',
    rsaPss: '1.2.840.113549.1.1.10'
};
const HASH_BY_OID = { [OID.sha1]: 'sha1', [OID.sha256]: 'sha256', [OID.sha384]: 'sha384', [OID.sha512]: 'sha512' };
// OID přípony v DER (pro detekci v certifikátu bez plného parseru rozšíření)
const DER_QC_STATEMENTS = Buffer.from('06082b06010505070103', 'hex');   // 1.3.6.1.5.5.7.1.3
const DER_QC_SSCD = Buffer.from('060604008e46010 4'.replace(/\s/g, ''), 'hex'); // 0.4.0.1862.1.4

const bin = buf => forge.util.createBuffer(Buffer.from(buf).toString('binary'));
const toBuf = der => Buffer.from(der.getBytes ? der.getBytes() : der, 'binary');
const derOf = node => toBuf(asn1.toDer(node));
const oidOf = node => asn1.derToOid(node.value);
const isCtx = (n, t) => n && n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === t;

// ── Parsování CMS ───────────────────────────────────────────────────────────
function parseCms(der) {
    const ci = asn1.fromDer(bin(der), { strict: false, parseAllBytes: false });
    if (oidOf(ci.value[0]) !== OID.signedData) throw new Error('Nejde o CMS SignedData.');
    const sd = ci.value[1].value[0];
    const parts = sd.value;
    const certsNode = parts.find(p => isCtx(p, 0));
    const signerInfos = parts[parts.length - 1];
    const encap = parts[2];
    let eContent = null;
    if (encap.value[1] && isCtx(encap.value[1], 0)) {
        const oct = encap.value[1].value[0];
        eContent = Buffer.from(oct.constructed ? oct.value.map(o => o.value).join('') : oct.value, 'binary');
    }
    const certs = certsNode ? certsNode.value.filter(c => c.tagClass === asn1.Class.UNIVERSAL).map(c => derOf(c)) : [];
    return { ci, sd, certs, signerInfos, eContentType: oidOf(encap.value[0]), eContent };
}

function parseSignerInfo(si) {
    const v = si.value;
    let i = 0;
    const version = v[i++];
    const sid = v[i++];
    const digestAlg = oidOf(v[i++].value[0]);
    let signedAttrs = null;
    if (isCtx(v[i], 0)) signedAttrs = v[i++];
    const sigAlgNode = v[i++];
    const sigAlg = oidOf(sigAlgNode.value[0]);
    const signature = Buffer.from(v[i++].value, 'binary');
    const unsignedAttrs = isCtx(v[i], 1) ? v[i] : null;
    const attrs = {};
    if (signedAttrs) for (const a of signedAttrs.value) attrs[oidOf(a.value[0])] = a.value[1].value;
    const unsigned = {};
    if (unsignedAttrs) for (const a of unsignedAttrs.value) unsigned[oidOf(a.value[0])] = a.value[1].value;
    // sid = IssuerAndSerialNumber → sériové číslo
    let serialHex = null;
    if (sid.tagClass === asn1.Class.UNIVERSAL && sid.value[1]) serialHex = Buffer.from(sid.value[1].value, 'binary').toString('hex').replace(/^0+/, '').toUpperCase();
    return { version, digestAlg, signedAttrs, sigAlg, sigAlgNode, signature, attrs, unsigned, serialHex };
}

function signedAttrsDer(signedAttrs) {
    // Podpis se počítá nad DER kódováním jako SET (ne [0] IMPLICIT).
    return derOf(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, signedAttrs.value));
}

function asn1Time(node) {
    try { return node.type === asn1.Type.UTCTIME ? asn1.utcTimeToDate(node.value) : asn1.generalizedTimeToDate(node.value); }
    catch (e) { return null; }
}

function findSignerCert(certs, serialHex) {
    for (const der of certs) {
        try {
            const x = new crypto.X509Certificate(der);
            if (serialHex && x.serialNumber.replace(/^0+/, '').toUpperCase() === serialHex) return { der, x };
        } catch (e) { /* nečitelný certifikát */ }
    }
    if (certs.length === 1) return { der: certs[0], x: new crypto.X509Certificate(certs[0]) };
    return null;
}

function verifySignatureValue(si, cert) {
    const hash = HASH_BY_OID[si.digestAlg] || 'sha256';
    const data = si.signedAttrs ? signedAttrsDer(si.signedAttrs) : null;
    if (!data) return false;
    const key = cert.x.publicKey;
    try {
        if (si.sigAlg === OID.rsaPss) {
            return crypto.verify(hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_AUTO }, si.signature);
        }
        return crypto.verify(hash, data, key, si.signature);
    } catch (e) { return false; }
}

/** Ověří CMS (podpis PDF nebo časové razítko) nad daty `content` (detached) nebo eContent. */
function verifyCms(der, content) {
    const cms = parseCms(der);
    const si = parseSignerInfo(cms.signerInfos.value[0]);
    const hash = HASH_BY_OID[si.digestAlg] || 'sha256';
    const data = content || cms.eContent;
    const md = si.attrs[OID.messageDigest] ? Buffer.from(si.attrs[OID.messageDigest][0].value, 'binary') : null;
    const integrity = !!(md && data && crypto.createHash(hash).update(data).digest().equals(md));
    const cert = findSignerCert(cms.certs, si.serialHex);
    const sigOk = !!(cert && verifySignatureValue(si, cert));
    const st = si.attrs[OID.signingTime] ? asn1Time(si.attrs[OID.signingTime][0]) : null;
    return { cms, si, cert, integrity, signatureValid: sigOk, signingTime: st };
}

// ── Časové razítko ──────────────────────────────────────────────────────────
function parseTstInfo(der) {
    const t = asn1.fromDer(bin(der), { strict: false });
    const mi = t.value[2];
    return {
        hashAlg: HASH_BY_OID[oidOf(mi.value[0].value[0])] || null,
        imprint: Buffer.from(mi.value[1].value, 'binary'),
        genTime: asn1Time(t.value[4]),
        nonce: t.value.find((n, i) => i > 4 && n.tagClass === asn1.Class.UNIVERSAL && n.type === asn1.Type.INTEGER) || null
    };
}

function verifyTimestampToken(tokenNodes, signatureValue) {
    try {
        const tokDer = derOf(tokenNodes[0]);
        const v = verifyCms(tokDer, null);
        if (v.cms.eContentType !== OID.tstInfo) return { present: true, valid: false, reason: 'neplatný typ obsahu razítka' };
        const tst = parseTstInfo(v.cms.eContent);
        const imprintOk = !!tst.hashAlg && crypto.createHash(tst.hashAlg).update(signatureValue).digest().equals(tst.imprint);
        return {
            present: true,
            valid: v.integrity && v.signatureValid && imprintOk,
            time: tst.genTime ? tst.genTime.toISOString() : null,
            tsa: v.cert ? v.cert.x.subject.replace(/\n/g, ', ') : null
        };
    } catch (e) {
        return { present: true, valid: false, reason: 'razítko nejde přečíst: ' + e.message };
    }
}

// ── PDF ─────────────────────────────────────────────────────────────────────
function findPdfSignatures(pdf) {
    const s = pdf.toString('latin1');
    const out = [];
    const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
    let m;
    while ((m = re.exec(s))) {
        const br = m.slice(1, 5).map(Number);
        // /Contents <hex> leží v mezeře mezi oběma rozsahy
        const gap = s.slice(br[0] + br[1], br[2]);
        const hm = gap.match(/<([0-9A-Fa-f]+)>/);
        if (!hm) continue;
        let hex = hm[1].replace(/(00)+$/, '');
        if (hex.length % 2) hex += '0';
        out.push({ byteRange: br, cms: Buffer.from(hex, 'hex') });
    }
    return out;
}

function _name(subject) {
    const m = String(subject || '').match(/(?:^|\n)CN=([^\n]+)/);
    return m ? m[1] : String(subject || '').split('\n')[0];
}

/**
 * Ověří všechny podpisy v PDF.
 * @returns {{ signed:boolean, signatures:Array, summary:string }}
 */
function verifyPdfSignatures(pdf) {
    const buf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    const sigs = findPdfSignatures(buf);
    const results = sigs.map((sig, idx) => {
        const [a, b, c, d] = sig.byteRange;
        const r = { index: idx + 1, warnings: [], trustChecked: false };
        if (a !== 0 || a + b > c || c + d > buf.length) {
            return Object.assign(r, { valid: false, integrity: false, warnings: ['Neplatný rozsah podepsaných dat (ByteRange).'] });
        }
        const content = Buffer.concat([buf.slice(a, a + b), buf.slice(c, c + d)]);
        let v;
        try { v = verifyCms(sig.cms, content); }
        catch (e) { return Object.assign(r, { valid: false, integrity: false, warnings: ['Podpis nejde přečíst: ' + e.message] }); }
        r.integrity = v.integrity;
        r.signatureValid = v.signatureValid;
        r.coversWholeDocument = c + d === buf.length;
        if (!r.coversWholeDocument) r.warnings.push('Po podpisu byl do dokumentu přidán další obsah (pozdější úprava nebo další podpis) — zkontrolujte, co se změnilo.');
        r.signingTime = v.signingTime ? v.signingTime.toISOString() : null;
        if (v.cert) {
            const x = v.cert.x;
            r.signer = {
                name: _name(x.subject), subject: x.subject.replace(/\n/g, ', '), issuer: x.issuer.replace(/\n/g, ', '),
                serial: x.serialNumber, validFrom: new Date(x.validFrom).toISOString(), validTo: new Date(x.validTo).toISOString()
            };
            r.qualifiedCertificate = v.cert.der.includes(DER_QC_STATEMENTS);
            r.qualifiedDevice = v.cert.der.includes(DER_QC_SSCD);
            const when = v.signingTime || new Date();
            r.certValidAtSigning = when >= new Date(x.validFrom) && when <= new Date(x.validTo);
            if (!r.certValidAtSigning) r.warnings.push('Certifikát nebyl v době podpisu platný.');
            // řetěz: je v podpisu i certifikát vystavitele a sedí jeho podpis?
            const issuerCert = v.cms.certs.map(der => { try { return new crypto.X509Certificate(der); } catch (e) { return null; } })
                .find(c2 => c2 && c2.subject === x.issuer && c2.serialNumber !== x.serialNumber);
            r.chainIncluded = !!(issuerCert && x.verify(issuerCert.publicKey));
        } else {
            r.warnings.push('V podpisu chybí certifikát podepisujícího.');
        }
        const ts = v.si.unsigned[OID.timeStampToken];
        r.timestamp = ts ? verifyTimestampToken(ts, v.si.signature) : { present: false };
        if (!r.timestamp.present) r.warnings.push('Bez časového razítka — čas podpisu je jen z hodin počítače podepisujícího a po vypršení certifikátu nepůjde podpis ověřit.');
        else if (!r.timestamp.valid) r.warnings.push('Časové razítko je neplatné.');
        r.valid = !!(r.integrity && r.signatureValid);
        r.level = !r.valid ? 'neplatný'
            : r.qualifiedDevice ? 'kvalifikovaný (QES) — dle údajů v certifikátu'
            : r.qualifiedCertificate ? 'uznávaný (zaručený s kvalifikovaným certifikátem)'
            : 'zaručený (AdES)';
        return r;
    });
    const valid = results.filter(x => x.valid).length;
    return {
        signed: results.length > 0,
        signatures: results,
        summary: !results.length ? 'Dokument není elektronicky podepsán.'
            : `${results.length}× podpis, platných ${valid}. Důvěryhodnost vystavitele (EU Trusted List) ověřte v Acrobat Readeru.`
    };
}

// ── Klient TSA (RFC 3161) ───────────────────────────────────────────────────
function buildTimeStampReq(hash, nonce) {
    const A = asn1, C = A.Class.UNIVERSAL, T = A.Type;
    return derOf(A.create(C, T.SEQUENCE, true, [
        A.create(C, T.INTEGER, false, A.integerToDer(1).getBytes()),
        A.create(C, T.SEQUENCE, true, [
            A.create(C, T.SEQUENCE, true, [A.create(C, T.OID, false, A.oidToDer(OID.sha256).getBytes()), A.create(C, T.NULL, false, '')]),
            A.create(C, T.OCTETSTRING, false, hash.toString('binary'))
        ]),
        A.create(C, T.INTEGER, false, nonce.toString('binary')),
        A.create(C, T.BOOLEAN, false, String.fromCharCode(0xff))
    ]));
}

async function requestTimestamp(hash, { tsaUrl, fetch: f, timeoutMs } = {}) {
    if (!tsaUrl) throw new Error('Není nastavena adresa časového razítka (TSA).');
    let u;
    try { u = new URL(tsaUrl); } catch (e) { throw new Error('Neplatná adresa časového razítka (TSA).'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Adresa časového razítka musí začínat http:// nebo https://.');
    const headers = { 'Content-Type': 'application/timestamp-query', 'Accept': 'application/timestamp-reply' };
    if (u.username) {
        headers.Authorization = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64');
        u.username = ''; u.password = '';
    }
    const nonce = crypto.randomBytes(8); nonce[0] &= 0x7f; // kladné INTEGER
    const doFetch = f || fetch;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs || 20000);
    let res;
    try { res = await doFetch(u.toString(), { method: 'POST', headers, body: buildTimeStampReq(hash, nonce), signal: ac.signal }); }
    catch (e) { throw new Error('Služba časového razítka neodpovídá: ' + e.message); }
    finally { clearTimeout(t); }
    if (!res.ok) throw new Error(`Služba časového razítka odmítla požadavek (HTTP ${res.status}).`);
    const body = Buffer.from(await res.arrayBuffer());
    const resp = asn1.fromDer(bin(body), { strict: false });
    const status = parseInt(Buffer.from(resp.value[0].value[0].value, 'binary').toString('hex') || '0', 16);
    if (status > 1 || !resp.value[1]) throw new Error(`Služba časového razítka vrátila chybu (status ${status}).`);
    const token = resp.value[1];
    // kontrola: razítko je opravdu na náš otisk a nonce
    const v = parseCms(derOf(token));
    const tst = parseTstInfo(v.eContent);
    if (!tst.imprint.equals(hash)) throw new Error('Časové razítko nesouhlasí s podpisem.');
    if (tst.nonce) {
        const got = BigInt('0x' + (Buffer.from(tst.nonce.value, 'binary').toString('hex') || '0'));
        if (got !== BigInt('0x' + nonce.toString('hex'))) throw new Error('Časové razítko má jiný nonce (možná podvržená odpověď).');
    }
    return { token, genTime: tst.genTime };
}

/** Doplní časové razítko do CMS podpisu (unsigned attribute signature-time-stamp). */
async function timestampCms(cmsDer, opts = {}) {
    const cms = parseCms(cmsDer);
    const siNode = cms.signerInfos.value[0];
    const si = parseSignerInfo(siNode);
    const hash = crypto.createHash('sha256').update(si.signature).digest();
    const { token, genTime } = await requestTimestamp(hash, opts);
    const A = asn1, C = A.Class.UNIVERSAL, T = A.Type;
    const attr = A.create(C, T.SEQUENCE, true, [
        A.create(C, T.OID, false, A.oidToDer(OID.timeStampToken).getBytes()),
        A.create(C, T.SET, true, [token])
    ]);
    const last = siNode.value[siNode.value.length - 1];
    if (isCtx(last, 1)) last.value.push(attr);
    else siNode.value.push(A.create(A.Class.CONTEXT_SPECIFIC, 1, true, [attr]));
    return { cms: derOf(cms.ci), genTime };
}

module.exports = { verifyPdfSignatures, findPdfSignatures, verifyCms, timestampCms, requestTimestamp, buildTimeStampReq, OID };
