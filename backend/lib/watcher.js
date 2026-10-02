/**
 * LexisLocal File Watcher
 * Watches local directories (e.g. downloads, case folders) for new PDF and text documents,
 * parses them, extracts deadlines, and indexes them in the local RAG database.
 */

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const { checkSubject } = require('./registries');
const { indexDocument, deleteDocumentIndex } = require('./rag');
const { extractTextFromFile, IMAGE_EXTENSIONS } = require('./ocr');
const { extractLexisSpecFromDocx } = require('./lexis-spec');
const { logEvent } = require('./audit');
const Mutex = require('./mutex');
const { anonymizeText } = require('./anonymizer');
const { calculateDeadlineDate, collectUnitDeadlines, runAIExtractor, extractDeliveryDates, pickProceduralDeadline } = require('./extraction'); // sdílený AI-extraktor

const { WATCH_DIR, dataPath } = require('./config'); // jeden zdroj pravdy, viz lib/config.js
const { getIngestDir } = require('./config');
let _watchedDir = getIngestDir(); // aktuálně sledovaná spisovna (může se za běhu přepnout)
const INBOX_PATH = dataPath('.inbox.json'); // index příchozích — technická data v DATA_DIR

if (!fs.existsSync(WATCH_DIR)) {
    fs.mkdirSync(WATCH_DIR, { recursive: true });
    console.log(`📁 Vytvořen sledovaný adresář: ${WATCH_DIR}`);
}

// Legacy .inbox.json initialization removed (storing in database instead)

console.log(`👀 Spouštím sledování složky: ${WATCH_DIR}`);

let isWatcherActive = true;

function setWatcherState(active) {
    isWatcherActive = active;
    console.log(`👀 Stav sledování spisy složky změněn na: ${isWatcherActive ? 'AKTIVNÍ' : 'POZASTAVENO'}`);
}

// persistent:false pod testy (JEST_WORKER_ID) — watcher pak nedrží event loop
// a jest může korektně skončit; v produkci zůstává persistent:true.
const watcher = chokidar.watch(WATCH_DIR, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: typeof process.env.JEST_WORKER_ID === 'undefined'
});

watcher.on('add', async (filePath) => {
    if (!isWatcherActive) {
        console.log(`👀 Sledování spisy je dočasně pozastaveno, přeskakuji: ${path.basename(filePath)}`);
        return;
    }
    // Skip the inbox config itself
    if (path.basename(filePath) === '.inbox.json') return;
    
    const ext = path.extname(filePath).toLowerCase();
    const supportedExts = ['.pdf', '.txt', '.html', '.docx', ...IMAGE_EXTENSIONS];
    if (supportedExts.includes(ext)) {
        console.log(`📥 Detekován nový dokument: ${path.basename(filePath)}`);
        
        // Compute relative path to WATCH_DIR
        const relativePath = path.relative(_watchedDir, filePath);
        
        // Skip if already parsed and present in .inbox.json (checks both relativePath and basename for backward compatibility)
        const inbox = await loadInbox();
        if (inbox.files[relativePath] || inbox.files[path.basename(filePath)]) {
            console.log(`ℹ️ Soubor ${relativePath} již byl v minulosti zpracován.`);
            return;
        }
        
        try {
            await processDocument(filePath);
        } catch (err) {
            console.error(`❌ Chyba zpracování souboru ${path.basename(filePath)}:`, err.message);
        }
    }
});

const inboxMutex = new Mutex();

// Load inbox data helper from encrypted database
async function loadInbox() {
    await inboxMutex.acquire();
    try {
        // One-time migration: if old unencrypted .inbox.json exists, migrate it
        if (fs.existsSync(INBOX_PATH)) {
            try {
                console.log("🔑 Migruji nešifrovaný .inbox.json do šifrované databáze...");
                const rawData = await fs.promises.readFile(INBOX_PATH, 'utf-8');
                const oldInbox = JSON.parse(rawData);
                
                const list = Object.entries(oldInbox.files || {}).map(([key, value]) => {
                    return {
                        id: key,
                        ...value
                    };
                });
                db.set('inbox_files', list);
                
                // Securely remove the unencrypted file from disk
                await fs.promises.unlink(INBOX_PATH);
                console.log("✅ Migrace dokončena. Starý soubor .inbox.json byl bezpečně smazán.");
            } catch (migErr) {
                console.error("❌ Selhala migrace nešifrovaného .inbox.json:", migErr.message);
            }
        }
        
        const list = db.get('inbox_files') || [];
        const files = {};
        list.forEach(item => {
            files[item.id] = item;
        });
        // Alerty (insolvence) mají vlastní kolekci — jinak by se zahazovaly a
        // stejný úpadek by se hlásil při každém běhu znovu.
        const alerts = db.get('inbox_alerts') || [];
        return { files, alerts };
    } catch (e) {
        console.error("⚠️ Nepodařilo se načíst inbox z databáze:", e.message);
    } finally {
        inboxMutex.release();
    }
    return { files: {}, alerts: [] };
}

