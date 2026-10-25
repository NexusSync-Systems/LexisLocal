// app-agent-examples.js — UI pro vzorové výstupy (few-shot ukázky) asistenta.
// Načítá se PO app-agents.js a app-agent-kb.js; stejně jako KB panel obalí
// showAgentEditor/showNewAgentForm. Volá GET/POST /api/agents/:id/examples (uložení = správce).
(function () {
    'use strict';
    if (typeof LexisLocalApp === 'undefined') return;
    const P = LexisLocalApp.prototype;
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    Object.assign(P, {
        _exStatus(msg, bad) {
            const st = $('agent-ex-status');
            if (!st) return;
            st.textContent = msg || '';
            st.style.color = bad ? '#f87171' : '';
        },

        async loadAgentExamples(agentId) {
            this._exAgentId = agentId;
            this._exList = [];
            this._exEditIdx = null;
            const panel = $('agent-ex-panel');
            if (panel) panel.style.display = 'block';
            this.closeAgentExampleEditor();
            this._exStatus('');
            const list = $('agent-ex-list');
            if (list) list.innerHTML = '<div style="opacity:0.5;font-size:0.78rem;">Načítám…</div>';
            try {
                const res = await fetch(`${this.apiBase}/agents/${encodeURIComponent(agentId)}/examples`, { headers: this.getHeaders() });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || res.status);
                this._exList = data.examples || [];
                this._exLimits = data.limits || { count: 8 };
                const rb = $('agent-ex-reset');
                if (rb) rb.style.display = data.hasDefaults ? '' : 'none';
                this.renderAgentExamples();
            } catch (err) {
                if (list) list.innerHTML = `<div style="opacity:0.7;font-size:0.78rem;color:#f87171;">Ukázky nejde načíst: ${esc(err.message)}</div>`;
            }
        },

        renderAgentExamples() {
            const list = $('agent-ex-list');
            const ex = this._exList || [];
            const max = (this._exLimits && this._exLimits.count) || 8;
            const cnt = $('agent-ex-count');
            if (cnt) cnt.textContent = `(${ex.length}/${max})`;
            const add = $('agent-ex-add');
            if (add) add.disabled = ex.length >= max;
            if (!list) return;
            if (!ex.length) {
                list.innerHTML = '<div style="opacity:0.5;font-size:0.78rem;">Zatím žádné ukázky. Přidejte 1–2 vzorové dokumenty, jak je píše vaše kancelář.</div>';
                return;
            }
            list.innerHTML = ex.map((e, i) => {
                const badges = [e.enabled === false ? '<span style="opacity:0.6;">vypnuto</span>' : '', e.always ? '<span style="color:#93c5fd;">vždy</span>' : '']
                    .filter(Boolean).join(' · ');
                return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--sf-03);padding:6px 10px;border-radius:6px;font-size:0.8rem;${e.enabled === false ? 'opacity:0.65;' : ''}">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(e.zadani)}">🧩 ${esc(e.title)} ${badges ? `<span style="font-size:0.72rem;">(${badges})</span>` : ''}</span>
                    <span style="display:flex;gap:6px;flex-shrink:0;">
                        <button type="button" class="btn btn-secondary" onclick="window.appInstance.editAgentExample(${i})" style="padding:2px 8px;font-size:0.68rem;">Upravit</button>
                        <button type="button" class="btn btn-secondary" onclick="window.appInstance.deleteAgentExample(${i})" style="padding:2px 8px;font-size:0.68rem;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;">Smazat</button>
                    </span>
                </div>`;
            }).join('');
        },

        editAgentExample(idx) {
            const ed = $('agent-ex-editor');
            if (!ed) return;
            const e = idx >= 0 ? (this._exList || [])[idx] : null;
            this._exEditIdx = idx;
            $('agent-ex-title').value = e ? e.title : '';
            $('agent-ex-zadani').value = e ? e.zadani : '';
            $('agent-ex-vystup').value = e ? e.vystup : '';
            $('agent-ex-enabled').checked = e ? e.enabled !== false : true;
            $('agent-ex-always').checked = !!(e && e.always);
            ed.style.display = 'flex';
            this._exLen();
            ['agent-ex-zadani', 'agent-ex-vystup'].forEach(id => { const el = $(id); if (el && !el._exBound) { el.addEventListener('input', () => this._exLen()); el._exBound = true; } });
            $('agent-ex-title').focus();
        },

        _exLen() {
            const z = ($('agent-ex-zadani') || {}).value || '', v = ($('agent-ex-vystup') || {}).value || '';
            const el = $('agent-ex-len');
            if (el) el.textContent = `zadání ${z.length}/2000 · výstup ${v.length}/8000 znaků`;
        },

        closeAgentExampleEditor() {
            const ed = $('agent-ex-editor');
            if (ed) ed.style.display = 'none';
            this._exEditIdx = null;
        },

        async _exPersist(list, okMsg) {
            const agentId = this._exAgentId;
            if (!agentId) return false;
            this._exStatus('Ukládám…');
            try {
                const res = await fetch(`${this.apiBase}/agents/${encodeURIComponent(agentId)}/examples`, {
                    method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(list === 'reset' ? { reset: true } : { examples: list })
                });
                const data = await res.json().catch(() => ({}));
                if (res.status === 403) { this._exStatus('Ukázky může měnit jen správce.', true); return false; }
                if (!res.ok || !data.success) { this._exStatus('❌ ' + (data.error || 'Uložení selhalo.'), true); return false; }
                this._exList = data.examples || [];
                this.renderAgentExamples();
                this._exStatus(okMsg || '✅ Uloženo.');
                return true;
            } catch (err) {
                this._exStatus('❌ Síťová chyba: ' + err.message, true);
                return false;
            }
        },

        async saveAgentExample() {
            const item = {
                title: $('agent-ex-title').value.trim(),
                zadani: $('agent-ex-zadani').value.trim(),
                vystup: $('agent-ex-vystup').value.trim(),
                enabled: $('agent-ex-enabled').checked,
                always: $('agent-ex-always').checked
            };
            if (!item.zadani || !item.vystup) { this._exStatus('Vyplňte zadání i vzorový výstup.', true); return; }
            const list = (this._exList || []).slice();
            const idx = this._exEditIdx;
            if (idx != null && idx >= 0 && list[idx]) list[idx] = Object.assign({}, list[idx], item);
            else list.push(item);
            if (await this._exPersist(list, '✅ Ukázka uložena — použije se u dalších dotazů.')) this.closeAgentExampleEditor();
        },

        async deleteAgentExample(idx) {
            const e = (this._exList || [])[idx];
            if (!e || !await LexisUI.confirm(`Smazat ukázku „${e.title}“?`)) return;
            const list = this._exList.filter((_, i) => i !== idx);
            await this._exPersist(list, 'Ukázka smazána.');
        },

        async resetAgentExamples() {
            if (!await LexisUI.confirm('Nahradit ukázky tohoto asistenta výchozími? Vlastní ukázky se smažou.')) return;
            this.closeAgentExampleEditor();
            await this._exPersist('reset', 'Obnoveny výchozí ukázky.');
        }
    });

    const origShow = P.showAgentEditor;
    if (typeof origShow === 'function') {
        P.showAgentEditor = function (agent) {
            origShow.call(this, agent);
            try { if (agent && agent.id) this.loadAgentExamples(agent.id); } catch (e) { console.warn('Ukázky:', e); }
        };
    }
    const origNew = P.showNewAgentForm;
    if (typeof origNew === 'function') {
        P.showNewAgentForm = function () {
            origNew.call(this);
            // Nový asistent: ukázky jde přidat až po uložení profilu.
            try { const panel = $('agent-ex-panel'); if (panel) panel.style.display = 'none'; this._exAgentId = null; } catch (e) { /* ignore */ }
        };
    }
})();
