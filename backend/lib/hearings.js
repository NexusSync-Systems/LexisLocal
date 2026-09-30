const path = require('path');
const fs = require('fs');
const { buildIcs, sanitizeFileName } = require('./ics'); // jeden generátor ICS + sanitizace názvu

const HEARINGS_FILE = (WATCH_DIR) => path.join(WATCH_DIR, '.hearings.json');

function loadMonitoredHearings(WATCH_DIR) {
    const file = HEARINGS_FILE(WATCH_DIR);
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (e) {
            console.error("⚠️ Nepodařilo se načíst .hearings.json:", e.message);
        }
    }
    return [];
}

function saveMonitoredHearings(WATCH_DIR, hearings) {
    try {
        fs.writeFileSync(HEARINGS_FILE(WATCH_DIR), JSON.stringify(hearings, null, 2), 'utf-8');
    } catch (e) {
        console.error("⚠️ Nepodařilo se uložit .hearings.json:", e.message);
    }
}


// Escapování textu do ICS dle RFC 5545 (zpětné lomítko, středník, čárka, nový řádek).
// Generate an ICS content helper — deleguje na sdílený lib/ics.js (jeden zdroj escapování).
function generateIcs(id, title, dateStr, timeStr, location, context, isCancelled) {
    return buildIcs({
        id: id || 'hearing_' + Date.now(),
        title: isCancelled ? `❌ ZRUŠENO: ${title}` : title,
        date: dateStr,
        time: timeStr,
        location,
        description: context,
        isCancelled
    });
}

