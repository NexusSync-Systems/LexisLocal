'use strict';
const { reviewInChunks } = require('../lib/chunked_review');

const text = Array.from({ length: 6 }, (_, i) => `Čl. ${i + 1}\n` + `Ujednání článku ${i + 1}. `.repeat(400)).join('\n');
function slowLlm(log) {
    let inFlight = 0;
    return {
        maxInFlight: 0,
        async chat({ messages, options }) {
            inFlight++; this.maxInFlight = Math.max(this.maxInFlight, inFlight);
            log.push(options);
            const m = /část (\d+)\//.exec(messages[0].content);
            const i = Number(m[1]);
            await new Promise(r => setTimeout(r, (7 - i) * 15)); // pozdější části doběhnou dřív
            inFlight--;
            return { message: { content: i === 3 ? 'Bez rizik.' : `- čl. ${i}: riziko ${i}` } };
        }
    };
}

afterEach(() => { delete process.env.AGENT_CHUNK_CONCURRENCY; delete process.env.AGENT_CHUNK_NUM_PREDICT; });

test('výchozí: části postupně (1 naráz), bez stropu délky navíc', async () => {
    const log = [], llm = slowLlm(log);
    const r = await reviewInChunks({ llm, model: 'm', text, prompt: 'Rizika?', numCtx: 4096 });
    expect(r.chunks).toBeGreaterThanOrEqual(3);
    expect(llm.maxInFlight).toBe(1);
    expect(log.every(o => o.num_predict === undefined)).toBe(true);
});

test('AGENT_CHUNK_CONCURRENCY=3: souběžně, nálezy v pořadí částí, „Bez rizik" vynechané', async () => {
    process.env.AGENT_CHUNK_CONCURRENCY = '3';
    process.env.AGENT_CHUNK_NUM_PREDICT = '500';
    const log = [], llm = slowLlm(log);
    const r = await reviewInChunks({ llm, model: 'm', text, prompt: 'Rizika?', numCtx: 4096 });
    expect(llm.maxInFlight).toBe(3);
    const order = [...r.notes.matchAll(/^Část (\d+)/gm)].map(m => Number(m[1]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(3);
    expect(log.every(o => o.num_predict === 500)).toBe(true);
});