// Save inbox data helper to encrypted database
async function saveInbox(inbox) {
    await inboxMutex.acquire();
    try {
        const list = Object.entries(inbox.files || {}).map(([key, value]) => {
            return {
                id: key,
                ...value
            };
        });
        db.set('inbox_files', list);
        // Perzistovat i alerty (pokud je volající předal), jinak by se ztratily.
        if (inbox.alerts !== undefined) {
            db.set('inbox_alerts', inbox.alerts || []);
        }
    } catch (e) {
        console.error("⚠️ Nepodařilo se uložit inbox do databáze:", e.message);
    } finally {
        inboxMutex.release();
    }
}

// Combined Heuristic and AI extraction engine
async function processDocument(filePath) {
    const fileName = path.basename(filePath);
    console.log(`⚙️ Analyzuji dokument ${fileName}...`);

    // .docx ulozeny LexisEditorem nese vnoreny spec (JSON) - precteme ho, aby sel
    // v editoru otevrit BEZ ZTRATY struktury (nadpisy, tabulky, hlavicka, vodoznak).
    // Cizi Word soubory spec nemaji -> lexisSpec zustane null a jede bezna analyza.
    let lexisSpec = null;
    try { lexisSpec = await extractLexisSpecFromDocx(filePath); }
    catch (e) { lexisSpec = null; }
    
    let text = "";
    let wasOcr = false;
    
    // === Inteligentní extrakce textu (digitální PDF / naskenované PDF / obrázek / TXT) ===
    try {
        const result = await extractTextFromFile(filePath);
        text = result.text || '';
        wasOcr = result.ocr || false;
        
        if (wasOcr) {
            console.log(`🔍 OCR: Soubor ${fileName} byl zpracován přes OCR engine.`);
        }
    } catch (extractErr) {
        console.error(`❌ Chyba extrakce textu z ${fileName}:`, extractErr.message);
    }
    
    if (text && text.trim()) {
        try { require('./text_cache').setText(filePath, text); } catch (e) { /* cache je jen optimalizace */ }
    }
    if (!text || !text.trim()) {
        console.warn(`⚠️ Soubor ${fileName} je prázdný nebo nelze přečíst.`);
        // Volající (upload) musí vědět, že dokument NEBYL zpracován — dřív API hlásilo
        // úspěch a dokument se v doručené poště vůbec neobjevil (test 2. 10. 2026).
        return { ok: false, reason: 'z dokumentu nejde přečíst text (prázdný či poškozený soubor, nebo selhalo OCR)' };
    }
    
    // 1. Step: Run High-Quality Czech Heuristic Regex Engine (Bulletproof Fallback)
    const metadata = runRegexExtractor(text);
    
    // 2. Step: Refine metadata with Local Ollama AI if online
    let refinedMetadata = null;
    try {
        refinedMetadata = await runAIExtractor(text);
        if (refinedMetadata) {
            if (refinedMetadata.caseNumber) metadata.caseNumber = refinedMetadata.caseNumber;
            if (refinedMetadata.plaintiff) metadata.plaintiff = refinedMetadata.plaintiff;
            if (refinedMetadata.defendant) metadata.defendant = refinedMetadata.defendant;
            // Procesní lhůta nalezená v textu (odvolání/odpor/vyjádření) má přednost
            // před číslem od AI — to si u rozsudku vybralo 3denní pariční lhůtu.
            if (refinedMetadata.deadlineDays !== undefined && !metadata.deadlineProcedural) {
                metadata.deadlineDays = refinedMetadata.deadlineDays;
                metadata.deadlineDate = refinedMetadata.deadlineDays
                    ? calculateDeadlineDate(refinedMetadata.deadlineDays, metadata.deliveryDate || undefined) : null;
            }
            if (refinedMetadata.summary) metadata.summary = refinedMetadata.summary;
        }
    } catch (err) {
        console.log(`ℹ️ Ollama AI extraktor je nedostupný (${err.message}). Používám přesná heuristická data.`);
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
            console.warn("⚠️ Chyba při automatickém ověření registrů v watcher:", e.message);
        }
    }
    
    // 2.7 Step: Lhůty v MĚSÍCÍCH/TÝDNECH/LETECH (§ 57/2) z deterministické detekce
    // I z AI-extraktoru (collectUnitDeadlines je sjednotí a dedupuje). Vše s
    // needsReview=true — advokát je má potvrdit (nic se tiše nefinalizuje).
    let unitDeadlines = [];
    try {
        unitDeadlines = collectUnitDeadlines(text, refinedMetadata);
    } catch (e) { /* detekce jednotek je best-effort */ }
    if (unitDeadlines.length) {
        const lbl = { week: 'týd.', month: 'měs.', year: 'r.' };
        metadata.summary = (metadata.summary || '') + ' ⏳ K OVĚŘENÍ: ' +
            unitDeadlines.map(d => `${d.amount} ${lbl[d.unit] || d.unit} → ${d.deadlineDate}`).join(', ') + '.';
    }

    // 2.8 Step: Nařízené jednání v dokumentu (předvolání, vyrozumění) → návrh ke sledování.
    //     Hlídač pak termín ověřuje na InfoJednání; advokát ho musí potvrdit.
    let hearingsFound = [];
    try {
        const { extractHearings } = require('./hearing_extract');
        const { detectCourtName } = require('./court_hearings_source');
        metadata.court = detectCourtName(text);
        hearingsFound = extractHearings(text);
        const HW = require('./hearings');
        let spis = null;
        try { spis = require('./spisy').findByCase(metadata.caseNumber); } catch (e) { /* bez spisu */ }
        hearingsFound.forEach(hf => {
            if (!hf.spisZn && metadata.caseNumber) hf.spisZn = metadata.caseNumber;
            if (!hf.spisZn) return;
            const reg = HW.registerHearing(WATCH_DIR, { // stejný soubor jako kalendář (routes/calendar.js)
                spisZn: hf.spisZn, date: hf.date, time: hf.time, room: hf.room,
                court: hf.court || metadata.court, spisId: spis ? spis.id : null,
                advokat: spis ? spis.odpovednyAdvokat || null : null,
                source: 'dokument:' + fileName, needsReview: true
            });
            hf.hearingId = reg.hearing.id;
        });
        if (hearingsFound.length) {
            metadata.summary = (metadata.summary || '') + ' ⚖️ JEDNÁNÍ K POTVRZENÍ: ' +
                hearingsFound.map(h => `${h.date} ${h.time}${h.room ? ', síň ' + h.room : ''}`.trim()).join('; ') + '.';
        }
    } catch (e) { console.warn('⚠️ Rozpoznání jednání selhalo (nekritické):', e.message); }

    // 2.9 Step: Elektronické podpisy v PDF (rozhodnutí soudu, podání, smlouvy) — jen ověření.
    let signatures = null;
    try { signatures = require('./signature_check').checkPdfFile(filePath); }
    catch (e) { signatures = null; }
    const signatureNote = signatures ? require('./signature_check').summaryNote(signatures) : '';

    // 3. Save to inbox
    const inbox = await loadInbox();
    const relativePath = path.relative(_watchedDir, filePath);
    inbox.files[relativePath] = {
        fileName: fileName,
        filePath: filePath,
        relativePath: relativePath,
        status: "unread",
        caseNumber: metadata.caseNumber || "Neznámá sp. zn.",
        plaintiff: metadata.plaintiff || "Nezjištěn",
        defendant: metadata.defendant || "Nezjištěn",
        deadlineDays: metadata.deadlineDays || 0,
        deadlineDate: metadata.deadlineDate || null,
        deadlineBase: metadata.deadlineBase || null,
        deadlineContext: metadata.deadlineContext || null,
        court: metadata.court || null,
        hearings: hearingsFound,
        deliveryDate: metadata.deliveryDate || null,
        deliveryConflict: !!metadata.deliveryConflict,
        detectedDeadlines: unitDeadlines,
        summary: (metadata.deliveryConflict
            ? `⚠️ ROZPOR V DATU DORUČENÍ (${(metadata.deliveryDates || []).join(' × ')}) — lhůta počítána od nejdřívějšího, OVĚŘIT. `
            : '') + signatureNote + (metadata.summary || "Nově stažený dokument připravený ke zpracování."),
        ico: metadata.ico || null,
        inInsolvency: registryData ? registryData.inInsolvency : false,
        insolvencyCase: registryData ? registryData.insolvencyCase : null,
        verifiedSeat: registryData && registryData.aresOk !== false ? registryData.seat || null : null,
        wasOcr: wasOcr,
        signatures: signatures,
        hasLexisSpec: !!lexisSpec,
        lexisSpec: lexisSpec || null,
        processedAt: new Date().toISOString()
    };
    await saveInbox(inbox);
    // Automatické roztřídění do spisu podle sp. zn. (spisová služba). Best-effort —
    // selhání nesmí shodit zpracování dokumentu.
    try {
        require('./spisy').ensureSpisForCase(metadata.caseNumber, {
            klient: metadata.plaintiff, protistrana: metadata.defendant, ico: metadata.ico, source: 'watcher'
        });
    } catch (e) { console.warn('⚠️ Spis auto-sort (watcher) selhal:', e.message); }
    console.log(`✅ Dokument ${fileName} (${relativePath}) byl úspěšně analyzován a uložen do lokálního indexu.`);
    
    logEvent('FileWatcher', wasOcr ? 'Zpracování OCR' : 'Zpracování dokumentu', fileName, {
        caseNumber: metadata.caseNumber || 'Nezjištěna',
        deadlineDays: metadata.deadlineDays || 0,
        charactersCount: text.length
    });
    
    // Automatically trigger insolvency check in background to ensure alerts are up-to-date
    checkAllInsolvencies().catch(err => console.error("⚠️ Background ISIR verification error:", err.message));
    
    // Trigger local RAG vector indexing in background
    try {
        const anonymizedText = anonymizeText(text);
        await indexDocument(relativePath, anonymizedText);
    } catch (e) {
        console.error(`❌ RAG: Selhala vektorová indexace pro soubor ${relativePath}:`, e.message);
    }
}

