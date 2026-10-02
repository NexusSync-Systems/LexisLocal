// app-drafts.js — Koncepty: webový „LexisEditor Lite“ v dashboardu LexisLocalu.
// Prototype-mixin nad LexisLocalApp (načítá se po app.js). API: /api/drafts.
//
// Bezpečnost: obsah konceptu se NIKDY nevkládá jako HTML — dokument se staví z bloků
// (spec) přes createElement/textContent a při uložení se z DOM znovu čte jen whitelist
// struktury (nadpis, odstavec, seznam, tabulka, tučně/kurzíva/podtržení, odkaz).
// Vložení ze schránky = prostý text. Server spec znovu validuje.

function _draftDomFromSpec(spec, doc) {
    doc = doc || document;
    const frag = doc.createDocumentFragment();
    ((spec && spec.blocks) || []).forEach((b) => {
        let el = null;
        if (b.type === 'heading') {
            el = doc.createElement('h' + Math.min(3, Math.max(1, b.level || 2)));
            el.textContent = b.text || '';
        } else if (b.type === 'paragraph') {
            el = doc.createElement('p');
            if (b.align && ['center', 'right', 'justify'].includes(b.align)) el.style.textAlign = b.align;
            if (b.runs) {
                b.runs.forEach((r) => {
                    let node = doc.createTextNode(r.text || '');
                    if (r.underline) { const u = doc.createElement('u'); u.appendChild(node); node = u; }
                    if (r.italic) { const i = doc.createElement('em'); i.appendChild(node); node = i; }
                    if (r.bold) { const s = doc.createElement('strong'); s.appendChild(node); node = s; }
                    if (r.link && /^(https?:\/\/|mailto:)/i.test(r.link)) {
                        const a = doc.createElement('a'); a.href = r.link; a.rel = 'noopener noreferrer'; a.target = '_blank'; a.appendChild(node); node = a;
                    }
                    el.appendChild(node);
                });
            } else el.textContent = b.text || '';
            if (!el.firstChild) el.appendChild(doc.createElement('br'));
            if (b.footnote) el.setAttribute('data-footnote', b.footnote);
        } else if (b.type === 'list') {
            el = doc.createElement(b.ordered ? 'ol' : 'ul');
            (b.items || []).forEach((it) => { const li = doc.createElement('li'); li.textContent = it; el.appendChild(li); });
        } else if (b.type === 'table') {
            el = doc.createElement('table');
            el.className = 'draft-table';
            (b.cells || []).forEach((row) => {
                const tr = doc.createElement('tr');
                row.forEach((c) => { const td = doc.createElement('td'); td.textContent = c; tr.appendChild(td); });
                el.appendChild(tr);
            });
        } else if (b.type === 'pageBreak' || b.type === 'toc') {
            el = doc.createElement('hr');
            el.setAttribute('data-block', b.type);
            el.setAttribute('contenteditable', 'false');
        }
        if (el) { if (b.id) el.setAttribute('data-id', b.id); frag.appendChild(el); }
    });
    return frag;
}

function _draftRunsFromNode(node, fmt, out) {
    node.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
            if (n.nodeValue) out.push(Object.assign({ text: n.nodeValue.replace(/ /g, ' ') }, fmt));
            return;
        }
        if (n.nodeType !== 1) return;
        const tag = n.tagName;
        if (tag === 'BR') { out.push(Object.assign({ text: '\n' }, fmt)); return; }
        const f = Object.assign({}, fmt);
        if (tag === 'B' || tag === 'STRONG' || /bold|[6-9]00/.test(n.style && n.style.fontWeight || '')) f.bold = true;
        if (tag === 'I' || tag === 'EM' || (n.style && n.style.fontStyle === 'italic')) f.italic = true;
        if (tag === 'U' || /underline/.test(n.style && n.style.textDecoration || '')) f.underline = true;
        if (tag === 'A' && /^(https?:\/\/|mailto:)/i.test(n.getAttribute('href') || '')) f.link = n.getAttribute('href');
        _draftRunsFromNode(n, f, out);
    });
    return out;
}

