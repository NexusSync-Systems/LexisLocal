// app-inbox.js — část dashboardu vytažená z app.js (prototype-mixin, beze změny chování).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
// Escaper pro JS-řetězec uvnitř HTML atributu (onclick) — obrana proti injection.
function _lexEscJsAttr(v){return String(v==null?'':v).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

Object.assign(LexisLocalApp.prototype, {

    renderOverviewAgents(agentIds) {
        const listEl = document.getElementById('agents-list');
        if (!listEl) return;
        
        // Rich definitions matching backend server configuration
        const definitions = {
            resersnik: {
                name: "Rešeršník",
                emoji: "📚",
                role: "Právní analýzy",
                desc: "Specializovaný koncipient provádějící rešerše nad českou legislativou a vyhledávající relevantní judikáty Nejvyššího soudu ČR."
            },
            stylista: {
                name: "Stylista",
                emoji: "✍️",
                role: "Style Cloning",
                desc: "Dokonale klonuje advokátův osobitý tón a styl psaní. Přepisuje text do elegantní a autoritativní advokátní češtiny."
            },
            kontrolor: {
                name: "Kontrolor",
                emoji: "⚖️",
                role: "Audit a rizika",
                desc: "Působí jako protihráč a oponent. Vyhledává logické trhliny ve smlouvách, neurčitosti a slabá místa v právní argumentaci."
            },
            sekretarka: {
                name: "Sekretářka",
                emoji: "⏰",
                role: "Kancelářská agenda",
                desc: "Spravuje a organizuje lhůty k vyjádření, sestavuje úkoly ze spisů, připravuje doložky a formátuje odpovědi pro klienty."
            },
            spisovatel: {
                name: "Spisovatel",
                emoji: "📝",
                role: "Draftování dokumentů",
                desc: "Sestavuje žaloby, smlouvy, odvolání a další právní dokumenty na základě Vašeho zadání a citlivě zapracovává Vaše připomínky."
            }
        };

        const ICONS = {
            resersnik:'<svg viewBox="0 0 24 24"><path d="M12 7v14"/><path d="M3 5a2 2 0 0 1 2-2h5v16H5a2 2 0 0 0-2 2z"/><path d="M21 5a2 2 0 0 0-2-2h-5v16h5a2 2 0 0 1 2 2z"/></svg>',
            stylista:'<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
            kontrolor:'<svg viewBox="0 0 24 24"><path d="M12 3v18M7 21h10"/><path d="M5 7l14-2"/><path d="M5 7 2 13a3 3 0 0 0 6 0zM19 5l3 6a3 3 0 0 1-6 0z"/></svg>',
            sekretarka:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
            spisovatel:'<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v5h5M8 13h8M8 17h6"/></svg>'
        };
        let html = '';
        agentIds.forEach(id => {
            const def = definitions[id] || { name: id, emoji: "🤖", role: "AI Asistent", desc: "Aktivní agent swarmu." };
            html += `
                <div class="agent-card glass">
                    <div class="agent-card-header">
                        <div class="agent-avatar">${ICONS[id] || escapeHtml(def.emoji)}</div>
                        <div class="agent-info">
                            <h4>${escapeHtml(def.name)}</h4>
                            <span>${escapeHtml(def.role)}</span>
                        </div>
                    </div>
                    <p>${escapeHtml(def.desc)}</p>
                </div>
            `;
        });
        
        listEl.innerHTML = html;
    },

    async loadInbox() {
        try {
            const res = await fetch(`${this.apiBase}/inbox/all`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            this.inbox = data.inbox || [];
            
            // Set unread badge in sidebar
            const unreadCount = this.inbox.filter(f => f.status === 'unread').length;
            const badgeEl = document.getElementById('inbox-badge');
            if (badgeEl) {
                if (unreadCount > 0) {
                    badgeEl.textContent = unreadCount;
                    badgeEl.style.display = 'inline-block';
                } else {
                    badgeEl.style.display = 'none';
                }
            }

            // Set counter text
            const countText = document.getElementById('inbox-count-text');
            if (countText) {
                countText.textContent = `Nalezeno ${this.inbox.length} dokumentů (z toho ${unreadCount} nových)`;
            }

            this.renderInbox();
        } catch (e) {
            console.error("Chyba načítání inboxu:", e);
        }
    },

    renderInbox() {
        const container = document.getElementById('inbox-container');
        if (!container) return;

        // Get filter state
        const activeFilterBtn = document.querySelector('.filter-btn.active');
        const filter = activeFilterBtn ? activeFilterBtn.getAttribute('data-filter') : 'all';

        // Filter list
        if (filter === 'emails') {
            const countText = document.getElementById('inbox-count-text');
            if (countText) {
                countText.textContent = `Nalezeno ${this.emailTasks.length} e-mailových úkolů`;
            }
            this.renderEmailTasks();
            return;
        }

        let filtered = this.inbox;
        if (filter === 'unread') {
            filtered = this.inbox.filter(f => f.status === 'unread');
        } else if (filter === 'read') {
            filtered = this.inbox.filter(f => f.status === 'read');
        }

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📁</div>
                    <h3>Žádné spisy v této kategorii</h3>
                    <p>Vložte spisy do složky na Vaší ploše a LexisLocal je ihned zanalyzuje.</p>
                </div>
            `;
            return;
        }

        // Bind filter button triggers once
        document.querySelectorAll('.filter-btn').forEach(btn => {
            if (!btn.dataset.bound) {
                btn.dataset.bound = "true";
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.renderInbox();
                });
            }
        });

        // Group files by caseNumber (spisová značka)
        const groups = {};
        // Dokumenty BEZ zjištěné sp. zn. se NESMÍ slévat do jednoho „spisu“ — dřív
        // nesouvisející e-mail, smlouva a dopis skončily pod „Neznámá sp. zn.“ se
        // sdílenými (cizími) účastníky a lhůtou. Každý takový dokument = vlastní skupina.
        const hasRealCaseNo = cn => !!cn && !/^(nezn[aá]m|nezji[sš]t|bez sp)/i.test(String(cn).trim());
        filtered.forEach(doc => {
            const caseNum = hasRealCaseNo(doc.caseNumber) ? doc.caseNumber : `Bez sp. zn. — ${doc.fileName}`;
            if (!groups[caseNum]) {
                groups[caseNum] = [];
            }
            groups[caseNum].push(doc);
        });

        let html = '';
        Object.keys(groups).forEach(caseNum => {
            const files = groups[caseNum];
            const caseNumSanitized = caseNum.replace(/[^a-zA-Z0-9-_]/g, '_');
            
            // Gather group-wide metadata
            const firstWithPlaintiff = files.find(f => f.plaintiff && f.plaintiff !== 'Nezjištěn');
            const groupPlaintiff = firstWithPlaintiff ? firstWithPlaintiff.plaintiff : "Nezjištěn";
            
            const firstWithDefendant = files.find(f => f.defendant && f.defendant !== 'Nezjištěn');
            const groupDefendant = firstWithDefendant ? firstWithDefendant.defendant : "Nezjištěn";
            
            const firstWithSeat = files.find(f => f.verifiedSeat);
            const groupVerifiedSeat = firstWithSeat ? firstWithSeat.verifiedSeat : null;
            
            const hasInsolvency = files.some(f => f.inInsolvency);
            const firstWithInsolCase = files.find(f => f.insolvencyCase);
            const insolvencyCase = firstWithInsolCase ? firstWithInsolCase.insolvencyCase : null;

            // Gather closest deadline
            const filesWithDeadline = files.filter(f => f.deadlineDays && f.deadlineDate);
            let closestFile = null;
            if (filesWithDeadline.length > 0) {
                // Nejbližší = nejdřívější DATUM konce lhůty (ne nejkratší délka lhůty).
                closestFile = filesWithDeadline.reduce((closest, f) => {
                    return (!closest || String(f.deadlineDate) < String(closest.deadlineDate)) ? f : closest;
                }, null);
            }

            const insolWarning = hasInsolvency ? `
                <span class="insolvency-warning-badge" style="margin-left: 10px;">⚠️ INSOLVENCE SUBJEKTU</span>
            ` : '';

            // Group deadline html
            let deadlineHtml = '';
            if (closestFile) {
                // Kritické = do konce lhůty zbývají ≤ 3 dny (dřív se brala délka lhůty).
                const daysLeft = Math.ceil((new Date(closestFile.deadlineDate + 'T23:59:59') - new Date()) / 86400000);
                const isCritical = daysLeft <= 3;
                const criticalClass = isCritical ? 'critical' : '';
                const warningEmoji = isCritical ? '🚨' : '📅';
                deadlineHtml = `
                    <div class="deadline-countdown ${criticalClass}">
                        <span>${warningEmoji} Lhůta: ${escapeHtml(String(closestFile.deadlineDays))} dnů</span>
                    </div>
                    <span class="subtext">Termín: ${new Date(closestFile.deadlineDate).toLocaleDateString('cs-CZ')}</span>
                    <button class="btn btn-secondary" onclick="window.appInstance.downloadIcsFile('${_lexEscJsAttr(caseNum)}', '${_lexEscJsAttr(groupPlaintiff)}', '${_lexEscJsAttr(groupDefendant)}', '${_lexEscJsAttr(closestFile.deadlineDate)}')" style="margin-top: 10px; width: 100%; font-size: 0.72rem; padding: 5px 8px; display: flex; align-items: center; justify-content: center; gap: 4px;">
                        📅 Do kalendáře (.ics)
                    </button>
                `;
            } else {
                deadlineHtml = `<span class="subtext text-muted">Bez lhůty</span>`;
            }

            const verifiedAddr = groupVerifiedSeat ? `
                <br><span style="font-size: 0.75rem; color: var(--accent-green);">✓ Ověřené sídlo ARES: ${escapeHtml(groupVerifiedSeat)}</span>
            ` : '';

            // Generate HTML list for each file in this case group
            let filesHtml = '';
            files.forEach(doc => {
                const isUnread = doc.status === 'unread';
                filesHtml += `
                    <div class="case-file-row" style="display: flex; justify-content: space-between; align-items: center; background: var(--sf-02); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-glass);">
                        <div style="display: flex; align-items: center; gap: 10px; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%;">
                            <span>${doc.wasOcr ? '🔍' : '📄'}</span>
                            <span style="font-weight: 500; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(doc.fileName)}</span>
                            ${isUnread ? '<span style="width: 6px; height: 6px; background-color: var(--accent-red); border-radius: 50%; display: inline-block; flex-shrink: 0;"></span>' : ''}
                            ${doc.wasOcr ? '<span style="font-size: 0.65rem; background: rgba(139,92,246,0.15); color: #a78bfa; border: 1px solid rgba(139,92,246,0.25); border-radius: 4px; padding: 1px 5px; flex-shrink: 0;">OCR</span>' : ''}
                            ${_lexSignatureBadge(doc.signatures)}
                            ${doc.isds ? `<span title="${escapeHtml('Datová schránka · zpráva ' + (doc.isds.dmID || '') + (doc.isds.sender ? ' · od: ' + doc.isds.sender : '') + (doc.isds.annotation ? ' · ' + doc.isds.annotation : ''))}" class="ds-badge" style="flex-shrink: 0;">📨 Datová schránka · doručeno ${escapeHtml(doc.isds.deliveryDate ? new Date(doc.isds.deliveryDate).toLocaleDateString('cs-CZ') : '?')}${doc.isds.deliveryExact === false ? ' (odhad)' : ''}</span>` : ''}
                        </div>
                        <div style="display: flex; gap: 6px;">
                            <button class="btn btn-secondary" onclick="window.appInstance.viewSpisContent('${_lexEscJsAttr(doc.relativePath || doc.fileName)}')" style="padding: 4px 8px; font-size: 0.7rem;">
                                📖 Zobrazit
                            </button>
                            ${isUnread ? `
                                <button class="btn btn-secondary" onclick="window.appInstance.markRead('${_lexEscJsAttr(doc.relativePath || doc.fileName)}')" style="padding: 4px 8px; font-size: 0.7rem;">
                                    ✓ Vyřídit
                                </button>
                            ` : ''}
                            <button class="btn btn-danger" title="Odstranit dokument z doručené pošty" aria-label="Odstranit dokument" onclick="window.appInstance.deleteSpis('${_lexEscJsAttr(doc.relativePath || doc.fileName)}')" style="padding: 4px 8px; font-size: 0.7rem;">
                                🗑️ Odstranit
                            </button>
                        </div>
                    </div>
                    ${(doc.action || doc.summary) ? `<div style="font-size: 0.75rem; color: var(--text-muted); padding: 2px 12px 6px; line-height: 1.45;">${doc.action ? `<b style="color: var(--text-primary);">➡️ ${escapeHtml(doc.action)}</b><br>` : ''}${escapeHtml(String(doc.summary || '').slice(0, 320))}</div>` : ''}
                `;
            });

            const isExpanded = this.expandedTimelines && this.expandedTimelines.has(caseNum);
            const timelineDisplay = isExpanded ? 'block' : 'none';
            const btnText = isExpanded ? '✕ Skrýt historii' : '⏱️ Časová osa spisu';
            const btnStyle = isExpanded 
                ? 'background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.25); color: #f87171;' 
                : 'background: rgba(59, 130, 246, 0.08); border-color: rgba(59, 130, 246, 0.25); color: #60a5fa;';

            html += `
                <div class="inbox-card glass" style="display: flex; flex-direction: row; gap: 20px; padding: 25px; margin-bottom: 15px;">
                    <div class="inbox-avatar" style="font-size: 1.5rem; background: var(--sf-03); border: 1px solid var(--border-glass); width: 54px; height: 54px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                        📂
                    </div>
                    <div class="inbox-info" style="flex-grow: 1;">
                        <div class="inbox-info-header" style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                            <h4 style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">${caseNum.startsWith('Bez sp. zn. — ') ? 'Dokument bez sp. zn.: ' + escapeHtml(caseNum.slice(14)) : 'Spis sp. zn.: ' + escapeHtml(caseNum)}</h4>
                            ${insolWarning}
                        </div>
                        <div class="parties-text" style="font-size: 0.88rem; color: var(--text-secondary); margin-bottom: 12px;">
                            ${(groupPlaintiff === 'Nezjištěn' && groupDefendant === 'Nezjištěn')
                                ? (/^(Bez sp\. zn\.|Neznámá sp\. zn\.)/.test(caseNum)
                                    ? '<span style="opacity:.75;">Mimosoudní dokument — účastníci řízení nezjištěni</span>'
                                    : '<span style="opacity:.75;">Účastníci řízení zatím nezjištěni</span>')
                                : `<strong>Žalobce:</strong> ${escapeHtml(groupPlaintiff)} | <strong>Žalovaný:</strong> ${escapeHtml(groupDefendant)}`}
                            ${verifiedAddr}
                        </div>
                        
                        <div class="case-files-explorer" style="margin-top: 15px; border-top: 1px solid var(--border-glass); padding-top: 15px;">
                            <h5 style="font-size: 0.82rem; font-weight: 600; margin-bottom: 8px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">📁 Obsah spisu (${files.length} dokumentů):</h5>
                            <div style="display: flex; flex-direction: column; gap: 6px;">
                                ${filesHtml}
                            </div>
                            
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px;">
                                <button class="btn btn-secondary" onclick="window.appInstance.analyzeEntireCase('${_lexEscJsAttr(caseNum)}')" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 0.78rem; padding: 8px 12px;">
                                    🤖 Analyzovat AI (${files.length} dok.)
                                </button>
                                <button id="btn-timeline-toggle-${caseNumSanitized}" class="btn btn-secondary" onclick="window.appInstance.showCaseTimeline('${_lexEscJsAttr(caseNum)}')" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 0.78rem; padding: 8px 12px; ${btnStyle}">
                                    ${btnText}
                                </button>
                            </div>

                            <!-- Inline Collapsible Timeline -->
                            <div class="case-timeline-collapse" id="timeline-collapse-${caseNumSanitized}" style="display: ${timelineDisplay}; margin-top: 15px; border-top: 1px dashed var(--border-glass); padding-top: 15px;">
                                <div class="inline-timeline-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                    <div class="inline-timeline-title" style="font-size: 0.85rem; font-weight: 700; color: var(--accent-blue); display: flex; align-items: center; gap: 6px;">
                                        ⏱️ Historie a časová osa spisu
                                    </div>
                                    <button class="btn btn-secondary" onclick="window.appInstance.showCaseTimeline('${_lexEscJsAttr(caseNum)}')" style="padding: 2px 8px; font-size: 0.7rem;">✕ Zavřít</button>
                                </div>
                                <div class="timeline-events-inline-list" id="timeline-events-${caseNumSanitized}" style="display: flex; flex-direction: column; gap: 12px;">
                                    <!-- Populate via JS -->
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="inbox-deadline" style="width: 180px; display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-start; text-align: right; flex-shrink: 0; border-left: 1px solid var(--border-glass); padding-left: 20px;">
                        ${deadlineHtml}
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;

        // Trigger fetch for any inline timelines that were already expanded
        if (this.expandedTimelines) {
            this.expandedTimelines.forEach(caseNum => {
                this.loadInlineTimelineData(caseNum);
            });
        }
    },

    async markRead(fileName) {
        try {
            const res = await fetch(`${this.apiBase}/inbox/mark-read`, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ fileName })
            });
            const data = await res.json();
            if (data.success) {
                await this.loadInbox();
            }
        } catch (e) {
            alert("Chyba při označování za vyřízené: " + e.message);
        }
    },

    downloadIcsFile(caseNumber, plaintiff, defendant, deadlineDate) {
        try {
            const uid = 'lexis_' + Date.now() + '@lexislocal.lan';
            const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            
            // Format YYYY-MM-DD to YYYYMMDD
            const dateStr = deadlineDate.replace(/-/g, '');
            
            const icsContent = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//LexisLocal AI//Legal Workstation//CS',
                'BEGIN:VEVENT',
                `UID:${uid}`,
                `DTSTAMP:${now}`,
                `DTSTART;VALUE=DATE:${dateStr}`,
                `DTEND;VALUE=DATE:${dateStr}`,
                `SUMMARY:⚖️ Lhůta sp. zn. ${caseNumber}`,
                `DESCRIPTION:Lhůta k vyjádření zjištěná systémem LexisLocal.\\n\\nSpis: ${caseNumber}\\nŽalobce: ${plaintiff}\\nŽalovaný: ${defendant}`,
                'STATUS:CONFIRMED',
                'SEQUENCE:0',
                'BEGIN:VALARM',
                'TRIGGER:-PT9H', // Notification at 9:00 AM on the day of the event
                'ACTION:DISPLAY',
                'DESCRIPTION:Reminder',
                'END:VALARM',
                'END:VEVENT',
                'END:VCALENDAR'
            ].join('\r\n');
            
            const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `lhuta_${caseNumber.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')}.ics`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            alert(`📅 Lhůta pro spis ${caseNumber} byla úspěšně vyexportována!\n\nSoubor .ics se stáhl do Vašeho počítače. Poklepáním na něj ho ihned přidáte do svého Outlooku nebo systémového Kalendáře.`);
        } catch (e) {
            console.error("Chyba při stahování kalendáře:", e);
            alert("❌ Nepodařilo se vygenerovat kalendář: " + e.message);
        }
    },

    async deleteSpis(fileName) {
        if (!await LexisUI.confirm(`Opravdu si přejete kompletně smazat spis „${fileName}“ ze seznamu i z disku?`)) return;
        
        try {
            const res = await fetch(`${this.apiBase}/inbox/delete`, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ fileName })
            });
            const data = await res.json();
            if (data.success) {
                await this.loadInbox();
            }
        } catch (e) {
            alert("Chyba při mazání souboru: " + e.message);
        }
    },

    async viewSpisContent(fileName) {
        const doc = this.inbox.find(f => f.fileName === fileName);
        this.viewedSpisCaseNumber = doc ? doc.caseNumber : "Neznámá sp. zn.";
        this.viewedSpisName = fileName;
        this.viewedSpisContent = "";
        
        const modal = document.getElementById('spis-modal');
        const titleEl = document.getElementById('modal-spis-title');
        const textEl = document.getElementById('modal-spis-text');
        
        if (titleEl) titleEl.textContent = `📄 Načítám obsah: ${fileName}`;
        if (textEl) textEl.textContent = "Načítám obsah spisu z disku...";
        if (modal) modal.style.display = 'flex';
        
        try {
            const res = await fetch(`${this.apiBase}/inbox/content?fileName=${encodeURIComponent(fileName)}`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.error) {
                if (textEl) textEl.textContent = `❌ Chyba: ${data.error}`;
            } else {
                this.viewedSpisContent = data.content;
                if (titleEl) titleEl.textContent = `📄 Spis: ${fileName} [sp. zn. ${this.viewedSpisCaseNumber}]`;
                if (textEl) textEl.textContent = data.content || "Dokument je prázdný.";
            }
        } catch (e) {
            if (textEl) textEl.textContent = `❌ Chyba při načítání souboru: ${e.message}`;
        }
    },

    closeSpisModal() {
        const modal = document.getElementById('spis-modal');
        if (modal) modal.style.display = 'none';
        this.viewedSpisContent = "";
        this.viewedSpisName = "";
    },

    sendSpisToChat() {
        if (!this.viewedSpisContent) {
            alert("Není načten žádný platný obsah spisu k analýze.");
            return;
        }
        
        const chatTextarea = document.getElementById('chat-textarea');
        if (chatTextarea) {
            chatTextarea.value = `Zanalyzuj mi prosím spis sp. zn. ${this.viewedSpisCaseNumber} (${this.viewedSpisName}):\n\n${this.viewedSpisContent}\n\n`;
            chatTextarea.style.height = 'auto';
            chatTextarea.style.height = (chatTextarea.scrollHeight + 10) + 'px';
            chatTextarea.focus();
            
            const agentSelect = document.getElementById('chat-agent-select');
            if (agentSelect) {
                agentSelect.value = 'resersnik';
            }
        }
        
        this.closeSpisModal();
        this.switchTab('chat');
    },

    async sendSpisToLexisEditor() {
        if (!this.viewedSpisContent) {
            alert("Není načten žádný platný obsah spisu k odeslání.");
            return;
        }
        await this.sendTextToLexisEditor(this.viewedSpisContent, `Spis ${this.viewedSpisName}`);
    },

    async sendTextToLexisEditor(text, title = "Import z LexisLocal") {
        try {
            console.log("🔌 Odesílám text do LexisEditoru na portu 3300...");
            
            // Format HTML content to be loaded in the Quill Editor elegantly
            const formattedHtml = `<h3>📝 ${escapeHtml(title)}</h3>
<p><i>Importováno z Vaší sémantické paměti LexisLocal dne ${new Date().toLocaleString('cs-CZ')}:</i></p>
<hr>
<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;

            const res = await fetch("http://localhost:3300/api/import", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    text: formattedHtml,
                    title: title,
                    source: "LexisLocal Integration Hub"
                })
            });
            
            const data = await res.json();
            if (data.success) {
                alert(`✓ Text byl okamžitě přenesen a importován do rozepsaného dokumentu v LexisEditoru!`);
            } else {
                alert("❌ Nepodařilo se importovat text do LexisEditoru: " + (data.error || "Neznámá chyba"));
            }
        } catch (err) {
            console.warn("⚠️ Připojení k LexisEditoru selhalo:", err);
            alert("⚠️ Nepodařilo se spojit s LexisEditorem na portu 3300.\n\nUjistěte se prosím, že je program LexisEditor spuštěný, a zkuste to znovu!");
        }
    },

    async analyzeEntireCase(caseNum) {
        const SOLO = 'Bez sp. zn. — ';
        const groupFiles = String(caseNum).startsWith(SOLO)
            ? this.inbox.filter(f => f.fileName === String(caseNum).slice(SOLO.length))
            : this.inbox.filter(f => f.caseNumber === caseNum);
        if (groupFiles.length === 0) {
            alert("Ve spisu nebyly nalezeny žádné dokumenty.");
            return;
        }

        const chatTextarea = document.getElementById('chat-textarea');
        if (chatTextarea) {
            chatTextarea.value = `Probíhá načítání a spojování spisových podkladů...`;
            chatTextarea.focus();
        }

        this.switchTab('chat');

        let combinedContent = "";
        
        try {
            for (const file of groupFiles) {
                const res = await fetch(`${this.apiBase}/inbox/content?fileName=${encodeURIComponent(file.fileName)}`, {
                    headers: this.getHeaders()
                });
                const data = await res.json();
                if (!data.error && data.content) {
                    combinedContent += `--- SOUBOR: ${file.fileName} ---\n${data.content}\n\n`;
                }
            }

            if (chatTextarea) {
                chatTextarea.value = `Zanalyzuj mi prosím kompletní spisové podklady pro spis sp. zn. ${caseNum}:\n\n${combinedContent}\n\n`;
                chatTextarea.style.height = 'auto';
                chatTextarea.style.height = (chatTextarea.scrollHeight + 10) + 'px';
                chatTextarea.focus();
                
                const agentSelect = document.getElementById('chat-agent-select');
                if (agentSelect) {
                    agentSelect.value = 'resersnik';
                }
            }
        } catch (e) {
            alert("Chyba při spojování spisových podkladů: " + e.message);
        }
    },

    async generateTestSpis() {
        const btn = document.getElementById('btn-parse-test');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ Generuji...';
        }
        
        try {
            const res = await fetch(`${this.apiBase}/inbox/parse-test`, { 
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                await this.loadInbox();
                this.switchTab('inbox');
            }
        } catch (e) {
            alert("Chyba při generování testovacího souboru: " + e.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🧪 Generovat testovací spis';
            }
        }
    }

});


// Štítek elektronického podpisu u dokumentu v doručené poště (data z PDF → escapovat).
function _lexSignatureBadge(sig) {
    if (!sig || !sig.signed) return '';
    const esc = (typeof escapeHtml === 'function') ? escapeHtml : (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const lines = (sig.signatures || []).map((s) => {
        const t = s.timestamp ? (s.timestamp.valid ? ', s časovým razítkem' : ', NEPLATNÉ razítko') : ', bez razítka';
        return (s.valid ? '✓ ' : '✗ NEPLATNÝ: ') + (s.signer || 'neznámý podepisující') + ' — ' + (s.level || '') + t;
    });
    lines.push('Důvěryhodnost vydavatele (EU Trusted List) ověřte v Acrobat Readeru.');
    const bad = !!sig.anyInvalid;
    const style = bad
        ? 'background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3);'
        : 'background: rgba(34,197,94,0.12); color: #4ade80; border: 1px solid rgba(34,197,94,0.25);';
    return '<span class="sig-badge" title="' + esc(lines.join('\n')) + '" style="font-size: 0.65rem; ' + style + ' border-radius: 4px; padding: 1px 5px; flex-shrink: 0;">' +
        (bad ? '⚠️ podpis neplatný' : '🔏 podepsáno') + '</span>';
}
if (typeof module !== 'undefined' && module.exports) { module.exports._lexSignatureBadge = _lexSignatureBadge; }
