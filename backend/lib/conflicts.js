/**
 * LexisLocal Conflict of Interest Detector (Fáze 3)
 * Scans RAG semantic index and historic metadata to proactively detect conflicts
 * of interest when onboarding new clients and counterparties.
 */

const db = require('./database');
const { searchSimilar } = require('./rag');


// ── Deterministická kontrola proti spisové evidenci ──
// Sémantické vyhledávání (embeddingy) u krátkých jmen často nedosáhne prahu → falešné
// „bezpečné“. Spisy proto porovnáváme lexikálně: bez diakritiky, bez právní formy,
// po slovech (všechna slova dotazu musí být ve jménu ve spisu), IČO přesně.
const LEGAL_FORMS = new Set(['sro', 'spol', 'as', 'akc', 'ks', 'vos', 'zs', 'ops', 'se', 'zu', 'ou', 'gmbh', 'ltd', 'inc', 'llc', 'ag', 'sa', 'e2e']);
function _norm(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/s\.\s*r\.\s*o\.?/g, ' sro ').replace(/a\.\s*s\.?/g, ' as ').replace(/v\.\s*o\.\s*s\.?/g, ' vos ');
}
function _tokens(s) {
    return _norm(s).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !LEGAL_FORMS.has(t));
}
function _ico(s) { const m = String(s || '').match(/\b(\d{8})\b/); return m ? m[1] : null; }
function _nameMatches(query, candidate) {
    const q = _tokens(query); if (!q.length) return false;
    const c = new Set(_tokens(candidate)); if (!c.size) return false;
    return q.every(t => c.has(t));
}
function _spisLabel(sp) { return [sp.spisZn, sp.nazev].filter(Boolean).join(' — ') || sp.id; }
function registryMatches(name, role) {
    let spisy = [];
    try { spisy = require('./spisy').listSpisy(); } catch (e) { return { ok: false, hits: [] }; }
    const ico = _ico(name);
    const hits = [];
    for (const sp of spisy) {
        if (!sp || sp.stav === 'smazano') continue;
        const fields = role === 'klient' ? [sp.klient] : [sp.protistrana];
        const icoHit = ico && role === 'klient' && sp.klientIco && String(sp.klientIco).replace(/\D/g, '') === ico;
        if (icoHit || fields.some(f => f && _nameMatches(name, f))) {
            hits.push({ spisId: sp.id, label: _spisLabel(sp), value: role === 'klient' ? sp.klient : sp.protistrana, stav: sp.stav });
        }
    }
    return { ok: true, hits };
}

