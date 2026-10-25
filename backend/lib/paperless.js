/**
 * LexisLocal Paperless-ngx Integration Module
 * Handles incoming webhooks from Paperless-ngx and manages two-way metadata synchronization.
 */

const { indexDocument } = require('./rag');
const { checkSubject } = require('./registries');
const { loadInbox, saveInbox } = require('./watcher');
const { logEvent } = require('./audit');
const { anonymizeText } = require('./anonymizer');
const { calculateDeadlineDate, collectUnitDeadlines, runAIExtractor } = require('./extraction'); // sdílený AI-extraktor

const PAPERLESS_API_URL = process.env.PAPERLESS_API_URL || 'http://localhost:8000';
const PAPERLESS_API_TOKEN = process.env.PAPERLESS_API_TOKEN || '';

// Cache for Paperless custom field IDs
let customFieldIdsCache = null;

/**
 * Main Webhook Handler
 */
async function handlePaperlessWebhook(payload) {
    const { document_id, title, content, tags } = payload;

    if (!document_id || !title) {
        throw new Error("Neplatný webhook payload: chybí document_id nebo title.");
    }

    // document_id z Paperlessu je vždy číselné — vynutíme to (obrana proti
    // path traversal / injekci přes odvozený název souboru).
    const safeDocId = String(document_id).replace(/\D/g, '');
    if (!safeDocId) {
        throw new Error("Neplatný webhook payload: document_id musí být číselné.");
    }

    const docText = content || '';
    const cleanTags = Array.isArray(tags) ? tags : [];
    
    console.log(`🔌 Paperless: Přijat webhook pro dokument [ID: ${document_id}, Název: ${title}]`);

    // 1. Step: Run Regex Extractor (Fallback)
    const metadata = runRegexExtractor(title, cleanTags, docText);

    // 2. Step: Run AI Extractor if text is non-empty
    let refined = null;
    if (docText.trim().length > 50) {
        try {
            refined = await runAIExtractor(docText);
            if (refined) {
                if (refined.caseNumber) metadata.caseNumber = refined.caseNumber;
                if (refined.plaintiff) metadata.plaintiff = refined.plaintiff;
                if (refined.defendant) metadata.defendant = refined.defendant;
                if (refined.deadlineDays !== undefined && refined.deadlineDays > 0) {
                    metadata.deadlineDays = refined.deadlineDays;
                    metadata.deadlineDate = calculateDeadlineDate(refined.deadlineDays);
                }
                if (refined.summary) metadata.summary = refined.summary;
            }
        } catch (err) {
            console.log(`ℹ️ Paperless: Ollama AI extraktor je nedostupný (${err.message}). Používám regex data.`);
        }
    }

    // 2.5 Step: Run ARES & ISIR check if IČO was extracted
    let registryData = null;
    if (metadata.ico) {
        try {
            registryData = await checkSubject(metadata.ico);
            if (registryData && !registryData.error) {
                if (registryData.inInsolvency) {
                    metadata.summary = `⚠️ POZOR: Subjekt ${registryData.name} je v INSOLVENCI (${registryData.insolvencyCase})! ` + metadata.summary;
                }
                // IČO/sídlo z ARES jen k té straně, které subjekt odpovídá (nikdy chybový text).
                Object.assign(metadata, require('./registries').enrichPartiesWithRegistry(metadata, registryData));
            }
        } catch (e) {
            console.warn("⚠️ Paperless: Chyba při automatickém ověření registrů:", e.message);
        }
    }

    // 2.7 Step: Lhůty v MĚSÍCÍCH/TÝDNECH/LETECH (§ 57/2) z deterministické detekce
    // i AI-extraktoru (collectUnitDeadlines je sjednotí a dedupuje) —
    // ukládají se s needsReview=true (advokát potvrzuje; nic se tiše nefinalizuje).
    let unitDeadlines = [];
    try {
        unitDeadlines = collectUnitDeadlines(docText, refined);
    } catch (e) { /* best-effort */ }
    if (unitDeadlines.length) {
        const lbl = { week: 'týd.', month: 'měs.', year: 'r.' };
        metadata.summary = (metadata.summary || '') + ' ⏳ K OVĚŘENÍ: ' +
            unitDeadlines.map(d => `${d.amount} ${lbl[d.unit] || d.unit} → ${d.deadlineDate}`).join(', ') + '.';
    }

    // 3. Save to LexisLocal Inbox
    const inbox = await loadInbox();
    const fileName = `paperless_${safeDocId}_${title.replace(/[^a-zA-Z0-9-_.]/g, '_')}`;

    inbox.files[fileName] = {
        fileName: title,
        filePath: `paperless://${safeDocId}`,
        status: "unread",
        caseNumber: metadata.caseNumber || "Neznámá sp. zn.",
        plaintiff: metadata.plaintiff || "Nezjištěn",
        defendant: metadata.defendant || "Nezjištěn",
        deadlineDays: metadata.deadlineDays || 0,
        deadlineDate: metadata.deadlineDate || null,
        detectedDeadlines: unitDeadlines,
        summary: metadata.summary || `Importováno z Paperless-ngx (ID: ${safeDocId}).`,
        ico: metadata.ico || null,
        inInsolvency: registryData ? registryData.inInsolvency : false,
        insolvencyCase: registryData ? registryData.insolvencyCase : null,
        verifiedSeat: registryData && registryData.aresOk !== false ? registryData.seat || null : null,
        wasOcr: true,
        processedAt: new Date().toISOString()
    };
    await saveInbox(inbox);
    // Automatické roztřídění do spisu podle sp. zn. (spisová služba). Best-effort.
    try {
        require('./spisy').ensureSpisForCase(metadata.caseNumber, {
            klient: metadata.plaintiff, protistrana: metadata.defendant, ico: metadata.ico, source: 'paperless'
        });
    } catch (e) { console.warn('⚠️ Spis auto-sort (paperless) selhal:', e.message); }
    console.log(`✅ Paperless: Dokument ${title} byl zapsán do lokálního inboxu.`);

    logEvent('PaperlessWebhook', 'Zpracování dokumentu', title, {
        documentId: safeDocId,
        caseNumber: metadata.caseNumber || 'Nezjištěna',
        deadlineDays: metadata.deadlineDays || 0
    });

    // 4. Index to RAG Vector Database
    // PII (jména, RČ, adresy) se před indexací anonymizuje — stejně jako u watcheru,
    // aby se osobní údaje nedostaly do vektorového indexu.
    if (docText.trim().length > 0) {
        try {
            await indexDocument(title, anonymizeText(docText));
        } catch (e) {
            console.error(`❌ Paperless RAG: Selhala vektorová indexace pro dokument ${title}:`, e.message);
        }
    }

    // 5. Write back Custom Fields to Paperless API
    if (PAPERLESS_API_TOKEN) {
        try {
            await writebackMetadataToPaperless(safeDocId, metadata, registryData);
        } catch (err) {
            console.error(`❌ Paperless Writeback: Selhal zpětný zápis metadat:`, err.message);
        }
    }

    return inbox.files[fileName];
}

