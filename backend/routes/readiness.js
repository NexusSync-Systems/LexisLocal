/**
 * routes/readiness.js — „Připravenost systému": jeden souhrnný check pro laika.
 * Montuje se v server.js na /api/readiness. Ověří ty věci, jejichž tiché selhání
 * jinak vypadá jako „nefunguje AI": běží Ollama? je chat + embedding model? je
 * naplněná judikatura? existuje složka spisů? je v souladu mlčenlivost? U každé
 * položky vrací stav (ok/warn/fail), lidský popis a KONKRÉTNÍ nápravu.
 */
'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');

const ollama = require('../lib/ollama_client');
const ai = require('../lib/ai_provider');
const rag = require('../lib/rag');
const obory = require('../lib/obory');
const { CHAT_MODEL, EMBEDDING_MODEL } = require('../lib/model_config');
const { WATCH_DIR } = require('../lib/config');

// Ollama modely nesou tag (llama3:latest) — porovnáváme jen jméno před ':'.
function baseName(m) { return String(m || '').split(':')[0].toLowerCase(); }

router.get('/', async (req, res) => {
    const checks = [];
    const add = (id, label, status, detail, fix) => checks.push({ id, label, status, detail, fix: fix || null });

    // 1) Ollama služba + seznam stažených modelů
    let models = [], ollamaUp = false;
    try {
        const r = await ollama.list();
        models = (r && r.models) || [];
        ollamaUp = true;
    } catch (e) { ollamaUp = false; }

    if (ollamaUp) {
        add('ollama', 'AI služba (Ollama)', 'ok', `běží — ${models.length} modelů staženo`);
    } else {
        add('ollama', 'AI služba (Ollama)', 'fail', 'neběží — asistenti nebudou odpovídat',
            'Spusť aplikaci Ollama (nebo v Terminálu: ollama serve).');
    }

    // 2) Chat model přítomen
    const names = models.map(m => baseName(m.name));
    if (ollamaUp) {
        const has = names.includes(baseName(CHAT_MODEL));
        add('chat_model', `Chat model (${CHAT_MODEL})`, has ? 'ok' : 'warn',
            has ? 'stažený a připravený' : 'není stažený — asistent by běžel jen v nouzovém režimu',
            has ? null : `Stáhni model v záložce „Modely" nebo v Terminálu: ollama pull ${CHAT_MODEL}`);
    }

    // 3) Embedding model — REÁLNÝ probe (rozhoduje o sémantickém vs. lexikálním RAG)
    let embOk = false;
    try { const v = await rag.getEmbedding('test'); embOk = Array.isArray(v) && v.length > 0; }
    catch (e) { embOk = false; }
    add('embedding', `Embedding model (${EMBEDDING_MODEL})`, embOk ? 'ok' : 'warn',
        embOk ? 'dosažitelný — sémantické hledání funguje' : 'nedosažitelný — vyhledávání jede jen podle klíčových slov',
        embOk ? null : `Stáhni model a restartuj: ollama pull ${EMBEDDING_MODEL}`);

    // 4) Judikatura (oborově dělený RAG)
    let filledObory = 0, oborChunks = 0;
    try {
        for (const o of obory.OBORY) {
            const d = rag.listKnowledge(o.scope) || [];
            const c = d.reduce((s, x) => s + (x.chunks || 0), 0);
            if (c > 0) { filledObory++; oborChunks += c; }
        }
    } catch (e) { /* rag nedostupný */ }
    add('judikatura', 'Judikatura (dělený RAG)', filledObory > 0 ? 'ok' : 'warn',
        filledObory > 0 ? `${filledObory}/${obory.OBORY.length} oborů naplněno (${oborChunks} pasáží)` : 'zatím prázdná',
        filledObory > 0 ? null : 'Nahraj ji skriptem seed-kb (viz naplnit-judikaturu.sh) nebo přes záložku Asistenti.');

    // 5) Složka spisů
    let spisyOk = false;
    try { spisyOk = fs.existsSync(WATCH_DIR); } catch (e) { spisyOk = false; }
    add('spisy', 'Složka spisů', spisyOk ? 'ok' : 'warn',
        spisyOk ? WATCH_DIR : 'neexistuje',
        spisyOk ? null : 'Vytvoř složku LexisSpisy na ploše (nebo spusť: npm run setup).');

    // 6) Mlčenlivost (local-only pojistka)
    try {
        const c = ai.assertLocalCompliance();
        const cloud = c.chat !== 'ollama' || c.embed !== 'ollama';
        if (c.localOnly) {
            add('mlcenlivost', 'Mlčenlivost (local-only)', c.compliant ? 'ok' : 'fail',
                c.compliant ? 'zapnuto a v souladu — data neopouští tento počítač' : 'zapnuto, ale AI míří do cloudu',
                c.compliant ? null : 'Nastav lokálního poskytovatele (Ollama) — jinak se server záměrně nespustí.');
        } else {
            add('mlcenlivost', 'Mlčenlivost (local-only)', cloud ? 'warn' : 'ok',
                cloud ? `vypnuto a AI míří do cloudu (chat: ${c.chat}, embed: ${c.embed})` : 'AI běží lokálně (Ollama) — data neopouští stroj',
                cloud ? 'Pro tvrdou pojistku zapni proměnnou LEXIS_PILOT_LOCAL_ONLY=1.' : null);
        }
    } catch (e) { /* ai_provider nedostupný */ }

    // 7) Hlídač soudních jednání (InfoJednání). Výpadek zdroje = advokát musí ověřit ručně.
    try {
        const hh = require('../lib/hearings_health').summary(WATCH_DIR);
        const hearings = require('../lib/hearings').loadMonitoredHearings(WATCH_DIR) || [];
        const review = hearings.filter(h => h.status === 'needs_review').length;
        const fmt = iso => iso ? new Date(iso).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
        const rv = review ? ` · ${review} jednání k potvrzení` : '';
        if (hh.status === 'down') {
            add('hlidac_jednani', 'Hlídač soudních jednání', 'fail',
                `InfoJednání nedostupné od ${fmt(hh.outageSince)} (${hh.lastError || 'bez odpovědi'})${rv}`,
                'Termíny jednání ověřte ručně (datová schránka, web soudu). Hlídač to zkouší dál sám.');
        } else if (hh.status === 'degraded') {
            add('hlidac_jednani', 'Hlídač soudních jednání', 'warn',
                `poslední kontrola selhala (${hh.lastError || 'bez odpovědi'}), naposledy ověřeno ${fmt(hh.lastSuccessAt)}${rv}`, null);
        } else if (hh.status === 'ok') {
            add('hlidac_jednani', 'Hlídač soudních jednání', review ? 'warn' : 'ok',
                `naposledy ověřeno ${fmt(hh.lastSuccessAt)}${rv}`, review ? 'Potvrďte navržená jednání v kalendáři.' : null);
        } else {
            add('hlidac_jednani', 'Hlídač soudních jednání', 'warn',
                `zatím neproběhla žádná kontrola${rv}`,
                'Doplňte u aktivních spisů soud (a případně kód soudu pro InfoJednání).');
        }
    } catch (e) { /* hlídač nedostupný */ }

    const summary = {
        ok: checks.filter(c => c.status === 'ok').length,
        warn: checks.filter(c => c.status === 'warn').length,
        fail: checks.filter(c => c.status === 'fail').length
    };
    // „Připraveno" = nic kritického neselhalo A běží AI služba.
    const ollamaCheck = checks.find(c => c.id === 'ollama');
    summary.ready = summary.fail === 0 && !!ollamaCheck && ollamaCheck.status === 'ok';

    res.json({ checks, summary, timestamp: new Date().toISOString() });
});

module.exports = router;
