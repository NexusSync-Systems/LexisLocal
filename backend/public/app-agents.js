// app-agents.js — část dashboardu vytažená z app.js (prototype-mixin, beze změny chování).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
Object.assign(LexisLocalApp.prototype, {

    // Přehled pokrytí judikatury po oborech (GET /api/rag/obory) — které obory už
    // mají data a co ještě zbývá naplnit. Zobrazeno v pravém sloupci záložky Asistenti.
    async loadOborCoverage() {
        const listEl = document.getElementById('obor-coverage-list');
        const sumEl = document.getElementById('obor-coverage-summary');
        if (!listEl) return;
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        try {
            const res = await fetch(`${this.apiBase}/rag/obory`, { headers: this.getHeaders() });
            const data = await res.json();
            const obory = data.obory || [];
            if (sumEl) {
                sumEl.innerHTML = `Naplněno <strong>${esc(data.filled || 0)}/${esc(data.total || obory.length)}</strong> oborů`
                    + (data.empty ? ` · ${esc(data.empty)} prázdných` : '');
            }
            const filled = obory.filter(o => o.hasData).sort((a, b) => b.chunks - a.chunks);
            const empty = obory.filter(o => !o.hasData).sort((a, b) => String(a.label).localeCompare(String(b.label), 'cs'));

            const row = (o) => {
                const dot = o.hasData ? '🟢' : '⚪';
                const meta = o.hasData
                    ? `<span style="font-size:0.72rem; color:var(--text-secondary);">${esc(o.documents)} dok · ${esc(o.chunks)} chunků${o.embedded < o.chunks ? ` · ${o.chunks - o.embedded} bez vektoru` : ''}</span>`
                    : `<span style="font-size:0.72rem; color:var(--text-muted);">prázdné</span>`;
                const custom = o.custom ? ` <span title="ruční obor mimo taxonomii" style="opacity:.6;">•</span>` : '';
                return `<div style="display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:8px; background:var(--sunken-1); border:1px solid var(--border-glass); ${o.hasData ? '' : 'opacity:.7;'}">
                    <span style="font-size:0.9rem;">${dot}</span>
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:0.8rem; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(o.label)}${custom}</div>
                        ${meta}
                    </div>
                </div>`;
            };

            const parts = filled.map(row);
            if (empty.length) {
                parts.push(`<div style="font-size:0.68rem; text-transform:uppercase; letter-spacing:.08em; color:var(--text-muted); margin:6px 0 2px;">Zbývá naplnit</div>`);
                empty.forEach(o => parts.push(row(o)));
            }
            listEl.innerHTML = parts.join('') || '<div style="opacity:.6; font-size:0.8rem;">Žádné obory.</div>';
        } catch (e) {
            listEl.innerHTML = `<div style="color:var(--accent-red); font-size:0.8rem;">Chyba načtení pokrytí: ${esc(e.message)}</div>`;
        }
    },

    async loadAgentsList() {
        try {
            console.log("🤖 Načítám AI asistenty ze serveru...");
            const res = await fetch(`${this.apiBase}/agents`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                this.agents = data.agents;
                this.renderAgentsList(this.agents);
                this.syncAgentDropdowns(this.agents);
            } else {
                console.error("⚠️ Selhalo načtení agentů:", data.error);
            }
        } catch (err) {
            console.error("❌ Síťová chyba při načítání agentů:", err.message);
        }
    },

    renderAgentsList(agents) {
        const container = document.getElementById('agents-list-container');
        if (!container) return;

        container.innerHTML = agents.map(agent => {
            const isSystemBadge = agent.isSystem ? '<span class="system-badge">Systém</span>' : '';
            const modelBadge = agent.preferredModel ? `<span class="recommendation-badge" style="margin-top: 4px;">Doporučeno: ${escapeHtml(agent.preferredModel)}</span>` : '';
            return `
                <div class="agents-list-item" data-id="${escapeHtml(agent.id)}">
                    <div class="agent-item-avatar">${escapeHtml(agent.emoji)}</div>
                    <div class="agent-item-meta" style="flex-grow: 1;">
                        <span class="agent-item-name">${escapeHtml(agent.name)}</span>
                        <span class="agent-item-role">${escapeHtml(agent.role)}</span>
                        ${modelBadge}
                    </div>
                    ${isSystemBadge}
                </div>
            `;
        }).join('');

        // Bind clicks to list items
        container.querySelectorAll('.agents-list-item').forEach(item => {
            item.addEventListener('click', () => {
                // Highlight active item
                container.querySelectorAll('.agents-list-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                const agentId = item.getAttribute('data-id');
                const selected = this.agents.find(a => a.id === agentId);
                if (selected) {
                    this.showAgentEditor(selected);
                }
            });
        });
    },

    syncAgentDropdowns(agents) {
        const dropdown1 = document.getElementById('chat-agent-select');
        const dropdown2 = document.getElementById('chat-agent-2-select');
        if (!dropdown1) return;

        // Remember currently selected values if any
        const val1 = dropdown1.value;
        const val2 = dropdown2 ? dropdown2.value : '';

        // Repopulate
        dropdown1.innerHTML = '';
        if (dropdown2) dropdown2.innerHTML = '';

        agents.forEach(agent => {
            const opt1 = document.createElement('option');
            opt1.value = agent.id;
            opt1.textContent = `${agent.emoji} ${agent.name}`;
            dropdown1.appendChild(opt1);

            if (dropdown2) {
                const opt2 = document.createElement('option');
                opt2.value = agent.id;
                opt2.textContent = `${agent.emoji} ${agent.name}`;
                dropdown2.appendChild(opt2);
            }
        });

        // Restore selection if they still exist, otherwise default
        if (agents.some(a => a.id === val1)) {
            dropdown1.value = val1;
        }
        if (dropdown2 && agents.some(a => a.id === val2)) {
            dropdown2.value = val2;
        } else if (dropdown2) {
            dropdown2.value = 'kontrolor'; // default fallback for second agent
        }
    },

    openAgentDialog(icon, heading) {
        const dlg = document.getElementById('dialog-agent-editor');
        const ic = document.getElementById('agent-dialog-icon');
        const hd = document.getElementById('agent-dialog-heading');
        if (ic && icon) ic.textContent = icon;
        if (hd && heading) hd.textContent = heading;
        if (!dlg) return;
        if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
        else { dlg.setAttribute('open', ''); } // fallback pro prohlížeče bez <dialog>
    },

    closeAgentDialog() {
        const dlg = document.getElementById('dialog-agent-editor');
        if (!dlg) return;
        if (typeof dlg.close === 'function' && dlg.open) dlg.close();
        else dlg.removeAttribute('open');
        const container = document.getElementById('agents-list-container');
        if (container) container.querySelectorAll('.agents-list-item').forEach(i => i.classList.remove('active'));
    },

    showAgentEditor(agent) {
        // Toggle view
        document.getElementById('agent-editor-placeholder').style.display = 'none';

        const form = document.getElementById('agent-editor-form');
        form.style.display = 'flex';

        // Set inputs
        document.getElementById('agent-form-is-system').value = agent.isSystem ? 'true' : 'false';
        
        const idGroup = document.getElementById('agent-form-id-group');
        const idInput = document.getElementById('agent-form-id');
        idGroup.style.display = 'block';
        idInput.value = agent.id;
        idInput.disabled = true; // cannot edit ID of existing agents

        document.getElementById('agent-form-emoji').value = agent.emoji;
        document.getElementById('agent-form-name').value = agent.name;
        document.getElementById('agent-form-role').value = agent.role;
        document.getElementById('agent-form-prompt').value = agent.systemPrompt;
        
        // Load new model and permissions fields
        document.getElementById('agent-form-model').value = agent.preferredModel || 'llama3';
        document.getElementById('agent-form-spis-access').value = agent.spisAccess || ((agent.permissions && agent.permissions.read_files) ? 'full' : 'none');
        document.getElementById('agent-form-perm-registries').checked = !!(agent.permissions && agent.permissions.query_registries);
        document.getElementById('agent-form-perm-desktop').checked = !!(agent.permissions && agent.permissions.write_desktop);
        document.getElementById('agent-form-perm-judikatura').checked = agent.useJudikatura !== false;

        // Toggle buttons based on system status
        const btnReset = document.getElementById('btn-reset-agent');
        const btnDelete = document.getElementById('btn-delete-agent');

        if (agent.isSystem) {
            if (btnReset) btnReset.style.display = 'block';
            if (btnDelete) btnDelete.style.display = 'none';
        } else {
            if (btnReset) btnReset.style.display = 'none';
            if (btnDelete) btnDelete.style.display = 'block';
        }

        // Otevři modální dialog
        this.openAgentDialog(agent.emoji || '👤', `Úprava: ${agent.name}`);
    },

    showNewAgentForm() {
        // Clear active highlights
        const container = document.getElementById('agents-list-container');
        if (container) {
            container.querySelectorAll('.agents-list-item').forEach(i => i.classList.remove('active'));
        }

        // Toggle view
        document.getElementById('agent-editor-placeholder').style.display = 'none';
        
        const form = document.getElementById('agent-editor-form');
        form.style.display = 'flex';
        form.reset();

        // Configure ID field for new creation
        document.getElementById('agent-form-is-system').value = 'false';
        
        const idGroup = document.getElementById('agent-form-id-group');
        const idInput = document.getElementById('agent-form-id');
        idGroup.style.display = 'block';
        idInput.value = '';
        idInput.disabled = false;
        idInput.focus();

        // Pre-fill some generic helper values
        document.getElementById('agent-form-emoji').value = '🤖';
        document.getElementById('agent-form-name').value = '';
        document.getElementById('agent-form-role').value = '';
        document.getElementById('agent-form-prompt').value = 'Jsi specializovaný český AI asistent...';
        
        // Reset models and checkboxes
        document.getElementById('agent-form-model').value = 'llama3';
        document.getElementById('agent-form-spis-access').value = 'none';
        document.getElementById('agent-form-perm-registries').checked = false;
        document.getElementById('agent-form-perm-desktop').checked = false;
        document.getElementById('agent-form-perm-judikatura').checked = false;

        // Actions
        const btnReset = document.getElementById('btn-reset-agent');
        const btnDelete = document.getElementById('btn-delete-agent');
        if (btnReset) btnReset.style.display = 'none';
        if (btnDelete) btnDelete.style.display = 'none';

        // Otevři modální dialog
        this.openAgentDialog('🤖', 'Nová role asistenta');
    },

    async submitAgentForm() {
        const isSystem = document.getElementById('agent-form-is-system').value === 'true';
        const idInput = document.getElementById('agent-form-id');
        const agentId = idInput.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_').trim();
        
        if (!agentId) {
            alert("⚠️ Identifikátor asistenta je povinné pole.");
            return;
        }

        const name = document.getElementById('agent-form-name').value.trim();
        const emoji = document.getElementById('agent-form-emoji').value.trim();
        const role = document.getElementById('agent-form-role').value.trim();
        const systemPrompt = document.getElementById('agent-form-prompt').value.trim();
        
        // Read model and permissions inputs
        const preferredModel = document.getElementById('agent-form-model').value;
        const spisAccess = document.getElementById('agent-form-spis-access').value; const readFiles = spisAccess !== 'none';
        const queryRegistries = document.getElementById('agent-form-perm-registries').checked;
        const writeDesktop = document.getElementById('agent-form-perm-desktop').checked;
        const useJudikatura = document.getElementById('agent-form-perm-judikatura').checked;

        try {
            // If it is a new custom agent and disabled = false, we create a new one using POST /api/agents.
            // If it is editing, we use POST /api/agents/:agentId
            const isEditing = idInput.disabled;
            const url = isEditing ? `${this.apiBase}/agents/${agentId}` : `${this.apiBase}/agents`;
            
            const payload = {
                id: agentId,
                name,
                emoji,
                role,
                systemPrompt,
                preferredModel,
                spisAccess,
                useJudikatura,
                permissions: {
                    read_files: readFiles,
                    query_registries: queryRegistries,
                    write_desktop: writeDesktop
                }
            };

            console.log(`💾 Ukládám profil asistenta [${agentId}]...`);
            const res = await fetch(url, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (data.success) {
                alert(`✓ Profil asistenta "${name}" byl úspěšně uložen.`);
                this.closeAgentDialog();
                await this.loadAgentsList();
            } else {
                alert("❌ Nepodařilo se uložit agenta: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba při ukládání agenta: " + err.message);
        }
    },

    async deleteAgent(agentId) {
        try {
            console.log(`🗑️ Mažu vlastního agenta [${agentId}]...`);
            const res = await fetch(`${this.apiBase}/agents/${agentId}`, {
                method: 'DELETE',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                alert("✓ Vlastní agent byl úspěšně smazán.");
                this.closeAgentDialog();
                await this.loadAgentsList();
            } else {
                alert("❌ Chyba při mazání agenta: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba při mazání agenta: " + err.message);
        }
    },

    async resetAgent(agentId) {
        try {
            console.log(`🔄 Resetuji systémového agenta [${agentId}] do výchozího stavu...`);
            const res = await fetch(`${this.apiBase}/agents/${agentId}/reset`, {
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                alert("✓ Agent byl úspěšně obnoven do výchozího nastavení.");
                await this.loadAgentsList();
                
                // Refresh form view
                const selected = this.agents.find(a => a.id === agentId);
                if (selected) {
                    this.showAgentEditor(selected);
                }
            } else {
                alert("❌ Chyba při resetu agenta: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba při resetu agenta: " + err.message);
        }
    },

    async loadWorkflowTab() {
        try {
            console.log("📅 Načítám workflow tab...");
            
            // Fetch Rules
            const resRules = await fetch(`${this.apiBase}/workflows/rules`, { headers: this.getHeaders() });
            const dataRules = await resRules.json();
            
            // Fetch Events (from the new events endpoint)
            const resEvents = await fetch(`${this.apiBase}/calendar/events`, { headers: this.getHeaders() });
            const dataEvents = await resEvents.json();

            if (dataRules.success) {
                this.renderWorkflowRules(dataRules.rules);
            }
            if (dataEvents.success) {
                this.calendarState.events = dataEvents.events;
                this.renderCalendar();
                this.renderAgenda();
            }
        } catch (err) {
            console.error("❌ Nelze načíst workflow data:", err);
            const agendaEl = document.getElementById('calendar-day-agenda');
            if (agendaEl) agendaEl.innerHTML = `<div style="text-align: center; padding: 20px; color: #d97706;">⚠️ Lhůty se nepodařilo načíst: ${escapeHtml(err.message)}</div>`;
        }
    },

    renderWorkflowRules(rules) {
        const listEl = document.getElementById('workflow-rules-list');
        if (!listEl) return;

        if (rules.length === 0) {
            listEl.innerHTML = `<div style="text-align: center; opacity: 0.6; padding: 10px; font-size: 0.8rem;">Žádná pravidla.</div>`;
            return;
        }

        listEl.innerHTML = rules.map(rule => `
            <div class="glass" style="padding: 10px 12px; border-radius: 8px; background: var(--sf-02); border: 1px solid var(--border-glass); display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; margin-bottom: 6px;">
                <div style="flex-grow: 1; min-width: 0; padding-right: 8px;">
                    <strong style="color: var(--text-primary); display: block; margin-bottom: 2px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(rule.name)}</strong>
                    <span style="opacity: 0.6; font-size: 0.7rem; display: block; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                        Trigger: <code>${rule.triggerType === 'document_saved' ? 'Uložení' : 'ISDS'}</code> | Kdy: <code>${escapeHtml(rule.conditionValue)}</code>
                    </span>
                    <span style="display: block; font-size: 0.7rem; color: var(--accent-gold); margin-top: 2px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">➡️ ${escapeHtml(rule.actionTitle)}</span>
                </div>
                <div>
                    ${rule.isSystem ? 
                        `<span style="font-size: 0.65rem; color: var(--accent-blue); padding: 1px 4px; background: rgba(59,130,246,0.1); border-radius: 4px; border: 1px solid rgba(59,130,246,0.2);">Systém</span>` :
                        `<button class="btn btn-secondary" onclick="window.appInstance.deleteWorkflowRule('${String(rule.id || '').replace(/[^A-Za-z0-9_.:-]/g, '')}')" style="padding: 2px 6px; font-size: 0.65rem; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); color: #f87171;">Smazat</button>`
                    }
                </div>
            </div>
        `).join('');
    },

    async saveWorkflowRule(e) {
        e.preventDefault();
        const name = document.getElementById('wf-rule-name').value;
        const triggerType = document.getElementById('wf-rule-trigger').value;
        const conditionField = document.getElementById('wf-rule-field').value;
        const conditionValue = document.getElementById('wf-rule-value').value;
        const actionTitle = document.getElementById('wf-rule-action').value;

        try {
            const res = await fetch(`${this.apiBase}/workflows/rules`, {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name, triggerType, conditionField, conditionValue, actionTitle })
            });

            const data = await res.json();
            if (data.success) {
                alert("✓ Pravidlo bylo úspěšně vytvořeno a uloženo.");
                document.getElementById('workflow-rule-form').reset();
                await this.loadWorkflowTab();
            } else {
                alert("❌ Selhalo vytvoření pravidla: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba: " + err.message);
        }
    },

    async deleteWorkflowRule(id) {
        if (!confirm("Opravdu chcete smazat toto pravidlo?")) return;
        try {
            const res = await fetch(`${this.apiBase}/workflows/rules/${id}`, {
                method: 'DELETE',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                await this.loadWorkflowTab();
            }
        } catch (err) {
            alert("❌ Nelze smazat pravidlo: " + err.message);
        }
    },

    async completeAlert(id) {
        try {
            const res = await fetch(`${this.apiBase}/workflows/alerts/${id}/complete`, {
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                await this.loadWorkflowTab();
            }
        } catch (err) {
            alert("❌ Nelze označit za splněné: " + err.message);
        }
    }

});
