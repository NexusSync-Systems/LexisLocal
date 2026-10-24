/**
 * lib/ai_disclosure.js — označování výstupů AI (EU AI Act čl. 50, použitelný od 2. 8. 2026).
 *
 *  • čl. 50 odst. 1: kdo komunikuje s AI, musí to vědět (pokud to není zřejmé z okolností) —
 *    upozornění v chatu, `aiGenerated` v odpovědích API (pro LexisEditor a mobilní editor),
 *  • čl. 50 odst. 2: obsah vytvořený AI má být strojově čitelně označen — vlastní vlastnosti
 *    dokumentu v exportu .docx (docProps/custom.xml), viz docxCustomProps().
 * Texty jsou na jednom místě, aby UI, API, e-mail i export říkaly totéž.
 * Výklad čl. 50 není právní rada — znění upozornění má posoudit advokát.
 */
'use strict';

const GENERATOR = 'LexisLocal AI';
const TEXT_NOTICE = 'Tento výstup vytvořila umělá inteligence (LexisLocal). Může obsahovat chyby — před použitím ho zkontrolujte.';

/** Pole, která se přidávají do JSON odpovědí agentů. */
function forResponse() {
    return { aiGenerated: true, aiNotice: TEXT_NOTICE };
}

function _x(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * docProps/custom.xml s označením AI. `info` = { humanApproved, generatedAt? }.
 * Vlastnosti vidí Word (Soubor → Vlastnosti → Vlastní) i nástroje, které čtou metadata.
 */
function docxCustomProps(info = {}) {
    const props = [
        ['AIGenerated', 'bool', 'true'],
        ['AIGenerator', 'lpwstr', GENERATOR],
        ['AIHumanApproved', 'bool', info.humanApproved ? 'true' : 'false'],
        ['AIDisclosure', 'lpwstr', TEXT_NOTICE],
        ['AIDisclosureBasis', 'lpwstr', 'EU AI Act (nařízení (EU) 2024/1689), čl. 50'],
    ];
    if (info.generatedAt) props.push(['AIGeneratedAt', 'lpwstr', String(info.generatedAt)]);
    const body = props.map(([name, type, val], i) =>
        `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${_x(name)}"><vt:${type}>${_x(val)}</vt:${type}></property>`).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' + body + '</Properties>';
}

/** Vloží docProps/custom.xml do otevřeného JSZip balíku .docx (vč. content types a vazby). */
async function addDocxCustomProps(zip, info) {
    zip.file('docProps/custom.xml', docxCustomProps(info));
    const ctPath = '[Content_Types].xml';
    const ct = zip.file(ctPath);
    if (ct) {
        let s = await ct.async('string');
        if (!s.includes('/docProps/custom.xml')) {
            s = s.replace('</Types>', '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>');
            zip.file(ctPath, s);
        }
    }
    const relsPath = '_rels/.rels';
    const rels = zip.file(relsPath);
    if (rels) {
        let s = await rels.async('string');
        if (!s.includes('docProps/custom.xml')) {
            s = s.replace('</Relationships>', '<Relationship Id="rIdLexisAi" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>');
            zip.file(relsPath, s);
        }
    }
    return zip;
}

module.exports = { GENERATOR, TEXT_NOTICE, forResponse, docxCustomProps, addDocxCustomProps };
