// app-chat.js — část dashboardu vytažená z app.js (prototype-mixin, beze změny chování).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
Object.assign(LexisLocalApp.prototype, {

    // Odznak „detekován obor" pod odpovědí agenta s judikaturou. `det` = objekt
    // oborDetected z odpovědi API (nebo null → prázdný řetězec).
    oborBadgeHtml(det) {
        if (!det) return '';
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const srcLabel = det.source === 'spis' ? 'ze spisu'
            : det.source === 'explicit' ? 'zvoleno ručně' : 'auto-detekce';
        let inner, color, bg, border;
        if (det.confident) {
            const pct = (det.source === 'auto' && typeof det.score === 'number')
                ? ` · shoda ${Math.round(det.score * 100)} %` : '';
            inner = `🧭 Judikatura – obor: <strong>${esc(det.label)}</strong>`
                + `<span style="opacity:.7;"> (${srcLabel}${pct})</span>`;
            color = 'var(--accent-blue)';
            bg = 'rgba(217,164,65,0.10)';
            border = 'rgba(217,164,65,0.30)';
        } else {
            inner = `🧭 Obor neurčen jednoznačně → hledám napříč všemi obory judikatury`;
            color = 'var(--text-muted)';
            bg = 'var(--sunken-1)';
            border = 'var(--border-glass)';
        }
        return `<div class="obor-badge" style="display:inline-flex;align-items:center;gap:6px;`
            + `margin:2px 0 8px;padding:4px 11px;border-radius:999px;background:${bg};`
            + `border:1px solid ${border};font-size:0.72rem;line-height:1.3;color:${color};">${inner}</div>`;
    },

    async loadModels() {
        try {
            const res = await fetch(`${this.apiBase}/models`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            this.models = data.models || [];
            
            // Set counts
            const countEl = document.getElementById('models-count');
            if (countEl) {
                countEl.textContent = this.models.length;
            }

            this.renderModels();
            this.populateChatModelSelect();
        } catch (e) {
            console.error("Chyba při stahování seznamu modelů:", e);
        }
    },

    renderModels() {
        const container = document.getElementById('models-list');
        if (!container) return;

        if (this.models.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🤖</div>
                    <h3>Žádné lokální LLM modely</h3>
                    <p>Zadejte název modelu nahoře a stáhněte jej.</p>
                </div>
            `;
            return;
        }

        let html = '';
        this.models.forEach(m => {
            const sizeGb = (m.size / (1024 * 1024 * 1024)).toFixed(2);
            html += `
                <div class="model-card glass">
                    <div class="model-avatar">🧠</div>
                    <div class="model-details">
                        <h4>${m.name}</h4>
                        <span>Velikost: ${sizeGb} GB</span>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    },

    populateChatModelSelect() {
        const select = document.getElementById('chat-model-select');
        if (!select) return;

        let html = '';
        if (this.models.length === 0) {
            html = `<option value="llama3">llama3 (Simulovaný Fallback)</option>`;
        } else {
            // Embedding modely (bge-m3 apod.) neumí chat — do výběru nepatří.
            const isEmbed = n => /(^|[\/:\-_])(bge|nomic|mxbai|minilm|e5|gte)([\-:._]|$)|embed/i.test(n || '');
            this.models.filter(m => !isEmbed(m.name)).forEach(m => {
                html += `<option value="${m.name}">${m.name}</option>`;
            });
        }
        select.innerHTML = html;
    },

    async pullOllamaModel() {
        const input = document.getElementById('model-input');
        const pullBtn = document.getElementById('btn-pull-model');
        const progressContainer = document.getElementById('pull-progress-container');
        const progressBar = document.getElementById('pull-progress-bar');
        const progressStatus = document.getElementById('pull-progress-status');

        if (!input || !input.value.trim()) {
            alert("Prosím zadejte název modelu.");
            return;
        }

        const modelName = input.value.trim();
        pullBtn.disabled = true;
        pullBtn.textContent = 'Stahuji...';
        progressContainer.style.display = 'block';
        progressBar.style.width = '20%';
        progressStatus.textContent = `Spouštím stahování modelu ${modelName}...`;

        // Simulate pull progress animation smoothly
        let progress = 20;
        const interval = setInterval(() => {
            if (progress < 90) {
                progress += 5;
                progressBar.style.width = `${progress}%`;
                progressStatus.textContent = `Stahování modelu ${modelName}: ${progress}% staženo...`;
            }
        }, 1200);

        try {
            const res = await fetch(`${this.apiBase}/models/pull`, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ model: modelName })
            });
            const data = await res.json();
            
            clearInterval(interval);
            progressBar.style.width = '100%';
            progressStatus.textContent = `Model ${modelName} byl úspěšně stažen a nainstalován.`;
            
            setTimeout(() => {
                progressContainer.style.display = 'none';
                input.value = '';
                this.loadModels();
            }, 3000);

        } catch (e) {
            clearInterval(interval);
            progressBar.style.width = '0%';
            progressStatus.textContent = `Chyba při stahování: ${e.message}`;
        } finally {
            pullBtn.disabled = false;
            pullBtn.textContent = 'Stáhnout model';
        }
    },

    async sendChatMessage() {
        const textarea = document.getElementById('chat-textarea');
        const agentSelect = document.getElementById('chat-agent-select');
        const modelSelect = document.getElementById('chat-model-select');
        const output = document.getElementById('chat-output');

        if (!textarea || !textarea.value.trim()) return;

        const userText = textarea.value.trim();
        const agentId = agentSelect.value;
        const modelName = modelSelect.value;

        // Render user bubble
        output.innerHTML += `
            <div class="chat-message user">
                <div class="message-avatar">👤</div>
                <div class="message-content">
                    <p>${escapeHtml(userText)}</p>
                </div>
            </div>
        `;
        textarea.value = '';
        output.scrollTop = output.scrollHeight;

        // Render typing bubble
        const typingId = `typing-${Date.now()}`;
        output.innerHTML += `
            <div class="chat-message agent" id="${typingId}">
                <div class="message-avatar">🤖</div>
                <div class="message-content">
                    <p><em>Píšu odpověď...</em></p>
                </div>
            </div>
        `;
        output.scrollTop = output.scrollHeight;

        const swarmToggle = document.getElementById('toggle-swarm-debate');
        const swarmOrchestrateToggle = document.getElementById('toggle-swarm-orchestrate');
        const isSwarm = swarmToggle && swarmToggle.checked;
        const isOrchestrate = swarmOrchestrateToggle && swarmOrchestrateToggle.checked;
        
        if (isOrchestrate) {
            try {
                const res = await fetch(`${this.apiBase}/agent-swarm/orchestrate`, {
                    method: 'POST',
                    headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        prompt: userText,
                        model: modelName
                    })
                });
                const data = await res.json();
                
                // Remove typing indicator
                const typingEl = document.getElementById(typingId);
                if (typingEl) typingEl.remove();

                if (!data.success) {
                    throw new Error(data.error || "Orchestrace selhala.");
                }

                // Render beautiful step-by-step timeline of orchestrations
                let stepsHtml = "";
                const emojis = { resersnik: "📚", stylista: "✍️", oponent: "⚖️", sekretarka: "⏰", spisovatel: "📝", chief_orchestrator: "👑" };
                
                (data.steps || []).forEach(step => {
                    const agentEmoji = emojis[step.agentId] || step.agentEmoji || "🤖";
                    const formattedOutput = step.output
                        .replace(/\n/g, '<br>')
                        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                        
                    const carbon = step.metrics ? `(⚡ ${step.metrics.energyWh.toFixed(2)} Wh | 🍃 ${step.metrics.co2Grams.toFixed(2)}g CO₂)` : "";
                    
                    stepsHtml += `
                        <div style="border-left: 2px solid var(--accent-blue); padding-left: 15px; margin-bottom: 20px; position: relative;">
                            <div style="position: absolute; left: -9px; top: 0; background: var(--bg-card); border: 2px solid var(--accent-blue); border-radius: 50%; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; font-size: 0.5rem;"></div>
                            <div style="font-size: 0.8rem; font-weight: bold; color: var(--text-primary); display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
                                <span>${agentEmoji}</span> Krok ${step.step}: ${step.agentName} <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: normal; margin-left: 5px;">${carbon}</span>
                            </div>
                            <div style="font-size: 0.75rem; font-style: italic; color: var(--text-muted); margin-bottom: 5px;">Instrukce: "${step.instruction}"</div>
                            <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.4; background: var(--sf-01); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-glass);">${formattedOutput}</div>
                        </div>
                    `;
                });

                const formattedFinal = data.finalOutput
                    .replace(/\n/g, '<br>')
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

                output.innerHTML += `
                    <div class="chat-message agent" style="border-left: 4px solid var(--accent-blue); padding-left: 15px; margin-bottom: 20px; background: rgba(0, 102, 204, 0.03); border-radius: 4px 12px 12px 4px; width: 100%;">
                        <div style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; color: var(--accent-blue); font-weight: bold; margin-bottom: 15px; display: flex; align-items: center; gap: 6px;">
                            <span>👑</span> Spuštěna hierarchická orchestrace swarmu (Celková doba: ${(data.durationMs/1000).toFixed(1)}s)
                        </div>
                        
                        <!-- Pipeline Steps Timeline -->
                        <div style="margin-bottom: 25px;">
                            ${stepsHtml}
                        </div>

                        <!-- Final Synthesis -->
                        <div style="display: flex; gap: 12px; border: 1px solid rgba(0, 102, 204, 0.2); background: rgba(0, 102, 204, 0.05); padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                            <div class="message-avatar" style="background: var(--accent-blue); color: white; min-width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.1rem;">
                                👑
                            </div>
                            <div class="message-content" style="flex: 1;">
                                <span style="font-weight: bold; color: var(--text-primary); font-size: 0.9rem; display: block; margin-bottom: 6px;">
                                    Finální syntéza (Chief Orchestrator):
                                </span>
                                <p style="margin: 0; font-size: 0.95rem; line-height: 1.5; color: var(--text-primary);">${formattedFinal}</p>
                            </div>
                        </div>
                        
                        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 15px;">
                            <button class="btn btn-secondary" onclick="window.appInstance.sendTextToLexisEditor('${data.finalOutput.replace(/'/g, "\\'").replace(/\n/g, '\\n')}', 'Orchestrované stanovisko')" style="font-size: 0.75rem; padding: 5px 10px;">
                                ✍️ Vložit do Editoru
                            </button>
                        </div>
                    </div>
                `;
                output.scrollTop = output.scrollHeight;
                
            } catch (e) {
                const typingEl = document.getElementById(typingId);
                if (typingEl) typingEl.remove();
                output.innerHTML += `<div class="chat-message agent"><div class="message-content"><p style="color:var(--accent-red);">❌ Chyba orchestrace: ${escapeHtml(e.message)}</p></div></div>`;
                output.scrollTop = output.scrollHeight;
            }
            return;
        }

        if (isSwarm) {
            const agent2Select = document.getElementById('chat-agent-2-select');
            const agentId2 = agent2Select ? agent2Select.value : 'kontrolor';
            
            try {
                const res = await fetch(`${this.apiBase}/agent-swarm/debate`, {
                    method: 'POST',
                    headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        prompt: userText,
                        agentId1: agentId,
                        agentId2: agentId2,
                        model: modelName
                    })
                });
                const data = await res.json();
                
                // Remove typing indicator
                const typingEl = document.getElementById(typingId);
                if (typingEl) typingEl.remove();

                const emojis = { resersnik: "📚", stylista: "✍️", kontrolor: "⚖️", sekretarka: "⏰", spisovatel: "📝" };
                const emoji1 = emojis[agentId] || "🤖";
                const emoji2 = emojis[agentId2] || "⚖️";

                const formatted1 = data.agent1.response
                    .replace(/\n/g, '<br>')
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                    
                const formatted2 = data.agent2.response
                    .replace(/\n/g, '<br>')
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

                output.innerHTML += `
                    <div class="chat-message agent" style="border-left: 3px solid var(--accent-blue); padding-left: 15px; margin-bottom: 20px; background: rgba(0, 102, 204, 0.02); border-radius: 4px 12px 12px 4px; width: 100%;">
                        <div style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; color: var(--accent-blue); font-weight: bold; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
                            <span>👥</span> Spuštěna oponentní diskuse asistentů (Model: ${data.model})
                        </div>
                        ${this.oborBadgeHtml(data.oborDetected)}

                        <!-- Agent 1 Bubble -->
                        <div style="display: flex; gap: 12px; margin-bottom: 15px;">
                            <div class="message-avatar" style="background: var(--sf-05); min-width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.1rem;">
                                ${emoji1}
                            </div>
                            <div class="message-content" style="flex: 1;">
                                <span style="font-weight: bold; color: var(--text-primary); font-size: 0.85rem; display: block; margin-bottom: 4px;">
                                    Prvotní vypracování (${data.agent1.name}):
                                </span>
                                <p style="margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--text-muted);">${formatted1}</p>
                            </div>
                        </div>

                        <hr style="border: none; border-top: 1px dashed var(--border-glass); margin: 15px 0;">

                        <!-- Agent 2 Bubble -->
                        <div style="display: flex; gap: 12px;">
                            <div class="message-avatar" style="background: rgba(239, 68, 68, 0.1); min-width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; border: 1px solid rgba(239, 68, 68, 0.2);">
                                ${emoji2}
                            </div>
                            <div class="message-content" style="flex: 1;">
                                <span style="font-weight: bold; color: #fca5a5; font-size: 0.85rem; display: block; margin-bottom: 4px;">
                                    Oponentní posudek & Revize (${data.agent2.name}):
                                </span>
                                <p style="margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--text-primary); background: var(--sf-02); padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border-glass);">${formatted2}</p>
                            </div>
                        </div>
                        
                        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 15px;">
                            <button class="btn btn-secondary" onclick="window.appInstance.sendTextToLexisEditor('=== NÁVRH OD ${data.agent1.name} ===\\n${data.agent1.response.replace(/'/g, "\\'").replace(/\n/g, '\\n')}\\n\\n=== REVIZE A OPONENTURA OD ${data.agent2.name} ===\\n${data.agent2.response.replace(/'/g, "\\'").replace(/\n/g, '\\n')}', 'Oponentní diskuse: ${data.agent1.name} & ${data.agent2.name}')" style="font-size: 0.75rem; padding: 5px 10px;">
                                ✍️ Odeslat diskusi do Editoru
                            </button>
                        </div>
                    </div>
                `;
                output.scrollTop = output.scrollHeight;
                
            } catch (e) {
                const typingEl = document.getElementById(typingId);
                if (typingEl) typingEl.remove();
                output.innerHTML += `<div class="chat-message agent"><div class="message-content"><p style="color:var(--accent-red);">❌ Chyba připojení: ${escapeHtml(e.message)}</p></div></div>`;
                output.scrollTop = output.scrollHeight;
            }
            return;
        }

        try {
            const res = await fetch(`${this.apiBase}/agent/${agentId}`, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    prompt: userText,
                    model: modelName
                })
            });
            const data = await res.json();
            
            // Remove typing indicator
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();

            // Format response content dynamically
            const formatted = data.response
                .replace(/\n/g, '<br>')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

            const emojis = { resersnik: "📚", stylista: "✍️", kontrolor: "⚖️", sekretarka: "⏰", spisovatel: "📝" };
            const emoji = emojis[agentId] || "🤖";

            output.innerHTML += `
                <div class="chat-message agent">
                    <div class="message-avatar">${emoji}</div>
                    <div class="message-content">
                        ${this.oborBadgeHtml(data.oborDetected)}
                        <p>${formatted}</p>
                        <span class="subtext" style="display:block; margin-top:5px; font-size:0.7rem; color:var(--text-muted);">
                            Model: ${data.model} | ${new Date(data.timestamp).toLocaleTimeString('cs-CZ')}
                        </span>
                    </div>
                </div>
            `;
            output.scrollTop = output.scrollHeight;

        } catch (e) {
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();

            output.innerHTML += `
                <div class="chat-message agent">
                    <div class="message-avatar">⚠️</div>
                    <div class="message-content">
                        <p style="color:var(--accent-red);">Chyba spojení s lokálním serverem: ${escapeHtml(e.message)}</p>
                    </div>
                </div>
            `;
            output.scrollTop = output.scrollHeight;
        }
    },

    async checkRagStatus() {
        try {
            const res = await fetch(`${this.apiBase}/rag/status`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            const badgeEl = document.getElementById('rag-status-badge');
            if (badgeEl && data.chunksCount !== undefined) {
                badgeEl.textContent = `Index: ${data.chunksCount} pasáží (${data.filesCount} spisů)`;
            }
        } catch (e) {
            console.warn("RAG: Nepodařilo se zjistit stav vektorové databáze:", e);
        }
    },

    async performSemanticSearch() {
        const inputEl = document.getElementById('semantic-search-input');
        const resultsEl = document.getElementById('semantic-search-results');
        const loaderEl = document.getElementById('semantic-search-loader');
        
        if (!inputEl || !resultsEl || !loaderEl) return;
        
        const query = inputEl.value.trim();
        if (!query) {
            alert("Zadejte prosím dotaz pro sémantické vyhledávání.");
            return;
        }
        
        // Reset and show loader
        resultsEl.style.display = 'none';
        loaderEl.style.display = 'flex';
        
        try {
            const res = await fetch(`${this.apiBase}/rag/search?query=${encodeURIComponent(query)}&limit=5`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            
            loaderEl.style.display = 'none';
            resultsEl.style.display = 'flex';
            
            if (!data.matches || data.matches.length === 0) {
                resultsEl.innerHTML = `<div class="no-results">Nepodařilo se najít žádné pasáže odpovídající Vašemu vyhledávání. Zkuste upřesnit zadání.</div>`;
                return;
            }
            
            let html = '';
            data.matches.forEach(match => {
                const isHigh = match.score >= 0.85;
                const confidenceClass = isHigh ? 'high' : '';
                const percent = Math.round(match.score * 100);
                
                html += `
                    <div class="search-result-card glass" style="border-left-color: ${isHigh ? '#60a5fa' : '#34d399'};">
                        <div class="search-result-meta">
                            <div class="search-result-file" onclick="window.appInstance.viewSpisContent('${match.fileName.replace(/'/g, "\\'")}')">
                                📁 <span>${match.fileName}</span>
                            </div>
                            <span class="match-badge ${confidenceClass}">${percent}% shoda</span>
                        </div>
                        <div class="search-result-text">
                            "${match.text}"
                        </div>
                    </div>
                `;
            });
            resultsEl.innerHTML = html;
        } catch (e) {
            loaderEl.style.display = 'none';
            resultsEl.style.display = 'flex';
            resultsEl.innerHTML = `<div class="no-results" style="color: var(--accent-red); border-color: rgba(239, 68, 68, 0.2);">❌ Chyba sémantického vyhledávání: ${escapeHtml(e.message)}</div>`;
        }
    },

    async reindexAllRag() {
        if (!confirm("Opravdu chcete kompletně přegenerovat všechny sémantické indexy spisů?\nTato operace rozseká texty a vygeneruje nové AI embeddingy.")) return;
        
        const reindexBtn = document.getElementById('btn-reindex-all');
        const badgeEl = document.getElementById('rag-status-badge');
        
        const originalText = reindexBtn ? reindexBtn.textContent : "🔄 Přegenerovat indexy";
        if (reindexBtn) {
            reindexBtn.textContent = "🔄 Indexuji...";
            reindexBtn.disabled = true;
        }
        if (badgeEl) badgeEl.textContent = "Probíhá re-indexace...";
        
        try {
            const res = await fetch(`${this.apiBase}/rag/reindex-all`, {
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            
            if (data.success) {
                alert(`✓ Re-indexace úspěšně dokončena!\n${data.message}`);
            } else {
                alert("❌ Chyba re-indexace: " + (data.error || "Neznámá chyba"));
            }
        } catch (e) {
            alert("❌ Selhalo spojení se serverem pro re-indexaci: " + e.message);
        } finally {
            if (reindexBtn) {
                reindexBtn.textContent = originalText;
                reindexBtn.disabled = false;
            }
            await this.checkRagStatus();
        }
    },

    async handleFileSelected(file) {
        return this.handleFilesSelected([file]);
    },

    // Nahrání více souborů najednou (výběr s Ctrl/⌘ nebo přetažení). Soubory jdou
    // na server POSTUPNĚ — každý se hned zpracovává (OCR + AI), souběh by přetížil
    // model. Stav každého souboru je vidět v panelu vpravo dole, žádné alerty.
    async handleFilesSelected(files) {
        const ALLOWED = /\.(pdf|txt|docx|html?|png|jpe?g|tiff?|bmp|webp)$/i;
        const MAX = 40 * 1024 * 1024; // JSON limit serveru 50 MB, base64 +33 %
        const uploadBtn = document.getElementById('btn-upload-file');
        if (uploadBtn) uploadBtn.disabled = true;

        let panel = document.getElementById('lexis-upload-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'lexis-upload-panel';
            panel.setAttribute('role', 'status');
            panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;width:min(380px,calc(100vw - 32px));max-height:50vh;overflow:auto;background:var(--surface-1,#fff);color:var(--text-primary,#111);border:1px solid var(--border-glass,#ddd);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:12px;font-size:0.85rem;';
            document.body.appendChild(panel);
        }
        panel.innerHTML = '';
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:600;';
        const title = document.createElement('span');
        const close = document.createElement('button');
        close.type = 'button'; close.textContent = '×'; close.title = 'Zavřít';
        close.style.cssText = 'border:none;background:none;font-size:1.1rem;cursor:pointer;color:inherit;';
        close.onclick = () => panel.remove();
        head.append(title, close);
        panel.appendChild(head);

        const rows = files.map(f => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;padding:4px 0;border-top:1px solid var(--border-glass,#eee);';
            const st = document.createElement('span'); st.textContent = '⏳'; st.style.flex = '0 0 auto';
            const nm = document.createElement('span'); nm.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere;';
            nm.textContent = f.name;
            const msg = document.createElement('div'); msg.style.cssText = 'font-size:0.78rem;opacity:.8;';
            nm.appendChild(msg);
            row.append(st, nm);
            panel.appendChild(row);
            return { st, msg };
        });

        const readB64 = f => new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('soubor nejde přečíst z disku'));
            r.readAsDataURL(f);
        });

        let ok = 0, warn = 0, fail = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i], ui = rows[i];
            title.textContent = `Nahrávání ${i + 1}/${files.length}…`;
            if (!ALLOWED.test(f.name)) { ui.st.textContent = '⛔'; ui.msg.textContent = 'nepodporovaný typ souboru'; fail++; continue; }
            if (f.size > MAX) { ui.st.textContent = '⛔'; ui.msg.textContent = `příliš velký (${(f.size / 1048576).toFixed(1)} MB, max 40 MB)`; fail++; continue; }
            ui.st.textContent = '🔄'; ui.msg.textContent = 'zpracovávám (OCR + AI)…';
            try {
                const base64 = await readB64(f);
                const res = await fetch(`${this.apiBase}/inbox/upload`, {
                    method: 'POST',
                    headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ fileName: f.name, base64 })
                });
                let data = {}; try { data = await res.json(); } catch (e) { /* ne-JSON odpověď */ }
                if (res.ok && data.success && data.processed === false) {
                    ui.st.textContent = '⚠️'; ui.msg.textContent = data.warning || 'uloženo, ale zpracování selhalo'; warn++;
                } else if (res.ok && data.success) {
                    ui.st.textContent = '✅'; ui.msg.textContent = 'nahráno a zanalyzováno'; ok++;
                } else {
                    ui.st.textContent = '❌'; ui.msg.textContent = data.error || `chyba serveru (HTTP ${res.status})`; fail++;
                }
            } catch (err) {
                ui.st.textContent = '❌'; ui.msg.textContent = 'chyba spojení: ' + err.message; fail++;
            }
        }
        title.textContent = `Hotovo: ${ok} ✅` + (warn ? `, ${warn} ⚠️` : '') + (fail ? `, ${fail} ❌` : '');
        if (uploadBtn) uploadBtn.disabled = false;
        const fileUploader = document.getElementById('file-uploader');
        if (fileUploader) fileUploader.value = '';
        if (ok || warn) {
            try { await this.loadInbox(); await this.checkRagStatus(); } catch (e) { /* obnova seznamu je best-effort */ }
        }
        return { ok, warn, fail };
    },

    async loadRegistryConfig() {
        const st = document.getElementById('reg-cfg-status');
        try {
            const res = await fetch(`${this.apiBase}/registries/config`, { headers: this.getHeaders() });
            const data = await res.json();
            if (!data.success) return;
            const c = data.config || {};
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
            set('reg-cfg-cee-url', c.cee && c.cee.url);
            set('reg-cfg-katastr-url', c.katastr && c.katastr.url);
            // klíče se nevracejí — jen naznač, že jsou uložené
            const ceeKey = document.getElementById('reg-cfg-cee-key');
            const katKey = document.getElementById('reg-cfg-katastr-key');
            if (ceeKey) ceeKey.placeholder = (c.cee && c.cee.hasKey) ? 'CEE klíč uložen — prázdné = beze změny' : 'CEE klíč (prázdné = beze změny)';
            if (katKey) katKey.placeholder = (c.katastr && c.katastr.hasKey) ? 'Katastr klíč uložen — prázdné = beze změny' : 'Katastr klíč (prázdné = beze změny)';
            if (st) { st.textContent = ''; }
        } catch (err) {
            if (st) { st.textContent = 'Nelze načíst: ' + err.message; st.style.color = '#f87171'; }
        }
    },

    async saveRegistryConfig() {
        const st = document.getElementById('reg-cfg-status');
        const val = (id) => (document.getElementById(id) || {}).value || '';
        const payload = {
            cee: { url: val('reg-cfg-cee-url'), key: val('reg-cfg-cee-key') },
            katastr: { url: val('reg-cfg-katastr-url'), key: val('reg-cfg-katastr-key') }
        };
        try {
            const res = await fetch(`${this.apiBase}/registries/config`, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                // klíče po uložení vyprázdni z polí (ať se nedrží v DOM)
                const ck = document.getElementById('reg-cfg-cee-key'); if (ck) ck.value = '';
                const kk = document.getElementById('reg-cfg-katastr-key'); if (kk) kk.value = '';
                if (st) { st.textContent = '✅ Uloženo. Dotazy na CEE/Katastr se nyní provedou proti zadanému API.'; st.style.color = '#4ade80'; }
                this.loadRegistryConfig();
            } else if (st) { st.textContent = '❌ ' + (data.error || 'Uložení selhalo.'); st.style.color = '#f87171'; }
        } catch (err) {
            if (st) { st.textContent = '❌ Chyba: ' + err.message; st.style.color = '#f87171'; }
        }
    },

    async performRegistrySearch() {
        const input = document.getElementById('registry-search-input');
        const loader = document.getElementById('registry-search-loader');
        const resultsPanel = document.getElementById('registry-search-results');
        const btn = document.getElementById('btn-registry-search');
        
        if (!input || !input.value.trim()) {
            alert("⚠️ Prosím zadejte IČO.");
            return;
        }
        
        const ico = input.value.trim();
        loader.style.display = 'flex';
        resultsPanel.style.display = 'none';
        btn.disabled = true;
        
        try {
            const res = await fetch(`${this.apiBase}/registries/check?ico=${encodeURIComponent(ico)}`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            
            if (data.error) {
                alert("❌ Chyba: " + data.error);
                loader.style.display = 'none';
                btn.disabled = false;
                return;
            }
            
            // Normalizace tvaru CEE/Katastr (nové API: {available, ...}). Bez přístupu
            // NEJSOU žádná data — jen čestné „není k dispozici".
            data.cee = data.cee || { available: false };
            data.katastr = data.katastr || { available: false };
            const ceeUnavail = data.cee.available !== true;
            const katUnavail = data.katastr.available !== true;
            data.cee.disclaimer = ceeUnavail ? (data.cee.reason || data.cee.error || 'CEE není k dispozici.') : '';
            data.katastr.disclaimer = katUnavail ? (data.katastr.reason || data.katastr.error || 'Katastr není k dispozici.') : '';
            // Build the report text to save. POZOR: ARES (název/sídlo) a ISIR
            // (insolvence) jsou reálné dotazy; CEE (exekuce) a Katastr jsou zatím
            // SIMULOVANÉ (bez napojení). Report proto nikde netvrdí konkrétní
            // exekuce/nemovitosti jako fakt — jinak by je advokát mohl vložit do
            // podání jako ověřené zjištění.
            const reportText = `==================================================
⚖️ LEXISLOCAL - PROVĚRKA SUBJEKTU
(ARES + ISIR reálné; CEE + Katastr jen s nakonfigurovaným přístupem)
==================================================
Subjekt: ${data.name}
IČO: ${data.ico}
Sídlo: ${data.seat}
Provedeno dne: ${new Date(data.verifiedAt).toLocaleString('cs-CZ')}

--------------------------------------------------
1. KATASTR NEMOVITOSTÍ (Lokalita a plomby)
--------------------------------------------------
${katUnavail
    ? 'Stav: NENÍ K DISPOZICI — vyžaduje registrovaný/placený přístup do Katastru (ČÚZK). Žádná data se negenerují.'
    : `Vlastněné nemovitosti: ${data.katastr.propertiesCount > 0 ? `ANO (${data.katastr.propertiesCount} zapsaných staveb/pozemků)` : 'NE (žádný přímý zápis vlastnictví)'}
Aktivní plombování/změna práva: ${data.katastr.hasPlomba ? '⚠️ DETEKOVÁNA PLOMBA (probíhající řízení o změně práva!)' : 'Bez omezení / Bez plomby'}`}
Upozornění: ${data.katastr.disclaimer}

--------------------------------------------------
2. INSOLVENČNÍ REJSTŘÍK (ISIR - Ministerstvo spravedlnosti)
--------------------------------------------------
Stav: ${data.inInsolvency ? '❌ AKTIVNÍ INSOLVENCE / ÚPADEK Subjektu' : '✅ BEZ ZÁZNAMU v insolvenčním rejstříku'}
${data.inInsolvency ? `Spisová značka: ${data.insolvencyCase}
Stav řízení: ${data.insolvencyStatus}` : ''}

--------------------------------------------------
3. CENTRÁLNÍ EVIDENCE EXEKUCÍ (CEE - Exekutorská komora)
--------------------------------------------------
${ceeUnavail
    ? 'Stav: NENÍ K DISPOZICI — vyžaduje placený přístup do CEE (Exekutorská komora ČR). Žádná data se negenerují.'
    : `Stav: ${data.cee.activeExecutions > 0 ? `⚠️ DETEKOVÁNY ${data.cee.activeExecutions} AKTIVNÍ EXEKUCE` : '✅ BEZ ZÁZNAMU o aktivních exekucích'}
${(data.cee.activeExecutions > 0 && data.cee.totalAmount != null) ? `Celková vymáhaná jistina: ${data.cee.totalAmount.toLocaleString('cs-CZ')} Kč` : ''}`}
Upozornění: ${data.cee.disclaimer}

--------------------------------------------------
Generováno systémem LexisLocal. 100% soukromé a šifrované.`;

            // Display results in a gorgeous responsive card layout
            resultsPanel.innerHTML = `
                <div class="stat-card glass" style="width: 100%; display: flex; flex-direction: column; gap: 20px; padding: 25px;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 15px; border-bottom: 1px solid var(--border-glass); padding-bottom: 15px;">
                        <div>
                            <span style="font-size: 0.75rem; color: var(--accent-blue); font-weight: 700; text-transform: uppercase;">Výpis z registrů (ARES + ISIR reálné${ceeUnavail || katUnavail ? '; CEE/Katastr bez přístupu' : ''})</span>
                            <h2 style="margin: 5px 0 0 0; font-size: 1.5rem; color: var(--text-primary);">${data.name}</h2>
                            <p style="margin: 5px 0 0 0; font-size: 0.85rem; color: var(--text-muted);">IČO: ${data.ico} | Sídlo: ${data.seat}</p>
                        </div>
                        <div style="display: flex; gap: 10px;">
                            <button class="btn btn-primary" id="btn-save-registry-report">
                                📥 Uložit lustraci do spisu
                            </button>
                            <button class="btn btn-primary" id="btn-send-registry-report" style="background: var(--accent-blue);">
                                ✍️ Odeslat do LexisEditoru
                            </button>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 15px;">
                        <div style="background: var(--sf-02); border: 1px solid var(--border-glass); border-radius: 12px; padding: 15px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
                                <span style="font-size: 1.2rem;">🏛️</span>
                                <h4 style="margin: 0; color: var(--text-primary);">ARES a Sídlo</h4>
                            </div>
                            <p style="font-size: 0.85rem; margin: 0; color: var(--text-muted);">
                                Subjekt je řádně zapsán v obchodním/živnostenském rejstříku.
                            </p>
                        </div>

                        <div style="background: ${data.inInsolvency ? 'rgba(239,68,68,0.08)' : 'var(--sf-02)'}; border: 1px solid ${data.inInsolvency ? 'rgba(239,68,68,0.2)' : 'var(--border-glass)'}; border-radius: 12px; padding: 15px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
                                <span style="font-size: 1.2rem;">❌</span>
                                <h4 style="margin: 0; color: ${data.inInsolvency ? '#f87171' : 'white'};">Insolvence (ISIR)</h4>
                            </div>
                            <p style="font-size: 0.85rem; margin: 0; color: ${data.inInsolvency ? '#fca5a5' : 'var(--text-muted)'};">
                                ${data.inInsolvency ? `<b>NALEZEN ZÁZNAM!</b><br>Sp. zn.: ${data.insolvencyCase}<br>Stav: ${data.insolvencyStatus}` : 'Subjekt momentálně není v úpadku ani v insolvenčním řízení.'}
                            </p>
                        </div>

                        <div style="background: ${(!ceeUnavail && data.cee.activeExecutions > 0) ? 'rgba(245,158,11,0.08)' : 'var(--sf-02)'}; border: 1px solid ${(!ceeUnavail && data.cee.activeExecutions > 0) ? 'rgba(245,158,11,0.2)' : 'var(--border-glass)'}; border-radius: 12px; padding: 15px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;">
                                <span style="font-size: 1.2rem;">⚠️</span>
                                <h4 style="margin: 0; color: ${(!ceeUnavail && data.cee.activeExecutions > 0) ? '#fbbf24' : 'white'};">Exekuce (CEE)</h4>
                                ${ceeUnavail ? '<span style="font-size: 0.62rem; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; color: #fca5a5; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.35); border-radius: 999px; padding: 2px 8px;">Bez přístupu</span>' : ''}
                            </div>
                            <p style="font-size: 0.85rem; margin: 0; color: ${(!ceeUnavail && data.cee.activeExecutions > 0) ? '#fde047' : 'var(--text-muted)'};">
                                ${ceeUnavail
                                    ? 'Vyžaduje placený přístup do CEE (Exekutorská komora) — není k dispozici. Žádná data se negenerují.'
                                    : (data.cee.activeExecutions > 0 ? `<b>POZOR: ${data.cee.activeExecutions} EXEKUCE!</b>${data.cee.totalAmount != null ? `<br>Celková vymáhaná jistina: ${data.cee.totalAmount.toLocaleString('cs-CZ')} Kč.` : ''}` : 'Subjekt nemá evidovány žádné aktivní exekuce.')}
                            </p>
                            ${data.cee.disclaimer ? `<p style="font-size: 0.72rem; margin: 8px 0 0; color: var(--text-muted); font-style: italic;">${data.cee.disclaimer}</p>` : ''}
                        </div>

                        <div style="background: ${(!katUnavail && data.katastr.hasPlomba) ? 'rgba(239,68,68,0.08)' : 'var(--sf-02)'}; border: 1px solid ${(!katUnavail && data.katastr.hasPlomba) ? 'rgba(239,68,68,0.2)' : 'var(--border-glass)'}; border-radius: 12px; padding: 15px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;">
                                <span style="font-size: 1.2rem;">🏡</span>
                                <h4 style="margin: 0; color: ${(!katUnavail && data.katastr.hasPlomba) ? '#f87171' : 'white'};">Katastr nemovitostí</h4>
                                ${katUnavail ? '<span style="font-size: 0.62rem; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; color: #fca5a5; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.35); border-radius: 999px; padding: 2px 8px;">Bez přístupu</span>' : ''}
                            </div>
                            <p style="font-size: 0.85rem; margin: 0; color: var(--text-muted);">
                                ${katUnavail
                                    ? 'Vyžaduje registrovaný/placený přístup do Katastru (ČÚZK) — není k dispozici. Žádná data se negenerují.'
                                    : `${data.katastr.propertiesCount > 0 ? `Vlastnictví nemovitostí: <b>ANO</b><br>` : 'Nemovitosti: Bez přímého zápisu<br>'}${data.katastr.hasPlomba ? '⚠️ <span style="color: #f87171; font-weight: bold;">DETEKOVÁNA PLOMBA (probíhá změna práv!)</span>' : 'Plomby / Zástavní práva: Bez omezení'}`}
                            </p>
                            ${data.katastr.disclaimer ? `<p style="font-size: 0.72rem; margin: 8px 0 0; color: var(--text-muted); font-style: italic;">${data.katastr.disclaimer}</p>` : ''}
                        </div>
                    </div>
                </div>
            `;
            
            // Dynamic event binding to avoid inline JSON parsing errors
            document.getElementById('btn-save-registry-report').addEventListener('click', () => {
                this.saveRegistryReport({ ico: data.ico, name: data.name, reportText });
            });
            
            document.getElementById('btn-send-registry-report').addEventListener('click', () => {
                this.sendTextToLexisEditor(reportText, `Prověrka ${data.name} (${data.ico})`);
            });
            
            resultsPanel.style.display = 'flex';
        } catch (err) {
            alert("❌ Nepodařilo se dokončit lustraci: " + err.message);
        } finally {
            loader.style.display = 'none';
            btn.disabled = false;
        }
    },

    async saveRegistryReport(reportData) {
        try {
            const res = await fetch(`${this.apiBase}/registries/save-report`, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(reportData)
            });
            const data = await res.json();
            
            if (data.success) {
                alert(`✓ Prověrka subjektu "${reportData.name}" byla úspěšně uložena do spisu jako soubor: \n${data.fileName}\n\nAI ji ihned začne používat jako kontext v sémantické paměti a RAG!`);
                await this.loadInbox();
                await this.checkRagStatus();
            } else {
                alert("❌ Nepodařilo se uložit prověrku: " + (data.error || "Neznámá chyba"));
            }
        } catch (err) {
            alert("❌ Chyba připojení: " + err.message);
        }
    }

});