/**
 * Regular Expression Extractor
 */
function runRegexExtractor(title, tags, text) {
    const metadata = {
        caseNumber: "",
        plaintiff: "",
        defendant: "",
        deadlineDays: 0,
        deadlineDate: null,
        summary: "",
        ico: ""
    };

    // Try finding case number in tags first (e.g. "23 C 120/2026")
    const caseTag = tags.find(t => /\d+\s*[A-Za-zČŠŽčšž]+\s*\d+\/\d+/.test(t));
    if (caseTag) {
        metadata.caseNumber = caseTag.trim();
    } else {
        // Fallback case number regex
        const caseReg = /(?:sp\s*zn\.?|č\s*j\.?|spisová\s*značka)\s*[:\-]?\s*(\d+\s*[A-Za-zČŠŽčšž]+\s*\d+\/\d+)/i;
        const matchCase = text.match(caseReg) || title.match(caseReg);
        if (matchCase) {
            metadata.caseNumber = matchCase[1].replace(/\s+/g, ' ').trim();
        } else {
            const broadCaseReg = /(\d+\s*[A-Za-zČŠŽčšž]+\s*\d+\/\d+)/;
            const matchBroad = text.match(broadCaseReg) || title.match(broadCaseReg);
            if (matchBroad) {
                metadata.caseNumber = matchBroad[1].replace(/\s+/g, ' ').trim();
            }
        }
    }

    // Lhůta v dnech
    const deadlineReg = /(?:lhůt[aěuouí-]+\s*(?:k\s*vyjádření\s*)?(?:činí|v\s*délce)?\s*|do\s*|ve\s*lhůtě\s*)(\d+)\s*(?:dn[ůía-z]*)/i;
    const matchDeadline = text.match(deadlineReg);
    if (matchDeadline) {
        const days = parseInt(matchDeadline[1]);
        metadata.deadlineDays = days;
        metadata.deadlineDate = calculateDeadlineDate(days);
    }

    // Strany
    const plaintiffReg = /(?:žalobc[eůa-z]+\s*:\s*|žalující\s*strana\s*:\s*)([^\n,.]+)/i;
    const matchPlaintiff = text.match(plaintiffReg);
    if (matchPlaintiff) metadata.plaintiff = matchPlaintiff[1].trim();

    const defendantReg = /(?:žalovan[éhomy-]+\s*:\s*|žalovaná\s*strana\s*:\s*)([^\n,.]+)/i;
    const matchDefendant = text.match(defendantReg);
    if (matchDefendant) metadata.defendant = matchDefendant[1].trim();

    // IČO
    const icoReg = /(?:IČO|IČ)\s*[:\-]?\s*(\d(?:\s*\d){7})/i;
    const matchIco = text.match(icoReg);
    if (matchIco) {
        metadata.ico = matchIco[1].replace(/\s+/g, '').trim();
    }

    metadata.summary = `Dokument importovaný z Paperless-ngx.`;
    return metadata;
}