// Regular Expression extractor for Czech legal documents
function runRegexExtractor(text) {
    const metadata = {
        caseNumber: "",
        plaintiff: "",
        defendant: "",
        deadlineDays: 0,
        deadlineDate: null,
        summary: "",
        ico: ""
    };
    
    // 1. Spisová značka: e.g. 23 C 120/2026, 15 Co 45/2025, 4 T 12/2024
    const caseReg = /(?:sp\s*zn\.?|č\s*j\.?|spisová\s*značka)\s*[:\-]?\s*(\d+\s*[A-Za-zČŠŽčšž]+\s*\d+\/\d+)/i;
    const matchCase = text.match(caseReg);
    if (matchCase) {
        metadata.caseNumber = matchCase[1].replace(/\s+/g, ' ').trim();
    } else {
        // Fallback broad regex for case numbers
        const broadCaseReg = /(\d+\s*[A-Za-zČŠŽčšž]+\s*\d+\/\d+)/;
        const matchBroad = text.match(broadCaseReg);
        if (matchBroad) {
            metadata.caseNumber = matchBroad[1].replace(/\s+/g, ' ').trim();
        }
    }
    
    // 2. Lhůta v dnech: e.g. "lhůta 15 dnů", "do 15 dnů", "ve lhůtě 8 dnů"
    const deadlineReg = /(?:lhůt[aěuouí-]+\s*(?:k\s*vyjádření\s*)?(?:činí|v\s*délce)?\s*|do\s*|ve\s*lhůtě\s*)(\d+)\s*(?:dn[ůía-z]*)/i;
    const matchDeadline = text.match(deadlineReg);
    // Lhůta běží od DORUČENÍ, ne ode dne zpracování spisu.
    const delivery = extractDeliveryDates(text);
    metadata.deliveryDate = delivery.date;
    metadata.deliveryDates = delivery.all;
    metadata.deliveryConflict = delivery.conflict;
    const proc = pickProceduralDeadline(text);
    if (proc) {
        metadata.deadlineDays = proc.days;
        metadata.deadlineDate = calculateDeadlineDate(proc.days, delivery.date || undefined);
        metadata.deadlineBase = delivery.date ? 'doručení' : 'zpracování (datum doručení nenalezeno — OVĚŘIT)';
        metadata.deadlineProcedural = true;
        metadata.deadlineContext = proc.context;
    } else if (matchDeadline && !/pr[aá]vn[ií]\s+moc/i.test(text.substr(matchDeadline.index, 80))) {
        const days = parseInt(matchDeadline[1]);
        metadata.deadlineDays = days;
        metadata.deadlineDate = calculateDeadlineDate(days, delivery.date || undefined);
        metadata.deadlineBase = delivery.date ? 'doručení' : 'zpracování (datum doručení nenalezeno — OVĚŘIT)';
    }
    
    // 3. Strany sporu
    const plaintiffReg = /(?:žalobc[eůa-z]+\s*:\s*|žalující\s*strana\s*:\s*)([^\n,.]+)/i;
    const matchPlaintiff = text.match(plaintiffReg);
    if (matchPlaintiff) metadata.plaintiff = matchPlaintiff[1].trim();
    
    const defendantReg = /(?:žalovan[éhomy-]+\s*:\s*|žalovaná\s*strana\s*:\s*)([^\n,.]+)/i;
    const matchDefendant = text.match(defendantReg);
    if (matchDefendant) metadata.defendant = matchDefendant[1].trim();
    
    // 4. IČO Search (Exactly 8 digits, supports spaces inside like '123 456 78')
    const icoReg = /(?:IČO|IČ)\s*[:\-]?\s*(\d(?:\s*\d){7})/i;
    const matchIco = text.match(icoReg);
    if (matchIco) {
        metadata.ico = matchIco[1].replace(/\s+/g, '').trim();
    }
    
    // Summary mock based on extracted items
    metadata.summary = `Byl detekován spis ${metadata.caseNumber || 'bez sp. zn.'}.`;
    if (metadata.deadlineDays > 0) {
        metadata.summary += ` Byla nalezena lhůta ${metadata.deadlineDays} dnů (vyprší ${metadata.deadlineDate}).`;
    }
    
    return metadata;
}


