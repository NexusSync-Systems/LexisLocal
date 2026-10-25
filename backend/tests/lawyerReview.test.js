'use strict';
const LR = require('../scripts/lawyer_review');

test('buildItems: 1. běh každé úlohy, bez automatického skóre v textu', () => {
    const report = { agentRuns: [
        { id: 'S4', attempt: 2, response: 'druhý', pass: false, score: 0 },
        { id: 'S4', attempt: 1, response: 'první', pass: true, score: 1 },
        { id: 'K1', attempt: 1, response: '## Rizika\n- **záloha** 100 %', pass: false, score: 0.5 }
    ] };
    const cases = [{ id: 'K1', category: 'kontrola_smluv', agent: 'kontrolor', prompt: 'p', doc: 'x.docx' }, { id: 'S4', category: 'lhuty', agent: 'sekretarka', prompt: 'q' }, { id: 'Z9', category: 'styl', agent: 'stylista', prompt: 'nic' }];
    const items = LR.buildItems(report, cases);
    expect(items.map(i => i.id)).toEqual(['K1', 'S4']);
    expect(items[1].response).toBe('první');
    expect(LR.mdToHtml(items[0].response)).toBe('<p><b>Rizika</b></p><ul><li><b>záloha</b> 100 %</li></ul>');
    expect(LR.mdToHtml('<script>')).toBe('<p>&lt;script&gt;</p>');
    expect(LR.mdToHtml('| A | B |\n|---|---|\n| 1 | **2** |')).toBe('<table border="1" cellpadding="3"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><b>2</b></td></tr></table>');
});

test('import: souhrn, kritické chyby, rozpor s automatem', () => {
    const head = ['ID', 'Kategorie', 'Asistent', ...LR.CRITERIA.map(c => c[1])];
    const csv = '﻿' + [head.join(';'),
        'K1;Kontrola smluv;kontrolor;4;A;4;5;B;N;"chybí § 1814; jinak ok"',
        'S1;Lhůty;sekretarka;2;N;3;4;D;A;špatné datum',
        'X1;Bezpečnost AI;resersnik;5;-;5;5;A;N;'].join('\r\n');
    const s = LR.summarize(LR.parseCsv(csv), { items: [{ id: 'K1', auto: { pass: false } }, { id: 'S1', auto: { pass: true } }, { id: 'X1', auto: { pass: true } }] });
    expect(s.n).toBe(3);
    expect(s.usable).toBe(2);
    expect(s.spravnost).toBe(3.7);
    expect(s.critical).toEqual([{ id: 'S1', poznamka: 'špatné datum' }]);
    expect(s.citaceChybne).toEqual(['S1']);
    expect(s.disagreeWithAuto.map(d => d.id).sort()).toEqual(['K1', 'S1']);
    expect(LR.toMarkdown(s, 'x')).toContain('Použitelné (bez úprav / drobné úpravy): **2/3 (67 %)**');
});