/**
 * Connect to Paperless REST API to fetch or create custom field definitions,
 * then update document metadata.
 */
async function writebackMetadataToPaperless(documentId, metadata, registryData) {
    console.log(`🔌 Paperless Writeback: Zahajuji zápis metadat pro ID ${documentId}...`);
    
    const fieldsToMap = [
        { name: "Spisová značka", type: "string", key: "caseNumber", val: metadata.caseNumber },
        { name: "Žalobce", type: "string", key: "plaintiff", val: metadata.plaintiff },
        { name: "Žalovaný", type: "string", key: "defendant", val: metadata.defendant },
        { name: "IČO", type: "string", key: "ico", val: metadata.ico },
        { name: "Lhůta do", type: "date", key: "deadlineDate", val: metadata.deadlineDate },
        { name: "Insolvence", type: "boolean", key: "inInsolvency", val: registryData ? registryData.inInsolvency : false }
    ];

    try {
        const fieldIds = await getOrCreateCustomFieldIds();
        const customFieldsPayload = [];

        for (const item of fieldsToMap) {
            const fieldId = fieldIds[item.name];
            if (fieldId && item.val !== undefined && item.val !== null && item.val !== "") {
                customFieldsPayload.push({
                    field: fieldId,
                    value: item.val
                });
            }
        }

        if (customFieldsPayload.length === 0) {
            console.log(`🔌 Paperless Writeback: Žádná metadata k zapsání.`);
            return;
        }

        // PATCH the document
        const url = `${PAPERLESS_API_URL}/api/documents/${documentId}/`;
        const res = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Token ${PAPERLESS_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                custom_fields: customFieldsPayload
            })
        });

        if (res.status === 200) {
            console.log(`✅ Paperless Writeback: Metadata úspěšně zapsána do Custom Fields v Paperless.`);
        } else {
            const errText = await res.text();
            throw new Error(`Chyba PATCH ${res.status}: ${errText}`);
        }

    } catch (err) {
        console.error(`⚠️ Paperless Writeback: Selhal zápis metadat přes API:`, err.message);
    }
}

/**
 * Fetch Custom Fields, creating missing ones
 */
async function getOrCreateCustomFieldIds() {
    if (customFieldIdsCache) {
        return customFieldIdsCache;
    }

    console.log(`🔌 Paperless API: Načítám seznam Custom Fields...`);
    
    // 1. GET existing fields
    const getUrl = `${PAPERLESS_API_URL}/api/custom_fields/`;
    const getRes = await fetch(getUrl, {
        headers: { 'Authorization': `Token ${PAPERLESS_API_TOKEN}` }
    });

    if (getRes.status !== 200) {
        throw new Error(`Chyba GET custom_fields ${getRes.status}`);
    }

    const existingFields = await getRes.json();
    const fieldMap = {};
    
    // Results are typically in response.results or as an array
    const fieldsList = Array.isArray(existingFields) ? existingFields : (existingFields.results || []);
    fieldsList.forEach(f => {
        fieldMap[f.name] = f.id;
    });

    const fieldsToEnsure = [
        { name: "Spisová značka", data_type: "string" },
        { name: "Žalobce", data_type: "string" },
        { name: "Žalovaný", data_type: "string" },
        { name: "IČO", data_type: "string" },
        { name: "Lhůta do", data_type: "date" },
        { name: "Insolvence", data_type: "boolean" }
    ];

    for (const reqField of fieldsToEnsure) {
        if (!fieldMap[reqField.name]) {
            console.log(`🔌 Paperless API: Vytvářím chybějící Custom Field "${reqField.name}"...`);
            
            const postRes = await fetch(getUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${PAPERLESS_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: reqField.name,
                    data_type: reqField.data_type
                })
            });

            if (postRes.status === 201) {
                const created = await postRes.json();
                fieldMap[reqField.name] = created.id;
            } else {
                console.warn(`⚠️ Nelze vytvořit pole ${reqField.name}: status ${postRes.status}`);
            }
        }
    }

    customFieldIdsCache = fieldMap;
    return customFieldIdsCache;
}

module.exports = { handlePaperlessWebhook, runRegexExtractor };