// Hlídač insolvencí (ISIR Watcher) - Runs active insolvency check on all monitored IČOs
async function checkAllInsolvencies() {
    console.log("🚨 Hlídač insolvencí: Spouštím periodickou kontrolu sledovaných subjektů...");
    const inbox = await loadInbox();
    if (!inbox.files) return { checkedCount: 0, newAlertsCount: 0 };
    if (!inbox.alerts) inbox.alerts = [];
    
    const files = Object.values(inbox.files);
    let checkedCount = 0;
    let newAlertsCount = 0;
    
    // Concurrently verify unique IČOs
    const uniqueIcos = [...new Set(files.map(f => f.ico).filter(Boolean))];
    
    for (const ico of uniqueIcos) {
        checkedCount++;
        try {
            const result = await checkSubject(ico);
            if (result && !result.error) {
                // If insolvency is found
                if (result.inInsolvency) {
                    // Check if an active alert already exists for this ICO
                    const alreadyAlerted = inbox.alerts.some(a => a.ico === ico && a.status === 'active');
                    
                    if (!alreadyAlerted) {
                        // Find files corresponding to this ICO to cite as context
                        const citedFiles = files.filter(f => f.ico === ico).map(f => f.fileName);
                        
                        const newAlert = {
                            id: 'alert_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                            ico: ico,
                            name: result.name,
                            caseNumber: result.insolvencyCase,
                            insolvencyStatus: result.insolvencyStatus,
                            citedFiles: citedFiles,
                            detectedAt: new Date().toISOString(),
                            status: 'active'
                        };
                        
                        inbox.alerts.push(newAlert);
                        newAlertsCount++;
                        console.log(`🚨 Hlídač insolvencí: DETEKOVÁN ÚPADEK u subjektu ${result.name} (IČO: ${ico})! Spis: ${result.insolvencyCase}`);
                    }
                    
                    // Update insolvency status in all matching files in the inbox
                    for (const fileName in inbox.files) {
                        if (inbox.files[fileName].ico === ico) {
                            inbox.files[fileName].inInsolvency = true;
                            inbox.files[fileName].insolvencyCase = result.insolvencyCase;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`⚠️ Hlídač insolvencí: Selhala kontrola IČO ${ico}:`, e.message);
        }
    }
    
    if (newAlertsCount > 0) {
        await saveInbox(inbox);
    }
    
    return { checkedCount, newAlertsCount };
}

// Přepnutí sledované spisovny ZA BĚHU (bez restartu). chokidar odhlásí starou
// složku a přidá novou; relativní cesty se pak počítají vůči nové spisovně.
function repointWatcher(newDir) {
    if (!newDir || newDir === _watchedDir) return _watchedDir;
    try { watcher.unwatch(_watchedDir); } catch (e) { /* best-effort */ }
    try { if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true }); } catch (e) { /* best-effort */ }
    try { watcher.add(newDir); } catch (e) { /* best-effort */ }
    _watchedDir = newDir;
    console.log('👀 Spisovna přepnuta na: ' + newDir);
    return _watchedDir;
}

module.exports = { WATCH_DIR, loadInbox, saveInbox, processDocument, setWatcherState, checkAllInsolvencies, repointWatcher };