class ConflictDetector {
    /**
     * Runs conflict of interest analysis
     * @param {string} clientName - Name of the new onboarding client
     * @param {string} counterpartyName - Name of the counterparty/opponent
     */
    async checkConflict(clientName, counterpartyName) {
        if (!clientName || !counterpartyName) {
            throw new Error("Jméno klienta i protistrany jsou povinné pro prověření konfliktu.");
        }

        console.log(`🔍 Conflicts: Prověřuji střet zájmů pro [Klient: ${clientName}] vs. [Protistrana: ${counterpartyName}]...`);

        const cleanClient = clientName.trim();
        const cleanCounterparty = counterpartyName.trim();

        // 1. Query RAG database for semantic matches
        let clientMatches = [];
        let counterpartyMatches = [];

        let clientSearchOk = true;
        let opponentSearchOk = true;
        try {
            clientMatches = await searchSimilar(cleanClient, 3);
        } catch (e) {
            clientSearchOk = false;
            console.warn("⚠️ Conflicts RAG: Selhalo vyhledávání pro klienta:", e.message);
        }

        try {
            counterpartyMatches = await searchSimilar(cleanCounterparty, 3);
        } catch (e) {
            opponentSearchOk = false;
            console.warn("⚠️ Conflicts RAG: Selhalo vyhledávání pro protistranu:", e.message);
        }

        // Filter high-confidence matches (score >= 0.70)
        const relevantClientHits = clientMatches.filter(m => m.score >= 0.70);
        const relevantOpponentHits = counterpartyMatches.filter(m => m.score >= 0.70);

        // 2. Compute risk level and description
        let riskLevel = 'none';
        let description = 'Nebyly nalezeny žádné historické shody. Onboarding nového klienta je bezpečný.';
        const conflictsFound = [];

        if (relevantOpponentHits.length > 0) {
            // High risk: Opponent matches our historical client archives!
            riskLevel = 'high';
            description = `Upozornění: Protistrana "${cleanCounterparty}" byla nalezena v našich historických spisech s vysokou shodou! Existuje vážné riziko střetu zájmů.`;
            
            relevantOpponentHits.forEach(hit => {
                conflictsFound.push({
                    type: 'counterparty_match',
                    subject: cleanCounterparty,
                    fileName: hit.fileName,
                    score: hit.score,
                    textSnippet: hit.text.substring(0, 180) + "..."
                });
            });
        } else if (relevantClientHits.length > 0) {
            // Medium risk: Client name already has historical precedents
            riskLevel = 'medium';
            description = `Klient "${cleanClient}" již figuruje v naší spisové agendě. Zkontrolujte, zda se nejedná o duplicitní zastupování nebo dřívější spory.`;
            
            relevantClientHits.forEach(hit => {
                conflictsFound.push({
                    type: 'client_match',
                    subject: cleanClient,
                    fileName: hit.fileName,
                    score: hit.score,
                    textSnippet: hit.text.substring(0, 180) + "..."
                });
            });
        }

        // 2a. Spisová evidence (deterministicky) — má přednost před sémantickým indexem.
        const oppWasClient = registryMatches(cleanCounterparty, 'klient');   // protistrana = náš (bývalý) klient
        const clientWasOpp = registryMatches(cleanClient, 'protistrana');    // nový klient = dřívější protistrana
        const clientExisting = registryMatches(cleanClient, 'klient');        // klient už je v agendě
        const regHigh = [
            ...oppWasClient.hits.map(h => ({ type: 'registry_counterparty_was_client', subject: cleanCounterparty, role: 'klient', ...h })),
            ...clientWasOpp.hits.map(h => ({ type: 'registry_client_was_counterparty', subject: cleanClient, role: 'protistrana', ...h }))
        ];
        if (regHigh.length) {
            const why = [];
            if (oppWasClient.hits.length) why.push(`protistrana „${cleanCounterparty}“ je ve spisech vedena jako náš klient`);
            if (clientWasOpp.hits.length) why.push(`klient „${cleanClient}“ je ve spisech veden jako protistrana`);
            const regDesc = `Upozornění: ${why.join('; ')}. Existuje vážné riziko střetu zájmů.`;
            description = riskLevel === 'high' ? regDesc + ' ' + description : regDesc;
            riskLevel = 'high';
            regHigh.forEach(h => conflictsFound.unshift(h));
        } else if (clientExisting.hits.length && riskLevel === 'none') {
            riskLevel = 'medium';
            description = `Klient „${cleanClient}“ již figuruje ve spisové evidenci. Zkontrolujte, zda se nejedná o duplicitní zastupování nebo dřívější spory.`;
        }
        if (clientExisting.hits.length) {
            clientExisting.hits.forEach(h => conflictsFound.push({ type: 'registry_client_existing', subject: cleanClient, role: 'klient', ...h }));
        }
        if (!oppWasClient.ok || !clientWasOpp.ok) {
            clientSearchOk = false; // spisy nešlo prověřit → výsledek nesmí vypadat jako „bezpečné“
        }

        // 2b. Selhání vyhledávání NESMÍ vypadat jako „žádný konflikt / bezpečné".
        // Nemožnost prověřit ≠ absence konfliktu — jinak by advokát přijal možná
        // kolizního klienta v důvěře v chybný „bezpečný" výsledek.
        const searchIncomplete = !clientSearchOk || !opponentSearchOk;
        if (searchIncomplete) {
            if (riskLevel === 'none') {
                riskLevel = 'unknown';
                description = 'Prověření střetu zájmů se NEZDAŘILO (vyhledávání/model nedostupné). Konflikt NELZE vyloučit — ověřte ručně před přijetím klienta.';
            } else {
                description += ' ⚠️ Část prověření se nezdařila (vyhledávání nedostupné), výsledek nemusí být úplný — ověřte ručně.';
            }
        }

        // 3. Save report to our encrypted transactional database
        const report = db.insert('conflicts', {
            clientName: cleanClient,
            counterpartyName: cleanCounterparty,
            riskLevel,
            description,
            conflictsFound,
            searchIncomplete,
            timestamp: new Date().toISOString()
        });

        console.log(`🔍 Conflicts: Prověrka dokončena. Riziko: [${riskLevel.toUpperCase()}]`);

        return report;
    }

    /**
     * Gets all previous check histories
     */
    getHistory() {
        return db.get('conflicts');
    }
}

module.exports = new ConflictDetector();
module.exports._internals = { _tokens, _nameMatches, registryMatches };
