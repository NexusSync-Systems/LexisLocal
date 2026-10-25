/**
 * lib/chunked_review.js — kontrola dlouhé smlouvy po částech (map → reduce).
 *
 * Server test 2. 10. 2026 (qwen2.5:7b, 40 článků): v jednom dlouhém vstupu model
 * přehlédl kritická ustanovení. Na krátkých úsecích je 7B model výrazně spolehlivější:
 * smlouvu rozdělíme po článcích na části, ke každé si vyžádáme jen nálezy
 * („čl. N: riziko — §“), a finální odpověď pak model píše z dílčích nálezů.
 */
'use strict';

const ARTICLE_SPLIT = /\n(?=\s*(?:Čl\.|Článek|čl\.)\s*[IVXLC\d]+\b)/;

/** Rozdělí text po článcích do částí o max. maxChars znacích (článek se nedělí, pokud nejde). */
function splitByArticles(text, maxChars) {
    const pieces = String(text || '').split(ARTICLE_SPLIT);
    const chunks = [];
    let cur = '';
    for (const p of pieces) {
        if (p.length > maxChars) { // obří článek → tvrdé dělení po odstavcích
            if (cur) { chunks.push(cur); cur = ''; }
            let buf = '';
            for (const para of p.split(/\n{2,}/)) {
                if ((buf + '\n\n' + para).length > maxChars && buf) { chunks.push(buf); buf = ''; }
                buf = buf ? buf + '\n\n' + para : para;
            }
            if (buf) chunks.push(buf);
            continue;
        }
        if ((cur + '\n' + p).length > maxChars && cur) { chunks.push(cur); cur = ''; }
        cur = cur ? cur + '\n' + p : p;
    }
    if (cur) chunks.push(cur);
    return chunks;
}

function _range(chunk) {
    const nums = [...chunk.matchAll(/(?:Čl\.|Článek|čl\.)\s*([IVXLC\d]+)/g)].map(m => m[1]);
    return nums.length ? (nums.length === 1 ? `čl. ${nums[0]}` : `čl. ${nums[0]}–${nums[nums.length - 1]}`) : 'část bez označení článků';
}

/**
 * Projde text po částech. Vrací { notes, chunks, calls } nebo null (nic k dělení).
 * llm: provider s .chat(); options: { temperature, num_ctx }.
 */
async function reviewInChunks({ llm, model, systemPrompt, text, prompt, numCtx = 8192, options = {}, maxChunks = 8, onChunk } = {}) {
    // Na část ~45 % okna (čeština ~3 znaky/token), zbytek pro pokyn a odpověď.
    const maxChars = Math.max(4000, Math.floor(numCtx * 3 * 0.45));
    const chunks = splitByArticles(text, maxChars);
    if (chunks.length < 2) return null;
    const use = chunks.slice(0, maxChunks);
    const notes = [];
    for (let i = 0; i < use.length; i++) {
        const label = _range(use[i]);
        const messages = [
            { role: 'system', content: `${systemPrompt || ''}\n\nProcházíš DLOUHOU smlouvu po částech. Teď vidíš jen část ${i + 1}/${use.length} (${label}). ` +
                'Úkol advokáta: ' + String(prompt || '').slice(0, 400) + '\n' +
                'Vypiš JEN rizika z této části, každé na řádek ve tvaru „- čl. N: co stanoví → riziko pro klienta (§ …)“. ' +
                'Uváděj konkrétní hodnoty (částky, procenta, lhůty, roky). Když v části riziko není, napiš jen „Bez rizik.“' },
            { role: 'user', content: use[i] }
        ];
        try {
            const r = await llm.chat({ model, messages, options: Object.assign({}, options, { num_ctx: numCtx }) });
            const out = String((r && r.message && r.message.content) || '').trim();
            if (out && !/^bez rizik\.?$/i.test(out)) notes.push(`Část ${i + 1} (${label}):\n${out}`);
        } catch (e) {
            notes.push(`Část ${i + 1} (${label}): nepodařilo se zpracovat (${e.message}).`);
        }
        if (onChunk) { try { onChunk(i + 1, use.length); } catch (e) { /* jen průběh */ } }
    }
    return {
        notes: notes.join('\n\n') || 'V žádné části model riziko nenašel.',
        chunks: use.length,
        skipped: chunks.length - use.length,
        calls: use.length
    };
}

module.exports = { splitByArticles, reviewInChunks };
