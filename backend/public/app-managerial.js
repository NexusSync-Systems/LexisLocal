// app-managerial.js — část dashboardu vytažená z app.js (prototype-mixin, beze změny chování).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
Object.assign(LexisLocalApp.prototype, {

    async loadTimeTrackingTab() {
        try {
            console.log("🕒 Načítám Time-tracking tab...");
            
            // Get today's activity stats
            const resToday = await fetch(`${this.apiBase}/activity/today`, { headers: this.getHeaders() });
            const dataToday = await resToday.json();

            // Get generated timesheets
            const resTimesheets = await fetch(`${this.apiBase}/activity/timesheets`, { headers: this.getHeaders() });
            const dataTimesheets = await resTimesheets.json();

            if (dataToday.success) {
                this.renderTodayActivities(dataToday.aggregated, dataToday.rawLogsCount);
            }
            if (dataTimesheets.success) {
                this.renderTimesheetsHistory(dataTimesheets.timesheets);
            }
        } catch (err) {
            console.error("❌ Selhalo načítání Time-tracking tab:", err);
        }
    },

    renderTodayActivities(aggregated, rawCount) {
        const totalHoursEl = document.getElementById('time-stat-total');
        const countEl = document.getElementById('time-stat-count');
        const listEl = document.getElementById('time-today-activity-list');

        let totalHours = 0;
        aggregated.forEach(item => totalHours += item.totalHours);

        if (totalHoursEl) totalHoursEl.textContent = `${totalHours.toFixed(1)} hod`;
        if (countEl) countEl.textContent = rawCount;

        if (!listEl) return;

        if (aggregated.length === 0) {
            listEl.innerHTML = `<div style="text-align: center; opacity: 0.6; padding: 20px;">Dnes nebyla zaznamenána žádná aktivita v editoru.</div>`;
            return;
        }

        listEl.innerHTML = aggregated.map(item => `
            <div class="glass" style="padding: 10px 15px; border-radius: 8px; background: var(--sf-02); border: 1px solid var(--border-glass); font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong style="color: var(--text-primary); display: block; margin-bottom: 2px;">${escapeHtml(item.documentName)}</strong>
                    <span style="opacity: 0.7; font-size: 0.75rem;">Primární úkon: <code>${escapeHtml(item.primaryAction)}</code></span>
                </div>
                <div style="text-align: right;">
                    <strong style="color: var(--accent-gold); font-size: 0.9rem; display: block;">${item.totalHours.toFixed(2)} hod</strong>
                    <span style="opacity: 0.7; font-size: 0.7rem;">(Změn: ${escapeHtml(String(item.saves))})</span>
                </div>
            </div>
        `).join('');
    },

    renderTimesheetsHistory(timesheets) {
        const listEl = document.getElementById('timesheets-history-list');
        if (!listEl) return;

        if (timesheets.length === 0) {
            listEl.innerHTML = `<div style="text-align: center; opacity: 0.6; padding: 30px;">Zatím nebyly sestaveny žádné výkazy.</div>`;
            return;
        }

        // Sort descending
        const sorted = [...timesheets].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

        listEl.innerHTML = sorted.map(ts => `
            <div class="glass" style="padding: 18px; border-radius: 12px; background: var(--sf-01); border: 1px solid var(--border-glass);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <div>
                        <strong style="color: var(--text-primary); font-size: 1rem; font-family: 'Outfit', sans-serif;">📋 Výkaz práce ze dne ${escapeHtml(ts.date)}</strong>
                        <span style="opacity: 0.6; font-size: 0.75rem; display: block;">Sestaveno: ${new Date(ts.createdAt).toLocaleString('cs-CZ')}</span>
                    </div>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <span style="color: var(--accent-gold); font-weight: bold; font-size: 0.95rem;">${ts.totalHours.toFixed(1)} hod celkem</span>
                        <button class="btn btn-secondary" onclick="window.appInstance.copyTimesheetToClipboard('${safeId(ts.id)}')" style="padding: 4px 8px; font-size: 0.75rem; background: var(--sf-05); border: 1px solid var(--border-glass);">
                            Kopírovat 📋
                        </button>
                    </div>
                </div>
                <div class="glass" style="padding: 12px 15px; border-radius: 8px; font-family: 'Outfit', sans-serif; font-size: 0.85rem; background: var(--sunken-1); border: 1px solid var(--sf-02); white-space: pre-wrap; color: var(--text-secondary); max-height: 200px; overflow-y: auto;" id="ts-text-${escapeHtml(ts.id)}">${escapeHtml(ts.synthesizedOutput)}</div>
            </div>
        `).join('');
    },

    async generateTimesheet() {
        const model = document.getElementById('timesheet-model-select').value || undefined; // prázdné = výchozí model serveru (dřív natvrdo llama3, který kancelář nemusí mít)
        
        try {
            console.log("🕒 Spouštím generování timesheetu přes Ollama...");
            const res = await fetch(`${this.apiBase}/activity/timesheet`, {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ model })
            });

            const data = await res.json();
            if (data.success) {
                alert("✓ Denní výkaz práce byl úspěšně vygenerován lokální AI a šifrovaně uložen.");
                await this.loadTimeTrackingTab();
            } else {
                alert("❌ Chyba při generování: " + data.message);
            }
        } catch (err) {
            alert("❌ Síťové selhání při generování výkazu: " + err.message);
        }
    },

    // Verdikt prověrky střetu zájmů. „unknown“ (prověření selhalo) NESMÍ vypadat jako bezpečné.
    conflictVerdict(level) {
        if (level === 'high') return { text: 'VYSOKÉ RIZIKO', color: '#dc2626' };
        if (level === 'medium') return { text: 'Střední riziko', color: '#b45309' };
        if (level === 'none') return { text: 'Bez shody ✓', color: '#15803d' };
        return { text: 'NEOVĚŘENO — prověřte ručně', color: '#b45309' };
    },

    async loadRisksTab() {
        try {
            console.log("🔍 Načítám tab Hlídač rizik...");
            
            // Get history of conflict checks
            const resConflicts = await fetch(`${this.apiBase}/conflicts/history`, { headers: this.getHeaders() });
            const dataConflicts = await resConflicts.json();

            if (dataConflicts.success) {
                this.renderConflictsHistory(dataConflicts.history);
            }
        } catch (err) {
            console.error("❌ Nelze načíst data pro tab rizik:", err);
        }
    },

    renderConflictsHistory(history) {
        const listEl = document.getElementById('conflicts-history-list');
        if (!listEl) return;

        if (history.length === 0) {
            listEl.innerHTML = `<div style="text-align: center; opacity: 0.6; padding: 20px;">Žádné historické prověrky.</div>`;
            return;
        }

        // Sort descending by timestamp
        const sorted = [...history].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));

        listEl.innerHTML = sorted.map(run => {
            const isHigh = run.riskLevel === 'high';
            const v = this.conflictVerdict(run.riskLevel);
            const badgeColor = v.color;
            const badgeText = v.text;

            return `
                <div class="glass" style="padding: 15px; border-radius: 10px; background: var(--sf-01); border: 1px solid var(--border-glass); font-size: 0.85rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <div>
                            <strong style="color: var(--text-primary); font-size: 0.95rem;">Prověrka střetu zájmů</strong>
                            <span style="opacity: 0.6; font-size: 0.75rem; display: block;">Prověřeno: ${new Date(run.timestamp).toLocaleString('cs-CZ')}</span>
                        </div>
                        <span style="font-size: 0.75rem; padding: 3px 8px; border-radius: 4px; font-weight: bold; background: ${badgeColor}20; color: ${badgeColor}; border: 1px solid ${badgeColor}30;">
                            ${badgeText}
                        </span>
                    </div>
                    <div style="margin-bottom: 8px;">
                        <span style="opacity: 0.8;">Klient: <strong>${escapeHtml(run.clientName)}</strong> | Protistrana: <strong>${escapeHtml(run.counterpartyName)}</strong></span>
                    </div>
                    <p style="margin: 0; font-size: 0.8rem; opacity: 0.9; color: ${isHigh ? '#f87171' : 'var(--text-primary)'};">${escapeHtml(run.description)}</p>
                    ${run.conflictsFound && run.conflictsFound.length > 0 ? `
                        <div style="margin-top: 10px; padding: 10px; background: var(--sunken-1); border-radius: 6px; border: 1px solid var(--sf-03);">
                            <span style="font-size: 0.75rem; font-weight: bold; color: var(--accent-gold); display: block; margin-bottom: 5px;">Detaily nalezeného konfliktu:</span>
                            ${run.conflictsFound.map(c => c.spisId ? `
                                <div style="font-size: 0.75rem; margin-bottom: 4px; opacity: 0.9;">
                                    • Ve spisu: <a href="#" onclick="window.appInstance.switchTab('spisova'); window.appInstance.openSpis('${safeId(c.spisId)}'); return false;"><code>${escapeHtml(c.label)}</code></a> — „${escapeHtml(c.value)}“ veden(a) jako <strong>${c.role === 'klient' ? 'klient' : 'protistrana'}</strong>${c.stav ? ` (${escapeHtml(c.stav)})` : ''}
                                </div>` : `
                                <div style="font-size: 0.75rem; margin-bottom: 4px; opacity: 0.9;">
                                    • Shoda v souboru: <code>${escapeHtml(c.fileName)}</code> (sémantická váha: ${(Number(c.score) * 100).toFixed(0)}%)
                                    <span style="display: block; opacity: 0.6; font-style: italic; margin-left: 10px;">"${escapeHtml(c.textSnippet)}"</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    },

    async runConflictCheck(e) {
        e.preventDefault();
        const clientName = document.getElementById('conflict-client-name').value;
        const counterpartyName = document.getElementById('conflict-opponent-name').value;

        try {
            const res = await fetch(`${this.apiBase}/conflicts/check`, {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ clientName, counterpartyName })
            });

            const data = await res.json();
            if (data.success) {
                const report = data.report;
                const panel = document.getElementById('conflict-result-panel');
                const badge = document.getElementById('conflict-risk-badge');
                const desc = document.getElementById('conflict-risk-desc');

                panel.style.display = 'block';
                desc.textContent = report.description;

                const v = this.conflictVerdict(report.riskLevel);
                badge.textContent = v.text;
                badge.style.background = v.color + '22';
                badge.style.color = v.color;
                badge.style.border = `1px solid ${v.color}55`;

                await this.loadRisksTab();
            } else {
                alert("❌ Chyba prověrky střetu zájmů: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba prověrky: " + err.message);
        }
    },

    async runComplianceCheck(e) {
        e.preventDefault();
        const documentName = document.getElementById('compliance-doc-name').value;
        const content = document.getElementById('compliance-doc-text').value;

        try {
            const res = await fetch(`${this.apiBase}/judikatura/check`, {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content, documentName })
            });

            const data = await res.json();
            if (data.success || data.compliant !== undefined) {
                const panel = document.getElementById('compliance-result-panel');
                const badge = document.getElementById('compliance-status-badge');
                const container = document.getElementById('compliance-alerts-container');

                panel.style.display = 'block';

                badge.textContent = data.compliant ? 'Plně vyhovující ✓' : 'NALEZEN NESOULAD ⚠️';
                badge.style.background = data.compliant ? 'rgba(52,211,153,0.2)' : 'rgba(239,68,68,0.2)';
                badge.style.color = data.compliant ? '#34d399' : '#f87171';
                badge.style.border = `1px solid ${data.compliant ? '#34d399' : '#f87171'}30`;

                if (data.compliant) {
                    container.innerHTML = `<div style="color: #34d399; font-weight: bold; padding: 10px 0;">✓ Dokument vyhovuje všem prověřovaným judikátům Nejvyššího soudu a e-Sbírky.</div>`;
                } else {
                    container.innerHTML = data.alerts.map(alert => `
                        <div class="glass" style="padding: 12px; border-radius: 8px; background: rgba(239,68,68,0.02); border: 1px solid rgba(239,68,68,0.2); margin-top: 10px;">
                            <div style="font-weight: bold; color: #f87171; margin-bottom: 5px;">⚠️ Nesoulad s ${escapeHtml(alert.benchmarkTitle)}</div>
                            <div style="font-size: 0.8rem; margin-bottom: 8px; opacity: 0.9;">Téma: <strong>${escapeHtml(alert.topic)}</strong></div>
                            <div style="font-size: 0.8rem; margin-bottom: 8px; opacity: 0.8; font-style: italic;">"${escapeHtml(alert.description)}"</div>
                            <div style="font-size: 0.8rem; padding: 8px; background: rgba(52,211,153,0.05); border: 1px solid rgba(52,211,153,0.2); border-radius: 6px; color: #a7f3d0;">
                                <strong style="display: block; margin-bottom: 3px; color: #34d399;">Doporučené znění opravy:</strong>
                                ${escapeHtml(alert.suggestedRemedy)}
                            </div>
                        </div>
                    `).join('');
                }
            } else {
                alert("❌ Selhala analýza compliance.");
            }
        } catch (err) {
            alert("❌ Síťová chyba analýzy: " + err.message);
        }
    },

    async loadManagerialTab() {
        try {
            console.log("📊 Načítám tab Manažerské přehledy...");
            
            // Fetch profitability report
            const resProfitability = await fetch(`${this.apiBase}/managerial/profitability`, { headers: this.getHeaders() });
            const dataProfitability = await resProfitability.json();

            // Fetch capacity workload report
            const resCapacity = await fetch(`${this.apiBase}/managerial/capacity`, { headers: this.getHeaders() });
            const dataCapacity = await resCapacity.json();

            // Fetch office default hourly rate setting
            const resSettings = await fetch(`${this.apiBase}/managerial/settings`, { headers: this.getHeaders() });
            const dataSettings = await resSettings.json();
            if (dataSettings.success && dataSettings.settings) {
                const defaultRateInput = document.getElementById('office-default-rate');
                if (defaultRateInput) {
                    defaultRateInput.value = dataSettings.settings.defaultHourlyRate;
                }
            }

            // Fetch fee list (ceník)
            const resFees = await fetch(`${this.apiBase}/managerial/fees`, { headers: this.getHeaders() });
            const dataFees = await resFees.json();

            if (dataProfitability.success) {
                this.renderProfitability(dataProfitability.report);
            }
            if (dataCapacity.success) {
                this.renderCapacity(dataCapacity.allocation);
            }
            if (dataFees.success) {
                this.renderFeesList(dataFees.fees);
            }
        } catch (err) {
            console.error("❌ Nelze načíst manažerská data:", err);
        }
    },

    renderProfitability(report) {
        const listEl = document.getElementById('managerial-profitability-list');
        if (!listEl) return;

        if (report.length === 0) {
            listEl.innerHTML = `<div style="text-align: center; opacity: 0.6; padding: 20px;">Žádné rozpracované spisy s nastavenými budgety.</div>`;
            return;
        }

        listEl.innerHTML = report.map(item => {
            const isUnprofitable = item.status === 'unprofitable';
            const isWarning = item.status === 'warning';
            const statusColor = isUnprofitable ? '#f87171' : isWarning ? '#fbbf24' : '#4ade80';
            const barFill = Math.min(item.spentPercentage, 100);

            return `
                <div class="glass" style="padding: 15px; border-radius: 12px; background: var(--sf-01); border: 1px solid var(--border-glass);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <div>
                            <strong style="color: var(--text-primary); font-size: 0.95rem; font-family: 'Outfit', sans-serif;">📄 ${escapeHtml(item.documentName)}</strong>
                            <span style="opacity: 0.6; font-size: 0.75rem; display: block;">Typ: ${escapeHtml(({ hourly_cap: 'Hodinový strop', flat: 'Paušál' })[item.budgetType] || item.budgetType)} | Sazba: ${escapeHtml(String(item.hourlyRate))} Kč/hod</span>
                        </div>
                        <div style="text-align: right;">
                            <span style="font-weight: bold; color: ${statusColor}; font-size: 0.95rem;">${item.actualHours.toFixed(1)} / ${escapeHtml(String(item.limitHours))} hod</span>
                            <span style="opacity: 0.6; font-size: 0.75rem; display: block;">(Čerpáno: ${escapeHtml(String(item.spentPercentage))}%)</span>
                        </div>
                    </div>
                    
                    <!-- Progress Bar -->
                    <div style="width: 100%; height: 8px; background: var(--sf-05); border-radius: 4px; overflow: hidden; margin-bottom: 10px; border: 1px solid var(--sf-02);">
                        <div style="width: ${barFill}%; height: 100%; background: ${statusColor}; border-radius: 4px; transition: width 0.3s ease;"></div>
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem;">
                        <span style="opacity: 0.7;">Odhadované náklady na práci:</span>
                        <strong style="color: var(--text-primary);">${escapeHtml(item.estimatedCost.toLocaleString('cs-CZ'))} Kč</strong>
                    </div>
                </div>
            `;
        }).join('');
    },

    renderCapacity(allocation) {
        const listEl = document.getElementById('managerial-capacity-list');
        if (!listEl) return;

        if (!allocation.staff || !allocation.staff.length) {
            listEl.innerHTML = `<div style="opacity: 0.75; padding: 16px; font-size: 0.85rem; line-height: 1.5;">Tým kanceláře zatím není nastaven. Vytížení se počítá pro uživatele z&nbsp;záložky <a href="#" onclick="window.appInstance.switchTab('users'); return false;">Uživatelé</a> — založte advokáty a koncipienty a rozdělení úkolů se zobrazí tady.</div>`;
            return;
        }
        listEl.innerHTML = allocation.staff.map(member => {
            const isOverloaded = member.status === 'overloaded';
            const isUnderloaded = member.status === 'underloaded';
            const statusColor = isOverloaded ? '#f87171' : isUnderloaded ? '#60a5fa' : '#4ade80';
            const statusText = isOverloaded ? 'PŘETÍŽENÍ' : isUnderloaded ? 'Volné kapacity' : 'Ideální vytížení';

            return `
                <div class="glass" style="padding: 15px; border-radius: 12px; background: var(--sf-01); border: 1px solid var(--border-glass); display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong style="color: var(--text-primary); font-size: 0.95rem; font-family: 'Outfit', sans-serif; display: block; margin-bottom: 2px;">${escapeHtml(member.name)}</strong>
                        <span style="opacity: 0.7; font-size: 0.75rem;">Role: ${escapeHtml(member.role)} | Aktivní úkolová zátěž: <strong>${member.load.toFixed(1)}</strong></span>
                    </div>
                    <div>
                        <span style="font-size: 0.75rem; padding: 4px 10px; border-radius: 20px; font-weight: bold; background: ${statusColor}20; color: ${statusColor}; border: 1px solid ${statusColor}30;">
                            ${statusText}
                        </span>
                    </div>
                </div>
            `;
        }).join('');
    },

    async saveBudget(e) {
        e.preventDefault();
        const documentName = document.getElementById('budget-doc-name').value;
        const budgetType = document.getElementById('budget-type').value;
        const limitHours = parseFloat(document.getElementById('budget-hours').value);
        const hourlyRateVal = document.getElementById('budget-rate').value;
        const hourlyRate = hourlyRateVal ? parseFloat(hourlyRateVal) : null;

        try {
            const res = await fetch(`${this.apiBase}/managerial/budgets`, {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ documentName, budgetType, limitHours, hourlyRate })
            });

            const data = await res.json();
            if (data.success) {
                alert("✓ Rozpočet spisu byl úspěšně nakonfigurován a šifrovaně uložen.");
                document.getElementById('managerial-budget-form').reset();
                await this.loadManagerialTab();
            } else {
                alert("❌ Chyba při ukládání rozpočtu: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťové selhání: " + err.message);
        }
    },

    async saveOfficeRate(e) {
        e.preventDefault();
        const defaultHourlyRate = parseFloat(document.getElementById('office-default-rate').value);

        try {
            const res = await fetch(`${this.apiBase}/managerial/settings`, {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ defaultHourlyRate })
            });

            const data = await res.json();
            if (data.success) {
                alert("✓ Výchozí hodinová sazba kanceláře byla uložena a zašifrována.");
                await this.loadManagerialTab();
            } else {
                alert("❌ Chyba při ukládání sazby: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťové selhání: " + err.message);
        }
    },

    renderFeesList(fees) {
        const listEl = document.getElementById('managerial-fees-list');
        if (!listEl) return;

        if (fees.length === 0) {
            listEl.innerHTML = `<div style="text-align: center; opacity: 0.6; padding: 20px;">Ceník je prázdný.</div>`;
            return;
        }

        listEl.innerHTML = fees.map(fee => {
            const isHourly = fee.type === 'hourly';
            const typeLabel = isHourly ? 'Kč/hod' : 'Kč (paušál)';
            const typeBadgeColor = isHourly ? 'var(--accent-blue)' : 'var(--accent-purple)';

            return `
                <div class="glass" style="padding: 12px 15px; border-radius: 8px; background: var(--sf-01); border: 1px solid var(--border-glass); display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem;">
                    <div>
                        <strong style="color: var(--text-primary); display: block; margin-bottom: 2px;">${escapeHtml(fee.name)}</strong>
                        <span style="font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; font-weight: bold; background: ${typeBadgeColor}15; color: ${typeBadgeColor}; border: 1px solid ${typeBadgeColor}25;">
                            ${isHourly ? 'Hodinová' : 'Paušální'}
                        </span>
                    </div>
                    <div style="display: flex; gap: 12px; align-items: center;">
                        <strong style="color: var(--accent-gold); font-size: 0.95rem;">${escapeHtml(fee.amount.toLocaleString('cs-CZ'))} ${typeLabel}</strong>
                        <div style="display: flex; gap: 6px;">
                            <button class="btn btn-secondary btn-sm" data-id="${escapeHtml(fee.id)}" data-name="${escapeHtml(fee.name)}" data-type="${escapeHtml(fee.type)}" data-amount="${escapeHtml(String(fee.amount))}" onclick="window.appInstance.editFeeItem(this.dataset.id, this.dataset.name, this.dataset.type, this.dataset.amount)" style="padding: 3px 6px; font-size: 0.75rem;">✏️</button>
                            <button class="btn btn-secondary btn-sm" onclick="window.appInstance.deleteFeeItem('${safeId(fee.id)}')" style="padding: 3px 6px; font-size: 0.75rem; background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.2); color: #f87171;">🗑️</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    toggleFeeForm(show) {
        const form = document.getElementById('fee-rule-form');
        if (!form) return;

        if (show) {
            form.style.display = 'flex';
            document.getElementById('fee-id').value = '';
            document.getElementById('fee-name').value = '';
            document.getElementById('fee-type').value = 'hourly';
            document.getElementById('fee-amount').value = '';
            document.getElementById('fee-name').focus();
        } else {
            form.style.display = 'none';
            form.reset();
        }
    },

    editFeeItem(id, name, type, amount) {
        const form = document.getElementById('fee-rule-form');
        if (!form) return;

        form.style.display = 'flex';
        document.getElementById('fee-id').value = id;
        document.getElementById('fee-name').value = name;
        document.getElementById('fee-type').value = type;
        document.getElementById('fee-amount').value = amount;
        document.getElementById('fee-name').focus();
    },

    async saveFeeItem(e) {
        e.preventDefault();
        const id = document.getElementById('fee-id').value;
        const name = document.getElementById('fee-name').value;
        const type = document.getElementById('fee-type').value;
        const amount = parseFloat(document.getElementById('fee-amount').value);

        try {
            const res = await fetch(`${this.apiBase}/managerial/fees`, {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ id: id || undefined, name, type, amount })
            });

            const data = await res.json();
            if (data.success) {
                this.toggleFeeForm(false);
                await this.loadManagerialTab();
            } else {
                alert("❌ Chyba při ukládání položky: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťové selhání: " + err.message);
        }
    },

    async deleteFeeItem(id) {
        if (!await LexisUI.confirm("Opravdu chcete smazat tuto položku z ceníku?")) return;
        try {
            const res = await fetch(`${this.apiBase}/managerial/fees/${id}`, {
                method: 'DELETE',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                await this.loadManagerialTab();
            } else {
                alert("❌ Chyba při mazání položky: " + data.error);
            }
        } catch (err) {
            alert("❌ Nelze smazat položku: " + err.message);
        }
    },

    openQuickTimeLogModal() {
        const dialog = document.getElementById('dialog-quick-timelog');
        if (!dialog) return;
        
        document.getElementById('form-quick-timelog').reset();
        const todayStr = new Date().toISOString().split('T')[0];
        document.getElementById('qtl-date').value = todayStr;
        
        dialog.showModal();
    },

    async saveQuickTimeLog(e) {
        e.preventDefault();
        const documentName = document.getElementById('qtl-case').value.trim();
        const date = document.getElementById('qtl-date').value;
        const hours = parseFloat(document.getElementById('qtl-hours').value);
        const description = document.getElementById('qtl-description').value.trim();
        
        try {
            console.log(`🕒 Ukládám ruční výkaz práce pro [${documentName}]...`);
            const res = await fetch(`${this.apiBase}/activity/custom`, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    documentName,
                    hours,
                    date,
                    actionType: description
                })
            });
            
            const data = await res.json();
            if (data.success) {
                alert(`✓ Úkon byl úspěšně zaznamenán.`);
                document.getElementById('dialog-quick-timelog').close();
                
                if (this.activeTab === 'timetracking') {
                    await this.loadTimeTrackingTab();
                } else if (this.activeTab === 'overview') {
                    await this.checkSystemStatus();
                }
            } else {
                alert("❌ Chyba při ukládání úkonu: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťové selhání při zápisu času: " + err.message);
        }
    },

    async loadInlineTimelineData(caseNum) {
        const caseNumSanitized = caseNum.replace(/[^a-zA-Z0-9-_]/g, '_');
        const listEl = document.getElementById(`timeline-events-${caseNumSanitized}`);
        if (!listEl) return;
        
        try {
            console.log(`⏱️ Načítám časovou osu pro spis [${caseNum}]...`);
            const res = await fetch(`${this.apiBase}/inbox/case/${encodeURIComponent(caseNum)}/timeline`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            
            if (data.success && data.timeline) {
                if (data.timeline.length === 0) {
                    listEl.innerHTML = `<div style="text-align: center; padding: 15px; opacity: 0.6; font-size: 0.8rem;">Žádná zaznamenaná historie pro tento spis.</div>`;
                    return;
                }
                
                listEl.innerHTML = data.timeline.map(item => {
                    const dateStr = new Date(item.timestamp).toLocaleString('cs-CZ');
                    return `
                        <div class="timeline-item" style="margin-bottom: 12px;">
                            <div class="timeline-icon">${escapeHtml(item.icon || '⚫')}</div>
                            <div class="timeline-content">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                    <strong style="color: var(--text-primary); font-size: 0.82rem;">${escapeHtml(item.title)}</strong>
                                    <span style="font-size: 0.68rem; opacity: 0.6;">${dateStr}</span>
                                </div>
                                <span style="font-size: 0.76rem; opacity: 0.85; color: var(--text-secondary); display: block; line-height: 1.4;">${escapeHtml(item.description)}</span>
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                listEl.innerHTML = `<div style="text-align: center; padding: 15px; color: var(--accent-red); font-size: 0.8rem;">❌ Chyba načítání: ${escapeHtml(data.error)}</div>`;
            }
        } catch (err) {
            listEl.innerHTML = `<div style="text-align: center; padding: 15px; color: var(--accent-red); font-size: 0.8rem;">❌ Síťová chyba: ${escapeHtml(err.message)}</div>`;
        }
    },

    async showCaseTimeline(caseNum) {
        const caseNumSanitized = caseNum.replace(/[^a-zA-Z0-9-_]/g, '_');
        const collapseEl = document.getElementById(`timeline-collapse-${caseNumSanitized}`);
        const listEl = document.getElementById(`timeline-events-${caseNumSanitized}`);
        const btnToggle = document.getElementById(`btn-timeline-toggle-${caseNumSanitized}`);
        
        if (!collapseEl || !listEl || !btnToggle) {
            // Fallback to dialog if DOM elements for inline are not found
            const dialog = document.getElementById('dialog-case-timeline');
            const caseLabel = document.getElementById('timeline-case-number');
            const dialogListEl = document.getElementById('timeline-events-list');
            if (dialog && caseLabel && dialogListEl) {
                caseLabel.textContent = `sp. zn. ${caseNum}`;
                dialogListEl.innerHTML = `<div style="text-align: center; padding: 30px; opacity: 0.6; font-size: 0.85rem;">Načítám časovou osu spisu...</div>`;
                dialog.showModal();
                try {
                    const res = await fetch(`${this.apiBase}/inbox/case/${encodeURIComponent(caseNum)}/timeline`, {
                        headers: this.getHeaders()
                    });
                    const data = await res.json();
                    if (data.success && data.timeline) {
                        if (data.timeline.length === 0) {
                            dialogListEl.innerHTML = `<div style="text-align: center; padding: 30px; opacity: 0.6; font-size: 0.85rem;">Žádná zaznamenaná historie pro tento spis.</div>`;
                            return;
                        }
                        dialogListEl.innerHTML = data.timeline.map(item => {
                            const dateStr = new Date(item.timestamp).toLocaleString('cs-CZ');
                            return `
                                <div class="timeline-item">
                                    <div class="timeline-icon">${escapeHtml(item.icon || '⚫')}</div>
                                    <div class="timeline-content">
                                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                            <strong style="color: var(--text-primary); font-size: 0.85rem;">${escapeHtml(item.title)}</strong>
                                            <span style="font-size: 0.7rem; opacity: 0.6;">${dateStr}</span>
                                        </div>
                                        <span style="font-size: 0.78rem; opacity: 0.85; color: var(--text-secondary); display: block; line-height: 1.4;">${escapeHtml(item.description)}</span>
                                    </div>
                                </div>
                            `;
                        }).join('');
                    } else {
                        dialogListEl.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--accent-red); font-size: 0.85rem;">❌ Chyba: ${escapeHtml(data.error)}</div>`;
                    }
                } catch (err) {
                    dialogListEl.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--accent-red); font-size: 0.85rem;">❌ Síťová chyba: ${escapeHtml(err.message)}</div>`;
                }
            }
            return;
        }

        // Inline toggle logic
        if (collapseEl.style.display === 'none') {
            // Open the collapse
            collapseEl.style.display = 'block';
            this.expandedTimelines.add(caseNum);
            
            btnToggle.innerHTML = `✕ Skrýt historii`;
            btnToggle.style.background = 'rgba(239, 68, 68, 0.08)';
            btnToggle.style.borderColor = 'rgba(239, 68, 68, 0.25)';
            btnToggle.style.color = '#f87171';
            
            listEl.innerHTML = `<div style="text-align: center; padding: 15px; opacity: 0.6; font-size: 0.8rem;">Načítám historii spisu...</div>`;
            
            await this.loadInlineTimelineData(caseNum);
        } else {
            // Close the collapse
            collapseEl.style.display = 'none';
            this.expandedTimelines.delete(caseNum);
            
            btnToggle.innerHTML = `⏱️ Časová osa spisu`;
            btnToggle.style.background = 'rgba(59, 130, 246, 0.08)';
            btnToggle.style.borderColor = 'rgba(59, 130, 246, 0.25)';
            btnToggle.style.color = '#60a5fa';
        }
    }

});
