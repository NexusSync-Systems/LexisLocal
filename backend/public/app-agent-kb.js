// app-agent-kb.js — UI pro VLASTNÍ znalostní bázi asistenta (per-agent RAG).
// Načítá se v index.html PO app-agents.js. Záměrně NEMODIFIKUJE app-agents.js:
// přidá metody na LexisLocalApp.prototype a OBALÍ showAgentEditor/showNewAgentForm,
// aby se panel báze načetl při výběru asistenta. Volá /api/agent-knowledge/:agentId.
(function () {
    'use strict';
    if (typeof LexisLocalApp === 'undefined') return;
    const P = LexisLocalApp.prototype;

    Object.assign(P, {
        _kbPanel() { return document.getElementById('agent-kb-panel'); },

        clearAgentKnowledgePanel() {
            const list = document.getElementById('agent-kb-list');
            if (list) list.innerHTML = '';
            const fn = document.getElementById('agent-kb-filename');
            const tx = document.getElementById('agent-kb-text');
            if (fn) fn.value = '';
            if (tx) tx.value = '';
            const st = document.getElementById('agent-kb-upload-status');
            if (st) { st.textContent = ''; st.style.color = ''; }
            const fileEl = document.getElementById('agent-kb-file');
            if (fileEl) fileEl.value = '';
            this._kbAgentId = null;
        },

        async loadAgentKnowledge(agentId) {
            this._kbAgentId = agentId;
            const panel = this._kbPanel();
            if (panel) panel.style.display = 'block';
            const list = document.getElementById('agent-kb-list');
            if (list) list.innerHTML = '<div style="opacity:0.5;font-size:0.78rem;">Načítám…</div>';
            try {
                const res = await fetch(`${this.apiBase}/agent-knowledge/${encodeURIComponent(agentId)}`, { headers: this.getHeaders() });
                const data = await res.json();
                this.renderAgentKnowledge(data.success ? (data.documents || []) : []);
            } catch (err) {
                if (list) list.innerHTML = `<div style="opacity:0.6;font-size:0.78rem;color:#f87171;">Chyba: ${escapeHtml(String(err.message||""))}</div>`;
            }
        },

        renderAgentKnowledge(docs) {
            const list = document.getElementById('agent-kb-list');
            if (!list) return;
            const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            if (!docs.length) {
                list.innerHTML = '<div style="opacity:0.5;font-size:0.78rem;">Zatím žádné dokumenty. Přidejte judikaturu, vzory nebo checklisty níže.</div>';
                return;
            }
            list.innerHTML = docs.map(d => {
                const fn = esc(d.fileName);
                const noVec = (d.embedded < d.chunks) ? ', bez vektoru' : '';
                return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--sf-03);padding:6px 10px;border-radius:6px;font-size:0.8rem;">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ${fn} <span style="opacity:0.5;">(${esc(d.chunks)} částí${noVec})</span></span>
                    <button type="button" class="btn btn-secondary" data-file="${fn}" onclick="window.appInstance.deleteAgentKnowledge(this.dataset.file)" style="padding:2px 8px;font-size:0.68rem;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;">Smazat</button>
                </div>`;
            }).join('');
        },

        async submitAgentKnowledge() {
            const agentId = this._kbAgentId;
            if (!agentId) { alert('Nejdřív zvolte asistenta.'); return; }
            const fnEl = document.getElementById('agent-kb-filename');
            const txEl = document.getElementById('agent-kb-text');
            const fileName = ((fnEl && fnEl.value) || '').trim();
            const text = ((txEl && txEl.value) || '').trim();
            if (!fileName || !text) { alert('Vyplňte název dokumentu i text.'); return; }
            try {
                const res = await fetch(`${this.apiBase}/agent-knowledge/${encodeURIComponent(agentId)}`, {
                    method: 'POST',
                    headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ fileName, text })
                });
                const data = await res.json();
                if (data.success) {
                    if (fnEl) fnEl.value = '';
                    if (txEl) txEl.value = '';
                    await this.loadAgentKnowledge(agentId);
                } else {
                    alert('❌ ' + (data.error || 'Nepodařilo se přidat dokument.'));
                }
            } catch (err) {
                alert('❌ Síťová chyba: ' + err.message);
            }
        },

        async reindexAgentKnowledge() {
            const agentId = this._kbAgentId;
            if (!agentId) { alert('Nejdřív zvolte asistenta.'); return; }
            try {
                const res = await fetch(`${this.apiBase}/agent-knowledge/${encodeURIComponent(agentId)}/reindex`, {
                    method: 'POST',
                    headers: this.getHeaders()
                });
                const data = await res.json();
                if (data.success) {
                    alert(`🔄 Přepočítáno: ${data.embedded}/${data.chunks} chunků má vektor.` + (data.embedded < data.chunks ? '\n\n⚠️ Část bez vektoru — běží embedding model (Ollama / zvolený poskytovatel)?' : ''));
                    await this.loadAgentKnowledge(agentId);
                } else {
                    alert('❌ ' + (data.error || 'Re-embedding se nezdařil.'));
                }
            } catch (err) {
                alert('❌ Síťová chyba: ' + err.message);
            }
        },

        async uploadAgentKnowledgeFile(input) {
            const agentId = this._kbAgentId;
            const status = document.getElementById('agent-kb-upload-status');
            const setStatus = (msg, color) => { if (status) { status.textContent = msg || ''; status.style.color = color || ''; } };
            if (!agentId) { alert('Nejdřív zvolte asistenta.'); if (input) input.value = ''; return; }
            const files = Array.from((input && input.files) || []);
            if (!files.length) return;
            // Více souborů: postupně, se souhrnem (dřív šel nahrát jen jeden).
            if (files.length > 1) {
                let okN = 0; const errs = [];
                for (let i = 0; i < files.length; i++) {
                    setStatus(`Zpracovávám ${i + 1}/${files.length}: „${files[i].name}"…`, '');
                    const r = await this.uploadAgentKnowledgeFile({ files: [files[i]], value: '', _batch: true });
                    if (r && r.ok) okN++; else errs.push(`${files[i].name}: ${(r && r.error) || 'chyba'}`);
                }
                setStatus(`Hotovo: ${okN}/${files.length} přidáno.` + (errs.length ? ' ❌ ' + errs.join('; ') : ''), errs.length ? '#f87171' : '#4ade80');
                input.value = '';
                return;
            }
            const file = files[0];
            const MAX = 25 * 1024 * 1024;
            if (file.size > MAX) {
                setStatus(`Soubor je příliš velký (${(file.size / 1048576).toFixed(1)} MB, max 25 MB).`, '#f87171');
                input.value = ''; return { ok: false, error: 'příliš velký (max 25 MB)' };
            }
            if (!input._batch) setStatus(`Zpracovávám „${file.name}"… (u skenů může OCR chvíli trvat)`, '');
            try {
                const base64 = await new Promise((resolve, reject) => {
                    const r = new FileReader();
                    r.onload = () => resolve(String(r.result).replace(/^data:.*?;base64,/, ''));
                    r.onerror = () => reject(new Error('Nepodařilo se přečíst soubor.'));
                    r.readAsDataURL(file);
                });
                const res = await fetch(`${this.apiBase}/agent-knowledge/${encodeURIComponent(agentId)}/upload`, {
                    method: 'POST',
                    headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ fileName: file.name, base64 })
                });
                const data = await res.json();
                if (data.success) {
                    if (!input._batch) setStatus(`✅ „${data.fileName}" přidán (${data.chars} znaků, ${data.indexed} částí${data.ocr ? ', přes OCR' : ''}).`, '#4ade80');
                    await this.loadAgentKnowledge(agentId);
                    return { ok: true };
                } else {
                    if (!input._batch) setStatus('❌ ' + (data.error || 'Nahrání selhalo.'), '#f87171');
                    return { ok: false, error: data.error || 'nahrání selhalo' };
                }
            } catch (err) {
                if (!input._batch) setStatus('❌ Chyba: ' + err.message, '#f87171');
                return { ok: false, error: err.message };
            } finally {
                if (input && !input._batch) input.value = '';
            }
        },

        async deleteAgentKnowledge(fileName) {
            const agentId = this._kbAgentId;
            if (!agentId) return;
            if (!confirm(`Smazat „${fileName}" ze znalostní báze asistenta?`)) return;
            try {
                const res = await fetch(`${this.apiBase}/agent-knowledge/${encodeURIComponent(agentId)}/${encodeURIComponent(fileName)}`, {
                    method: 'DELETE',
                    headers: this.getHeaders()
                });
                const data = await res.json();
                if (data.success) await this.loadAgentKnowledge(agentId);
                else alert('❌ ' + (data.error || 'Nepodařilo se smazat.'));
            } catch (err) {
                alert('❌ Síťová chyba: ' + err.message);
            }
        }
    });

    // Obalení existujících metod (bez zásahu do app-agents.js).
    const origShow = P.showAgentEditor;
    if (typeof origShow === 'function') {
        P.showAgentEditor = function (agent) {
            origShow.call(this, agent);
            try { if (agent && agent.id) this.loadAgentKnowledge(agent.id); } catch (e) { console.warn('KB panel:', e); }
        };
    }
    const origNew = P.showNewAgentForm;
    if (typeof origNew === 'function') {
        P.showNewAgentForm = function () {
            origNew.call(this);
            // Nový (dosud neuložený) asistent nemá kam ukládat bázi → panel skryjeme.
            try {
                this.clearAgentKnowledgePanel();
                const panel = this._kbPanel();
                if (panel) panel.style.display = 'none';
            } catch (e) { /* ignore */ }
        };
    }
})();