async function checkAllHearings(WATCH_DIR) {
    const hearings = loadMonitoredHearings(WATCH_DIR);
    // Běží každou hodinu — bez sledovaných jednání nic nelogovat (jinak log zaplaví
    // stovky řádků „Spouštím kontrolu…“ a zanikne v nich to důležité).
    if (hearings.length === 0) return { checked: 0, updated: 0 };
    console.log(`🚨 Hlídač soudních jednání: kontroluji ${hearings.length} sledovaných jednání…`);
    
    let checked = 0;
    let updated = 0;
    let dirty = false; // změny (např. přechod na 'past'), které je třeba uložit i bez updated

    for (const h of hearings) {
        if (h.status === 'cancelled' || h.status === 'past') continue;

        checked++;
        try {
            const hearingDate = new Date(h.dueDate);
            const today = new Date();
            today.setHours(0,0,0,0);

            // Difference in days
            const diffTime = hearingDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays < -1) {
                // Hearing is in the past, stop monitoring — a ULOŽIT, jinak se
                // prošlá jednání dotazují donekonečna.
                if (h.status !== 'past') { h.status = 'past'; dirty = true; }
                continue;
            }
            
            if (diffDays > 30) {
                // Not in window yet
                continue;
            }
            
            // Query InfoJednání
            const queryParams = {
                druhOrganizace: h.courtCode.startsWith('OS') ? null : h.courtCode,
                okresniSoud: h.courtCode.startsWith('OS') ? h.courtCode : null,
                cisloSenatu: h.spisovaZnacka.cisloSenatu,
                druhVeci: h.spisovaZnacka.druhVeci,
                bcVec: h.spisovaZnacka.bcVec,
                rocnik: h.spisovaZnacka.rocnik,
                agenda: null,
                typHledani: "SPZN"
            };
            
            const response = await fetch('https://infojednani.gov.cz/api/v1/jednani/vyhledej', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(queryParams)
            });
            
            if (!response.ok) {
                console.error(`⚠️ Chyba InfoJednání API pro ${h.title}: ${response.status}`);
                continue;
            }
            
            const resData = await response.json();
            const udalosti = resData.udalosti || [];
            
            // Try to find the event on the same day/time
            let matchingEvent = null;
            
            // Convert DD.MM.YYYY to YYYY-MM-DD helper
            const toIsoDate = (dStr) => {
                const p = dStr.replace(/\s+/g, '').split('.');
                return p.length === 3 ? `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}` : dStr;
            };
            
            for (const ev of udalosti) {
                const evIso = toIsoDate(ev.datum);
                if (evIso === h.dueDate) {
                    matchingEvent = ev;
                    break;
                }
            }
            
            let shouldUpdateIcs = false;
            let isCancelled = false;
            let statusText = h.status;
            
            if (matchingEvent) {
                const isEvCancelled = matchingEvent.jednaciZruseno === 'Ano' || matchingEvent.jednaciZruseno === true;
                const newLocation = (resData.organizace || h.courtName) + ', síň ' + (matchingEvent.jednaciSin || '');
                
                if (isEvCancelled) {
                    isCancelled = true;
                    statusText = 'cancelled';
                    shouldUpdateIcs = true;
                    console.log(`⚖️ Hlídač jednání: DETEKOVÁNO ZRUŠENÍ JEDNÁNÍ u ${h.title}`);
                } else if (h.time !== matchingEvent.cas || h.location !== newLocation) {
                    h.time = matchingEvent.cas;
                    h.location = newLocation;
                    statusText = 'updated';
                    shouldUpdateIcs = true;
                    console.log(`⚖️ Hlídač jednání: DETEKOVÁNA ZMĚNA JEDNÁNÍ u ${h.title}`);
                }
            } else {
                // If there are events, but none on our day/time, it was rescheduled!
                if (udalosti.length > 0) {
                    // Vyber nejbližší BUDOUCÍ událost (datum >= dnešek). API může vrátit
                    // i minulá jednání téže věci; vzít slepě udalosti[0] by mohlo jednání
                    // posunout do MINULOSTI → příště označeno 'past' → přestali bychom
                    // hlídat = zmeškané jednání. Do minulosti proto nikdy neposouváme.
                    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                    const future = udalosti
                        .map(ev => ({ ev, iso: toIsoDate(ev.datum) }))
                        .filter(x => x.iso >= todayIso)
                        .sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));

                    if (future.length > 0) {
                        const newEv = future[0].ev;
                        const newIso = future[0].iso;
                        const isEvCancelled = newEv.jednaciZruseno === 'Ano' || newEv.jednaciZruseno === true;

                        console.log(`⚖️ Hlídač jednání: DETEKOVÁNO PŘESUNUTÍ JEDNÁNÍ u ${h.title} na ${newIso} v ${newEv.cas}`);

                        h.dueDate = newIso;
                        h.time = newEv.cas;
                        h.location = (resData.organizace || h.courtName) + ', síň ' + (newEv.jednaciSin || '');
                        statusText = 'updated';
                        isCancelled = isEvCancelled;
                        shouldUpdateIcs = true;
                    } else {
                        // Jen minulé události — nejspíš už proběhlé jednání, nikoli přesun.
                        // Neposouváme do minulosti, necháme hlídač doběhnout přirozeně.
                        console.warn(`⚠️ Hlídač jednání: pro ${h.title} vrátilo API jen minulé události — neposouvám (ponechávám beze změny).`);
                    }
                } else {
                    // Prázdný seznam událostí NEZNAMENÁ automaticky zrušení — může jít
                    // o dočasný výpadek/nedostupnost API. Rušíme jen na EXPLICITNÍ signál
                    // (jednaciZruseno). Zde stav ponecháme beze změny.
                    console.warn(`⚠️ Hlídač jednání: InfoJednání nevrátilo žádnou událost pro ${h.title} — ponechávám beze změny (možný výpadek API, neruším automaticky).`);
                }
            }
            
            if (shouldUpdateIcs) {
                h.status = statusText;
                
                const titleForIcs = isCancelled 
                    ? `❌ ZRUŠENO: ${h.title}` 
                    : (statusText === 'updated' ? `⚠️ PŘESUNUTO: ${h.title}` : h.title);
                
                const cleanDesc = `Soudní jednání u ${h.courtName}.\nSpisová značka: ${h.spisovaZnacka.cisloSenatu} ${h.spisovaZnacka.druhVeci} ${h.spisovaZnacka.bcVec}/${h.spisovaZnacka.rocnik}\nStav hlídače: ${statusText.toUpperCase()}`;
                
                const icsContent = generateIcs(h.id, titleForIcs, h.dueDate, h.time, h.location, cleanDesc, isCancelled);
                
                if (fs.existsSync(h.icsFilePath)) {
                    fs.writeFileSync(h.icsFilePath, icsContent, 'utf-8');
                } else {
                    const CALENDAR_DIR = path.join(WATCH_DIR, 'Kalendar');
                    if (!fs.existsSync(CALENDAR_DIR)) fs.mkdirSync(CALENDAR_DIR, { recursive: true });
                    const safeName = sanitizeFileName(titleForIcs);
                    const newPath = path.join(CALENDAR_DIR, `${safeName}.ics`);
                    fs.writeFileSync(newPath, icsContent, 'utf-8');
                    h.icsFilePath = newPath;
                }
                
                updated++;
            }
            
        } catch (err) {
            console.error(`❌ Hlídač jednání: Chyba při kontrole ${h.title}:`, err.message);
        }
    }
    
    if (updated > 0 || dirty) {
        saveMonitoredHearings(WATCH_DIR, hearings);
    }

    return { checked, updated };
}

module.exports = {
    loadMonitoredHearings,
    saveMonitoredHearings,
    checkAllHearings,
    generateIcs
};
