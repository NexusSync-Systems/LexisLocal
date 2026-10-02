// app-alerts-audit.js — část dashboardu vytažená z app.js (prototype-mixin, beze změny chování).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
Object.assign(LexisLocalApp.prototype, {

    async loadAlerts() {
        try {
            const res = await fetch(`${this.apiBase}/alerts`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            this.renderAlerts(data.alerts || []);
        } catch (err) {
            console.error("⚠️ Nepodařilo se načíst aktivní upozornění:", err.message);
        }
    },

    renderAlerts(alerts) {
        const container = document.getElementById('insolvency-alerts-container');
        if (!container) return;
        
        if (alerts.length === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }
        
        container.innerHTML = alerts.map(alert => `
            <div class="glass" style="border: 1px solid rgba(239, 68, 68, 0.25); background: rgba(239, 68, 68, 0.04); border-radius: 12px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 15px; width: 100%; box-shadow: 0 4px 15px rgba(239, 68, 68, 0.05); margin-bottom: 20px;">
                <div style="display: flex; align-items: center; gap: 14px;">
                    <div style="width: 42px; height: 42px; border-radius: 50%; background: rgba(239, 68, 68, 0.15); display: flex; align-items: center; justify-content: center; position: relative;">
                        <span style="font-size: 1.3rem; animation: pulse 1.8s infinite;">🚨</span>
                    </div>
                    <div>
                        <h4 style="margin: 0; color: #fca5a5; font-size: 0.95rem; font-weight: 700;">
                            DETEKOVÁNA INSOLVENCE: ${alert.name} (IČO: ${alert.ico})
                        </h4>
                        <p style="margin: 4px 0 0 0; color: var(--text-muted); font-size: 0.82rem;">
                            Sledovaný subjekt vstoupil do úpadku. Spisová značka: <b style="color: var(--text-primary);">${alert.caseNumber}</b> | Stav: <span style="color: #fca5a5;">${alert.insolvencyStatus}</span>
                        </p>
                        <p style="margin: 2px 0 0 0; color: var(--text-muted); font-size: 0.75rem;">
                            Související spisy: ${alert.citedFiles.join(', ')}
                        </p>
                    </div>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-secondary" onclick="window.appInstance.sendTextToLexisEditor('${_lexEscJsAttr(`POZOR: Sledovaný subjekt ${alert.name} (IČO: ${alert.ico}) je v INSOLVENCI! Spisová značka: ${alert.caseNumber}, Stav: ${alert.insolvencyStatus}. Bezodkladně přihlaste pohledávky.`)}', 'Insolvenční varování')" style="font-size: 0.8rem; padding: 6px 12px; border: 1px solid var(--border-glass); background: var(--sf-02);">
                        ✍️ Odeslat do Editoru
                    </button>
                    <button class="btn btn-primary" onclick="window.appInstance.dismissAlert('${alert.id}')" style="font-size: 0.8rem; padding: 6px 12px; background: rgba(239, 68, 68, 0.8); border: none;">
                        Skrýt ✕
                    </button>
                </div>
            </div>
        `).join('');
        
        container.style.display = 'block';
    },

    async dismissAlert(alertId) {
        try {
            const res = await fetch(`${this.apiBase}/alerts/dismiss/${alertId}`, {
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                await this.loadAlerts();
            }
        } catch (err) {
            alert("❌ Nepodařilo se skrýt upozornění: " + err.message);
        }
    },

    applyPlaybook(type) {
        const toggle = document.getElementById('toggle-swarm-debate');
        const agent1 = document.getElementById('chat-agent-select');
        const agent2 = document.getElementById('chat-agent-2-select');
        const textarea = document.getElementById('chat-textarea');
        const config2 = document.getElementById('config-agent-2-container');
        
        if (!agent1 || !agent2 || !textarea) return;
        
        // Ensure Swarm Debate toggle is checked
        if (toggle) {
            toggle.checked = true;
            if (config2) config2.style.display = 'block';
        }
        
        let promptText = "";
        
        if (type === 'due-diligence') {
            agent1.value = "spisovatel";
            agent2.value = "kontrolor";
            promptText = `[Sem vložte text smlouvy nebo doložky k analýze]\n\nUdělejte detailní právní audit této smlouvy. Agent 1 (Spisovatel) navrhne optimalizované znění, Agent 2 (Kontrolor) vyhledá skrytá rizika a slabiny pro našeho klienta.`;
        } else if (type === 'litigation') {
            agent1.value = "resersnik";
            agent2.value = "kontrolor";
            promptText = `[Sem popište spor nebo vložte žalobu protistrany]\n\nNavrhněte strategii obhajoby/žalobní argumentace. Agent 1 (Rešeršník) vyhledá relevantní argumenty a judikaturu ze spisu, Agent 2 (Oponent) zpochybní naše tvrzení a ukáže, jak bude reagovat protistrana.`;
        } else if (type === 'explainer') {
            agent1.value = "sekretarka";
            agent2.value = "stylista";
            promptText = `[Sem vložte složité právní vyjádření, rozsudek nebo smlouvu]\n\nPřeveďte tento složitý text do řeči srozumitelné pro laického klienta. Agent 1 (Sekretářka) vysvětlí hlavní podstatu bez právního žargonu, Agent 2 (Stylista) z toho zformuluje přehledný e-mail s odrážkami.`;
        }
        
        textarea.value = promptText;
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight + 10) + 'px'; // auto resize height with padding buffer
        textarea.focus();
        
        // Temporarily highlight the playbook bar buttons
        document.querySelectorAll('.playbook-btn').forEach(btn => {
            btn.style.opacity = '0.6';
        });
        const activeBtn = document.querySelector(`.playbook-btn[onclick*="${type}"]`);
        if (activeBtn) {
            activeBtn.style.opacity = '1';
            activeBtn.style.boxShadow = '0 0 10px rgba(255,255,255,0.15)';
            setTimeout(() => {
                activeBtn.style.boxShadow = 'none';
                document.querySelectorAll('.playbook-btn').forEach(btn => btn.style.opacity = '1');
            }, 1000);
        }
    },

    async runManualInsolvencyCheck() {
        const btn = document.querySelector('button[onclick*="runManualInsolvencyCheck"]');
        let originalText = "";
        if (btn) {
            originalText = btn.innerHTML;
            btn.innerHTML = '<span>🔄</span> Prověřuji spisy...';
            btn.disabled = true;
        }
        
        try {
            const res = await fetch(`${this.apiBase}/alerts/check`, {
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            
            if (data.success) {
                alert(`✓ Hromadná prověrka insolvencí byla dokončena!\n\nPrověřeno unikátních IČO: ${data.checkedCount}\nNalezeno nových úpadků: ${data.newAlertsCount}\n\nPokud byl nalezen nový úpadek, zobrazí se červené varování na Dashboardu.`);
                await this.loadAlerts();
                await this.loadInbox();
            } else {
                alert("❌ Chyba při hromadné kontrole: " + (data.error || "Neznámá chyba"));
            }
        } catch (err) {
            alert("❌ Chyba spojení při hromadné kontrole: " + err.message);
        } finally {
            if (btn) {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        }
    },

    async loadAuditLogs() {
        try {
            const res = await fetch(`${this.apiBase}/audit/logs`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            
            if (data.success) {
                this.auditLogs = data.logs || [];
                this.renderAuditLogs(this.auditLogs);
                this.updateAuditStats(this.auditLogs);
                this.verifyAuditChainBadge();
                this.loadGreenMetricsAndTelemetry();
                this.loadTransparencyLedger();
            } else {
                console.error("❌ Nepodařilo se načíst auditní logy:", data.error);
            }
        } catch (err) {
            console.error("❌ Chyba sítě při načítání auditních logů:", err.message);
        }
    },

    async verifyAuditChainBadge() {
        try {
            const res = await fetch(`${this.apiBase}/audit/verify-chain`, { headers: this.getHeaders() });
            const r = await res.json();
            const anchor = document.getElementById('audit-stat-total');
            if (!anchor) return;
            let badge = document.getElementById('audit-chain-status');
            if (!badge) {
                badge = document.createElement('div');
                badge.id = 'audit-chain-status';
                badge.style.cssText = 'margin:8px 0;font-size:0.85rem;font-weight:600;';
                const host = anchor.closest('div') || anchor.parentElement;
                if (host && host.parentElement) host.parentElement.insertBefore(badge, host);
                else document.body.appendChild(badge);
            }
            if (r && r.ok) {
                badge.innerHTML = `🔒 <span style="color:#22c55e;">Auditní řetěz neporušen</span> <span style="opacity:0.5;">(${r.checked} ověřeno${r.legacy ? ', ' + r.legacy + ' starších' : ''})</span>`;
            } else {
                badge.innerHTML = `⚠️ <span style="color:#ef4444;">Auditní řetěz PORUŠEN</span> <span style="opacity:0.6;">(${escapeHtml((r && r.reason) || 'neznámo')}${(r && r.brokenAt != null) ? ', záznam #' + r.brokenAt : ''})</span>`;
            }
        } catch (e) { /* tiché — badge se nezobrazí */ }
    },

    updateAuditStats(logs) {
        const totalEl = document.getElementById('audit-stat-total');
        const ocrEl = document.getElementById('audit-stat-ocr');
        const aiEl = document.getElementById('audit-stat-ai');
        const durationEl = document.getElementById('audit-stat-duration');

        if (!totalEl) return;

        const totalCount = logs.length;
        const ocrCount = logs.filter(l => {
            const op = l.operation.toLowerCase();
            return op.includes('ocr') || op.includes('dokument');
        }).length;
        const aiCount = logs.filter(l => {
            const op = l.operation.toLowerCase();
            return op.includes('ai') || op.includes('swarm');
        }).length;
        
        const totalDurationMs = logs.reduce((sum, l) => {
            return sum + (l.details && l.details.durationMs ? l.details.durationMs : 0);
        }, 0);
        const totalDurationS = (totalDurationMs / 1000).toFixed(1);

        totalEl.textContent = totalCount;
        ocrEl.textContent = ocrCount;
        aiEl.textContent = aiCount;
        durationEl.textContent = `${totalDurationS}s`;
    },

    renderAuditLogs(logs) {
        const tbody = document.getElementById('audit-log-table-body');
        if (!tbody) return;

        if (logs.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 30px; opacity: 0.6;">Zatím nebyly zaznamenány žádné provozní úkony.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = logs.map(log => {
            const date = new Date(log.timestamp);
            const formattedDate = date.toLocaleString('cs-CZ', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            // Premium colored badges for operations
            let badgeClass = 'badge-system';
            if (log.operation.includes('OCR')) badgeClass = 'badge-ocr';
            else if (log.operation.includes('AI') || log.operation.includes('Swarm')) badgeClass = 'badge-ai';
            else if (log.operation.includes('Dokument') || log.operation.includes('soubor') || log.operation.includes('FileWatcher')) badgeClass = 'badge-watcher';

            // Custom details parsing
            let detailsHtml = '';
            if (log.details) {
                if (log.details.durationMs !== undefined) {
                    detailsHtml += `<span style="color: #fb7185; font-weight: 500;">⚡ ${log.details.durationMs}ms</span>`;
                }
                if (log.details.charactersCount !== undefined) {
                    detailsHtml += detailsHtml ? ' | ' : '';
                    detailsHtml += `<span style="opacity:0.8;">📄 ${log.details.charactersCount} zn.</span>`;
                }
                if (log.details.model) {
                    detailsHtml += detailsHtml ? ' | ' : '';
                    detailsHtml += `<span style="color: var(--accent-blue);">🤖 ${log.details.model}</span>`;
                }
                if (log.details.successCount !== undefined) {
                    detailsHtml += detailsHtml ? ' | ' : '';
                    detailsHtml += `<span style="color: var(--accent-green);">✓ ${log.details.successCount} spisy</span>`;
                }
            }
            if (!detailsHtml) detailsHtml = '<span style="opacity: 0.5;">—</span>';

            return `
                <tr style="border-bottom: 1px solid var(--border-glass); hover: background-color: var(--sf-01);">
                    <td style="padding: 12px; font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; opacity: 0.9;">${formattedDate}</td>
                    <td style="padding: 12px;"><span style="font-weight: 500; opacity: 0.8;">${log.user}</span></td>
                    <td style="padding: 12px;"><span class="audit-badge ${badgeClass}">${log.operation}</span></td>
                    <td style="padding: 12px; font-weight: 500;">${log.target}</td>
                    <td style="padding: 12px; font-size: 0.85rem;">${detailsHtml}</td>
                </tr>
            `;
        }).join('');
    },

    async clearAuditLogs() {
        try {
            const res = await fetch(`${this.apiBase}/audit/clear`, {
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            
            if (data.success) {
                this.auditLogs = [];
                this.renderAuditLogs([]);
                this.updateAuditStats([]);
                alert("✓ Provozní auditní logy byly kompletně vymazány.");
            } else {
                alert("❌ Chyba při mazání logů: " + data.error);
            }
        } catch (err) {
            alert("❌ Chyba sítě při mazání logů: " + err.message);
        }
    },

    filterAuditLogs() {
        const queryInput = document.getElementById('audit-search-input');
        if (!queryInput) return;

        const query = queryInput.value.toLowerCase().trim();
        if (!query) {
            this.renderAuditLogs(this.auditLogs);
            return;
        }

        const filtered = this.auditLogs.filter(log => {
            const timeStr = new Date(log.timestamp).toLocaleString('cs-CZ').toLowerCase();
            const userStr = log.user.toLowerCase();
            const opStr = log.operation.toLowerCase();
            const targetStr = log.target.toLowerCase();
            
            // Render details into string for searching
            let detailsStr = '';
            if (log.details) {
                detailsStr = JSON.stringify(log.details).toLowerCase();
            }

            return timeStr.includes(query) || 
                   userStr.includes(query) || 
                   opStr.includes(query) || 
                   targetStr.includes(query) ||
                   detailsStr.includes(query);
        });

        this.renderAuditLogs(filtered);
    }

});