function _draftMergeRuns(runs) {
    const out = [];
    runs.forEach((r) => {
        const last = out[out.length - 1];
        if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.underline === !!r.underline && (last.link || '') === (r.link || '')) last.text += r.text;
        else out.push(Object.assign({}, r));
    });
    return out.filter((r) => r.text !== '');
}

function _draftParagraphs(el) {
    // <br> uvnitř odstavce = nový odstavec (každý řádek je v podání samostatný)
    const runs = _draftRunsFromNode(el, {}, []);
    const lines = [[]];
    runs.forEach((r) => {
        const parts = r.text.split('\n');
        parts.forEach((p, i) => { if (i > 0) lines.push([]); if (p) lines[lines.length - 1].push(Object.assign({}, r, { text: p })); });
    });
    const align = el.style && ['center', 'right', 'justify'].includes(el.style.textAlign) ? el.style.textAlign : null;
    return lines.map((l) => {
        const m = _draftMergeRuns(l);
        const b = { type: 'paragraph' };
        if (m.some((r) => r.bold || r.italic || r.underline || r.link)) b.runs = m.map((r) => { const o = { text: r.text }; ['bold', 'italic', 'underline', 'link'].forEach((k) => { if (r[k]) o[k] = r[k]; }); return o; });
        else b.text = m.map((r) => r.text).join('');
        if (align) b.align = align;
        return b;
    }).filter((b) => (b.runs && b.runs.length) || (b.text && b.text.trim()));
}

function _draftSpecFromDom(root) {
    const blocks = [];
    const withId = (b, el) => { const id = el.getAttribute && el.getAttribute('data-id'); if (id) b.id = id; return b; };
    root.childNodes.forEach((el) => {
        if (el.nodeType === 3) { if (el.nodeValue.trim()) blocks.push({ type: 'paragraph', text: el.nodeValue.trim() }); return; }
        if (el.nodeType !== 1) return;
        const tag = el.tagName;
        if (/^H[1-6]$/.test(tag)) {
            const t = el.textContent.trim();
            if (t) blocks.push(withId({ type: 'heading', level: Math.min(3, parseInt(tag[1], 10)), text: t }, el));
        } else if (tag === 'UL' || tag === 'OL') {
            const items = Array.from(el.querySelectorAll('li')).map((li) => li.textContent.trim()).filter(Boolean);
            if (items.length) blocks.push(withId({ type: 'list', ordered: tag === 'OL', items }, el));
        } else if (tag === 'TABLE') {
            const cells = Array.from(el.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent.trim()));
            if (cells.length) blocks.push(withId({ type: 'table', cells }, el));
        } else if (tag === 'HR') {
            blocks.push({ type: el.getAttribute('data-block') === 'toc' ? 'toc' : 'pageBreak' });
        } else {
            const ps = _draftParagraphs(el);
            ps.forEach((p, i) => { if (i === 0) withId(p, el); const fn = el.getAttribute && el.getAttribute('data-footnote'); if (fn && i === ps.length - 1) p.footnote = fn; blocks.push(p); });
        }
    });
    return { blocks };
}

const DRAFT_STATUS = { koncept: 'Koncept', ke_kontrole: 'Ke kontrole', schvaleno: 'Schváleno' };

Object.assign(LexisLocalApp.prototype, {

    async dGet(path) {
        const res = await fetch(`${this.apiBase}${path}`, { headers: this.getHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
        return data;
    },
    async dSend(path, method, body, opts) {
        const res = await fetch(`${this.apiBase}${path}`, Object.assign({
            method, headers: this.getHeaders({ 'Content-Type': 'application/json' }),
            body: body ? JSON.stringify(body) : undefined
        }, opts || {}));
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
        return data;
    },

    async loadDraftsTab() {
        const el = document.getElementById('drafts-list');
        if (!el) return;
        const st = (document.getElementById('drafts-filter') || {}).value || '';
        try {
            const r = await this.dGet('/drafts' + (st ? `?status=${encodeURIComponent(st)}` : ''));
            const list = r.drafts || [];
            const badge = document.getElementById('drafts-badge');
            const review = list.filter((d) => d.status === 'ke_kontrole').length;
            if (badge) { badge.textContent = review; badge.style.display = review ? '' : 'none'; }
            if (!list.length) { el.innerHTML = '<div style="opacity:0.7;font-size:0.85rem;">Zatím žádné koncepty. Vznikají ručně (➕ Nový koncept) nebo automaticky, když agent (např. Spisovatel) napíše dokument.</div>'; return; }
            el.innerHTML = list.map((d) => `
                <div class="draft-row${this.currentDraft && this.currentDraft.id === d.id ? ' active' : ''}" onclick="window.appInstance.openDraft('${_lexEscJsAttr(d.id)}')">
                    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                        <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.title)}</strong>
                        <span class="draft-status st-${escapeHtml(d.status)}">${escapeHtml(d.statusLabel || DRAFT_STATUS[d.status] || d.status)}</span>
                    </div>
                    <div style="font-size:0.72rem;color:var(--text-muted);margin-top:3px;">
                        ${d.aiGenerated ? '🤖 AI · ' : ''}v${escapeHtml(d.version)} · ${escapeHtml((d.lastAuthor && d.lastAuthor.name) || '')} · ${escapeHtml(new Date(d.updatedAt).toLocaleString('cs-CZ'))}
                        ${d.caseNumber ? ' · ' + escapeHtml(d.caseNumber) : ''}${d.openComments ? ` · 💬 ${escapeHtml(d.openComments)}` : ''}${d.lock ? ` · 🔒 ${escapeHtml(d.lock.name)}` : ''}
                    </div>
                </div>`).join('');
        } catch (e) {
            el.innerHTML = `<div style="color:var(--accent-red);">Koncepty nejde načíst: ${escapeHtml(e.message)}</div>`;
        }
    },

    async newDraft() {
        const title = prompt('Název konceptu:', 'Nový koncept');
        if (title == null) return;
        try {
            const d = await this.dSend('/drafts', 'POST', { title: title || 'Nový koncept', text: title || 'Nový koncept' });
            await this.loadDraftsTab();
            await this.openDraft(d.id, { edit: true });
        } catch (e) { alert('Koncept nejde založit: ' + e.message); }
    },

    async openDraft(id, opts) {
        opts = opts || {};
        if (this.activeTab !== 'drafts') this.switchTab('drafts');
        if (this.draftEditing && this.currentDraft && this.currentDraft.id !== id) {
            if (!confirm('Máte rozpracované neuložené změny. Zahodit je?')) return;
            await this.stopDraftEdit(true);
        }
        try {
            this.currentDraft = await this.dGet('/drafts/' + encodeURIComponent(id));
            this.renderDraft();
            this.loadDraftsTab();
            if (opts.edit) this.startDraftEdit();
        } catch (e) { alert('Koncept nejde otevřít: ' + e.message); }
    },

    renderDraft() {
        const d = this.currentDraft;
        const box = document.getElementById('draft-detail');
        if (!box || !d) return;
        const editing = !!this.draftEditing;
        const approved = d.status === 'schvaleno';
        const lockedByOther = d.lock && !editing;
        const btn = (label, fn, extra) => `<button class="btn ${extra && extra.primary ? 'btn-primary' : 'btn-secondary'}" style="font-size:0.75rem;padding:5px 10px;" onclick="window.appInstance.${fn}"${extra && extra.title ? ` title="${escapeHtml(extra.title)}"` : ''}>${label}</button>`;
        const tb = (cmd, label, title) => `<button class="btn btn-secondary draft-tb" title="${escapeHtml(title)}" onmousedown="event.preventDefault()" onclick="window.appInstance.draftFormat('${cmd}')">${label}</button>`;

        box.innerHTML = `
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start;">
                <div style="min-width:0;">
                    <h3 style="margin:0 0 4px 0;word-break:break-word;">${escapeHtml(d.title)}</h3>
                    <div style="font-size:0.75rem;color:var(--text-muted);">
                        <span class="draft-status st-${escapeHtml(d.status)}">${escapeHtml(d.statusLabel)}</span>
                        ${d.aiGenerated ? '<span class="draft-ai" title="Obsah vytvořila nebo upravila AI — před použitím zkontrolujte (EU AI Act čl. 50)">🤖 vytvořeno s AI</span>' : ''}
                        verze ${escapeHtml(d.version)}${d.caseNumber ? ' · sp. zn. ' + escapeHtml(d.caseNumber) : ''}
                        ${d.approvedBy ? ` · schválil(a) ${escapeHtml(d.approvedBy.name)} ${escapeHtml(new Date(d.approvedAt).toLocaleString('cs-CZ'))}` : ''}
                        ${d.hasLetterhead ? ' · hlavička z LexisEditoru zachována' : ''}
                    </div>
                    ${lockedByOther ? `<div style="font-size:0.75rem;color:var(--accent-yellow);margin-top:4px;">🔒 Upravuje ${escapeHtml(d.lock.name)} (do ${escapeHtml(new Date(d.lock.until).toLocaleTimeString('cs-CZ'))})</div>` : ''}
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    ${editing ? btn('💾 Uložit', 'saveDraftEdit()', { primary: true }) + btn('✖ Zrušit', 'stopDraftEdit(false)') :
                        (approved ? '' : btn('✏️ Upravit', 'startDraftEdit()', { primary: true })) +
                        (d.status === 'koncept' ? btn('📤 Ke kontrole', "setDraftStatus('ke_kontrole')") : '') +
                        (d.status === 'ke_kontrole' ? btn('✅ Schválit', "setDraftStatus('schvaleno')", { title: 'Schvaluje advokát — schválený koncept je jen pro čtení' }) : '') +
                        (d.status !== 'koncept' ? btn('↩️ Do konceptu', "setDraftStatus('koncept')") : '') +
                        (!approved ? btn('🤖 Zapracovat připomínky', 'aiReviseDraft()', { title: 'Spisovatel přepracuje koncept podle otevřených připomínek (vznikne nová verze ke kontrole)' }) : '') +
                        btn('⬇️ .docx', 'exportDraftDocx()', { title: 'Word s vnořenými daty — LexisEditor ho otevře bez ztráty struktury' }) +
                        (approved && d.spisId ? btn('📁 Do spisu', 'fileDraftToSpis()') : '') +
                        btn('🗑️', 'deleteDraftUi()', { title: 'Smazat koncept' })}
                </div>
            </div>
            ${editing ? `<div class="draft-toolbar">
                ${tb('h1', 'H1', 'Nadpis 1')}${tb('h2', 'H2', 'Nadpis 2')}${tb('p', '¶', 'Odstavec')}
                ${tb('bold', '<b>B</b>', 'Tučně')}${tb('italic', '<i>I</i>', 'Kurzíva')}${tb('underline', '<u>U</u>', 'Podtržení')}
                ${tb('ul', '•', 'Odrážky')}${tb('ol', '1.', 'Číslovaný seznam')}
                ${tb('center', '≡', 'Na střed')}${tb('left', '⇤', 'Doleva')}
            </div>` : ''}
            <div id="draft-page" class="draft-page${editing ? ' editing' : ''}" ${editing ? 'contenteditable="true" spellcheck="true" lang="cs"' : ''}></div>
            <div class="draft-side">
                <details ${d.comments.some((c) => !c.resolved) ? 'open' : ''}>
                    <summary>💬 Připomínky (${d.comments.filter((c) => !c.resolved).length} otevřených)</summary>
                    <div id="draft-comments"></div>
                    <div style="display:flex;gap:6px;margin-top:8px;">
                        <input id="draft-comment-input" type="text" placeholder="Připomínka pro kolegu nebo pro AI…" style="flex:1;min-width:0;padding:6px 8px;border:1px solid var(--border-glass);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);">
                        ${btn('Přidat', 'addDraftComment()')}
                    </div>
                </details>
                <details>
                    <summary>🕓 Verze (${d.versions.length})</summary>
                    <div id="draft-versions"></div>
                </details>
            </div>`;

        const page = document.getElementById('draft-page');
        page.appendChild(_draftDomFromSpec(this.draftWorkingSpec || d.spec));
        if (editing) {
            page.addEventListener('paste', (ev) => {
                ev.preventDefault();
                const text = (ev.clipboardData || window.clipboardData).getData('text/plain') || '';
                document.execCommand('insertText', false, text);
            });
            page.focus();
        }

        const cEl = document.getElementById('draft-comments');
        cEl.innerHTML = d.comments.length ? d.comments.slice().reverse().map((c) => `
            <div class="draft-comment${c.resolved ? ' resolved' : ''}">
                <div style="font-size:0.7rem;color:var(--text-muted);">${escapeHtml(c.author && c.author.name)} · ${escapeHtml(new Date(c.at).toLocaleString('cs-CZ'))}${c.resolved ? ' · vyřešeno' : ''}</div>
                <div style="white-space:pre-wrap;">${escapeHtml(c.text)}</div>
                ${c.resolved ? '' : `<button class="btn btn-secondary" style="font-size:0.7rem;padding:2px 8px;margin-top:4px;" onclick="window.appInstance.resolveDraftComment('${_lexEscJsAttr(c.id)}')">✓ Vyřešeno</button>`}
            </div>`).join('') : '<div style="font-size:0.8rem;opacity:0.7;">Bez připomínek.</div>';

        const vEl = document.getElementById('draft-versions');
        vEl.innerHTML = d.versions.slice().reverse().map((v) => `
            <div class="draft-version">
                <span>v${escapeHtml(v.v)} · ${v.kind === 'ai' ? '🤖 ' : ''}${escapeHtml(v.author && v.author.name)} · ${escapeHtml(new Date(v.at).toLocaleString('cs-CZ'))}${v.note ? ' — ' + escapeHtml(v.note) : ''}</span>
                ${v.v !== d.version ? `<span style="white-space:nowrap;"><button class="btn btn-secondary" style="font-size:0.7rem;padding:2px 8px;" onclick="window.appInstance.viewDraftVersion(${Number(v.v)})">Zobrazit</button>${approved ? '' : ` <button class="btn btn-secondary" style="font-size:0.7rem;padding:2px 8px;" onclick="window.appInstance.restoreDraftVersion(${Number(v.v)})">Obnovit</button>`}</span>` : '<span style="font-size:0.7rem;">aktuální</span>'}
            </div>`).join('');
    },

    async startDraftEdit() {
        const d = this.currentDraft; if (!d) return;
        try {
            const r = await this.dSend(`/drafts/${encodeURIComponent(d.id)}/lock`, 'POST');
            if (r.version !== d.version) this.currentDraft = await this.dGet('/drafts/' + encodeURIComponent(d.id));
            this.draftEditing = true;
            this.draftBaseVersion = this.currentDraft.version;
            this.draftWorkingSpec = null;
            clearInterval(this._draftLockTimer);
            // Prodlužování zámku (TTL 10 min), dokud je editace otevřená.
            this._draftLockTimer = setInterval(() => {
                if (!this.draftEditing || !this.currentDraft) return clearInterval(this._draftLockTimer);
                this.dSend(`/drafts/${encodeURIComponent(this.currentDraft.id)}/lock`, 'POST').catch(() => {});
            }, 4 * 60 * 1000);
            this.renderDraft();
        } catch (e) { alert(e.message); this.openDraft(d.id); }
    },

    async stopDraftEdit(silent) {
        const d = this.currentDraft;
        clearInterval(this._draftLockTimer);
        this.draftEditing = false; this.draftWorkingSpec = null;
        if (d) { try { await this.dSend(`/drafts/${encodeURIComponent(d.id)}/lock`, 'DELETE'); } catch (e) { /* zámek vyprší sám */ } }
        if (!silent && d) this.openDraft(d.id);
    },

    draftFormat(cmd) {
        const page = document.getElementById('draft-page');
        if (!page) return;
        page.focus();
        const map = { h1: ['formatBlock', 'H1'], h2: ['formatBlock', 'H2'], p: ['formatBlock', 'P'], bold: ['bold'], italic: ['italic'], underline: ['underline'],
            ul: ['insertUnorderedList'], ol: ['insertOrderedList'], center: ['justifyCenter'], left: ['justifyLeft'] };
        const m = map[cmd]; if (!m) return;
        document.execCommand(m[0], false, m[1] || null);
    },

    async saveDraftEdit() {
        const d = this.currentDraft; const page = document.getElementById('draft-page');
        if (!d || !page) return;
        const spec = _draftSpecFromDom(page);
        if (!spec.blocks.length) { alert('Koncept nesmí být prázdný.'); return; }
        const note = prompt('Poznámka k verzi (nepovinné):', '') || '';
        try {
            const r = await this.dSend(`/drafts/${encodeURIComponent(d.id)}`, 'PUT', { spec, baseVersion: this.draftBaseVersion, note });
            this.currentDraft = r;
            await this.stopDraftEdit(true);
            this.renderDraft(); this.loadDraftsTab();
        } catch (e) {
            if (e.status === 409 && e.data && e.data.code === 'conflict') {
                // Nikdo nepřijde o práci: moje úprava se uloží jako samostatný koncept.
                if (confirm(e.message + '\n\nUložit vaši úpravu jako samostatný koncept (nic se neztratí) a načíst aktuální verzi?')) {
                    try {
                        const copy = await this.dSend('/drafts', 'POST', { title: d.title + ' (souběžná úprava)', spisId: d.spisId, caseNumber: d.caseNumber, spec, note: `Souběžná úprava k v${this.draftBaseVersion}` });
                        await this.stopDraftEdit(true);
                        alert('Vaše úprava je uložená jako „' + copy.title + '“.');
                        this.openDraft(d.id);
                    } catch (e2) { alert('Uložení kopie selhalo: ' + e2.message); }
                }
            } else alert('Uložení selhalo: ' + e.message);
        }
    },

    async setDraftStatus(status) {
        const d = this.currentDraft; if (!d) return;
        if (status === 'schvaleno' && !confirm('Schválit koncept? Potvrzujete, že jste obsah zkontroloval(a) — včetně částí od AI. Schválený koncept je jen pro čtení.')) return;
        try { this.currentDraft = await this.dSend(`/drafts/${encodeURIComponent(d.id)}/status`, 'POST', { status }); this.renderDraft(); this.loadDraftsTab(); }
        catch (e) { alert(e.message); }
    },

    async addDraftComment() {
        const d = this.currentDraft; const inp = document.getElementById('draft-comment-input');
        if (!d || !inp || !inp.value.trim()) return;
        try { await this.dSend(`/drafts/${encodeURIComponent(d.id)}/comments`, 'POST', { text: inp.value.trim() }); this.openDraft(d.id); }
        catch (e) { alert(e.message); }
    },

    async resolveDraftComment(cid) {
        const d = this.currentDraft; if (!d) return;
        try { await this.dSend(`/drafts/${encodeURIComponent(d.id)}/comments/${encodeURIComponent(cid)}/resolve`, 'POST'); this.openDraft(d.id); }
        catch (e) { alert(e.message); }
    },

    async viewDraftVersion(v) {
        const d = this.currentDraft; if (!d) return;
        try {
            const ver = await this.dGet(`/drafts/${encodeURIComponent(d.id)}/versions/${encodeURIComponent(v)}`);
            const page = document.getElementById('draft-page');
            page.innerHTML = '';
            const note = document.createElement('div');
            note.className = 'draft-version-banner';
            note.textContent = `Zobrazena starší verze v${ver.v} (${ver.author && ver.author.name}). `;
            const back = document.createElement('button');
            back.className = 'btn btn-secondary'; back.style.fontSize = '0.7rem'; back.textContent = 'Zpět na aktuální';
            back.onclick = () => this.renderDraft();
            note.appendChild(back);
            page.appendChild(note);
            page.appendChild(_draftDomFromSpec(ver.spec));
        } catch (e) { alert(e.message); }
    },

    async restoreDraftVersion(v) {
        const d = this.currentDraft; if (!d) return;
        if (!confirm(`Obnovit verzi v${v}? Vznikne nová verze se stejným obsahem (historie zůstane).`)) return;
        try {
            const ver = await this.dGet(`/drafts/${encodeURIComponent(d.id)}/versions/${encodeURIComponent(v)}`);
            this.currentDraft = await this.dSend(`/drafts/${encodeURIComponent(d.id)}`, 'PUT', { spec: ver.spec, baseVersion: d.version, note: `Obnovena verze v${v}` });
            this.renderDraft(); this.loadDraftsTab();
        } catch (e) { alert(e.message); }
    },

    async aiReviseDraft() {
        const d = this.currentDraft; if (!d) return;
        const open = d.comments.filter((c) => !c.resolved).length;
        const instr = prompt(open ? `Spisovatel zapracuje ${open} otevřených připomínek. Doplňující pokyn (nepovinné):` : 'Co má Spisovatel v konceptu upravit?', '');
        if (instr == null) return;
        if (!open && !instr.trim()) return;
        const box = document.getElementById('draft-detail');
        const wait = document.createElement('div'); wait.className = 'draft-version-banner'; wait.textContent = '🤖 Spisovatel přepracovává koncept…';
        if (box) box.prepend(wait);
        try {
            const r = await this.dSend('/agent/spisovatel', 'POST', { prompt: instr.trim() || 'Zapracuj připomínky advokáta do konceptu.', draftId: d.id });
            if (r.draft && r.draft.error) alert('Revize se neuložila: ' + r.draft.error);
            else if (r.draft && r.draft.skipped) alert('AI nevrátila použitelné znění — koncept zůstal beze změny.');
            this.openDraft(d.id);
        } catch (e) { alert('Revize selhala: ' + e.message); if (wait.parentNode) wait.remove(); }
    },

    async exportDraftDocx() {
        const d = this.currentDraft; if (!d) return;
        try {
            const res = await fetch(`${this.apiBase}/drafts/${encodeURIComponent(d.id)}/export.docx`, { headers: this.getHeaders() });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const cd = res.headers.get('Content-Disposition') || '';
            a.download = (cd.match(/filename="([^"]+)"/) || [])[1] || 'koncept.docx';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        } catch (e) { alert('Export selhal: ' + e.message); }
    },

    async fileDraftToSpis() {
        const d = this.currentDraft; if (!d) return;
        try {
            const r = await this.dSend(`/drafts/${encodeURIComponent(d.id)}/file`, 'POST');
            alert(r.filed ? '✅ Uloženo do složky spisu (03_Koncepty).' : '⚠️ Spis nemá složku — uloženo do _Nezařazeno, zařaďte ručně.');
        } catch (e) { alert(e.message); }
    },

    async deleteDraftUi() {
        const d = this.currentDraft; if (!d) return;
        if (!confirm(`Smazat koncept „${d.title}“?`)) return;
        try {
            await this.dSend(`/drafts/${encodeURIComponent(d.id)}`, 'DELETE');
            this.currentDraft = null;
            const box = document.getElementById('draft-detail');
            if (box) box.innerHTML = '<div style="opacity:0.6;">Koncept smazán.</div>';
            this.loadDraftsTab();
        } catch (e) { alert(e.message); }
    }
});

// Odchod ze stránky během editace → uvolnit zámek (keepalive přežije zavření karty).
window.addEventListener('pagehide', () => {
    const app = window.appInstance;
    if (app && app.draftEditing && app.currentDraft) {
        try { fetch(`${app.apiBase}/drafts/${encodeURIComponent(app.currentDraft.id)}/lock`, { method: 'DELETE', headers: app.getHeaders(), keepalive: true }); } catch (e) { /* zámek vyprší sám */ }
    }
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _draftDomFromSpec, _draftSpecFromDom };
}
