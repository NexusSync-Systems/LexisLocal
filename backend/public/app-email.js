// app-email.js — část dashboardu vytažená z app.js (prototype-mixin, beze změny chování).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
Object.assign(LexisLocalApp.prototype, {

    async loadEmailSettings() {
        try {
            const res = await fetch(`${this.apiBase}/email/settings`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                this.emailSettings = data.settings;
            }
        } catch (e) {
            console.error("Chyba při načítání nastavení emailu:", e);
        }
    },

    async loadEmailTasks() {
        try {
            const res = await fetch(`${this.apiBase}/email/tasks`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                this.emailTasks = data.tasks;
            }
        } catch (e) {
            console.error("Chyba při načítání emailových úkolů:", e);
        }
    },

    async saveEmailSettings(e) {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        
        const settings = {
            authorized_sender: document.getElementById('em-auth-sender').value.trim(),
            recipient_filter: document.getElementById('em-recip-filter').value.trim(),
            imap_host: document.getElementById('em-imap-host').value.trim(),
            imap_port: document.getElementById('em-imap-port').value.trim(),
            imap_user: document.getElementById('em-imap-user').value.trim(),
            imap_ssl: document.getElementById('em-imap-ssl').checked,
            smtp_host: document.getElementById('em-smtp-host').value.trim(),
            smtp_port: document.getElementById('em-smtp-port').value.trim(),
            smtp_user: document.getElementById('em-smtp-user').value.trim(),
            smtp_ssl: document.getElementById('em-smtp-ssl').checked,
            smtp_pass: document.getElementById('em-smtp-pass').value,
            imap_pass: (document.getElementById('em-imap-pass') || {}).value || '',
            imap_enabled: !!(document.getElementById('em-imap-enabled') || {}).checked,
            imap_poll_minutes: parseInt((document.getElementById('em-poll-min') || {}).value, 10) || 5
        };
        
        try {
            const res = await fetch(`${this.apiBase}/email/settings`, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(settings)
            });
            const data = await res.json();
            if (data.success) {
                alert("✓ Nastavení e-mailu bylo úspěšně uloženo.");
                this.emailSettings = settings;
                this.renderInbox();
            } else {
                alert("❌ Chyba: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba: " + err.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    openEmailSimulationModal() {
        const dialog = document.getElementById('dialog-email-simulation');
        if (!dialog) return;
        
        // Předvyplnit odesílatele autorizovaným e-mailem advokáta
        const senderInput = document.getElementById('ems-sender');
        if (senderInput && this.emailSettings && this.emailSettings.authorized_sender) {
            senderInput.value = this.emailSettings.authorized_sender;
        }
        
        // Vyčistit předmět a tělo
        const subjectInput = document.getElementById('ems-subject');
        if (subjectInput) subjectInput.value = '';
        const bodyInput = document.getElementById('ems-body');
        if (bodyInput) bodyInput.value = '';
        
        dialog.showModal();
    },

    async submitEmailSimulation(e) {
        e.preventDefault();
        const dialog = document.getElementById('dialog-email-simulation');
        const btn = e.target.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.textContent = "AI asistent zpracovává úkol... 🤖";
        }
        
        const orchestrateEl = document.getElementById('ems-orchestrate');
        const orchestrate = orchestrateEl ? orchestrateEl.checked : false;
        const taskData = {
            sender: document.getElementById('ems-sender').value.trim(),
            subject: document.getElementById('ems-subject').value.trim(),
            body: document.getElementById('ems-body').value.trim()
        };

        try {
            const endpoint = orchestrate ? `${this.apiBase}/email/process` : `${this.apiBase}/email/simulate`;
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(taskData)
            });
            const data = await res.json();
            if (data.success) {
                if (dialog) dialog.close();
                if (orchestrate) {
                    const kroky = (data.steps && data.steps.length) ? '\nKroky: ' + data.steps.join(' → ') : '';
                    if (data.replied) {
                        alert(`✓ Úkol zpracován (${data.mode}). Výsledek byl AUTOMATICKY odeslán zpět na Váš e-mail.` + kroky);
                    } else {
                        alert(`✓ Úkol zpracován (${data.mode}) a uložen níže. Automatická odpověď se neodeslala: ${data.replyError || 'neznámý důvod'}.` + kroky);
                    }
                } else {
                    alert(`✓ Úkol zpracován asistentem (${data.task.assignedAgentName} ${data.task.assignedAgentEmoji}). Odpověď je připravena níže — v tomto režimu se e-mailem reálně neodesílá.`);
                }
                await this.loadEmailTasks();
                this.renderInbox();
            } else {
                alert("❌ Chyba: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba při zpracování: " + err.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = "Odeslat úkol asistentovi 🚀";
            }
        }
    },

    async deleteEmailTask(id) {
        if (!confirm("Opravdu chcete tento e-mailový úkol smazat z historie?")) return;
        try {
            const res = await fetch(`${this.apiBase}/email/tasks/${id}`, {
                method: 'DELETE',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                await this.loadEmailTasks();
                this.renderInbox();
            } else {
                alert("❌ Chyba při mazání: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba při mazání: " + err.message);
        }
    },

    renderEmailTasks() {
        const container = document.getElementById('inbox-container');
        if (!container) return;

        // Nabindovat znovu filter buttony pokud je to nutné
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

        const s = this.emailSettings || {
            authorized_sender: 'advokat@dias.cz',
            recipient_filter: 'dias+asistenti@advokatnikancelar.cz',
            imap_host: 'imap.advokatnikancelar.cz',
            imap_port: '993',
            imap_user: 'dias@advokatnikancelar.cz',
            imap_ssl: true,
            smtp_host: 'smtp.advokatnikancelar.cz',
            smtp_port: '465',
            smtp_user: 'dias@advokatnikancelar.cz',
            smtp_ssl: true
        };

        let tasksHtml = '';
        if (this.emailTasks.length === 0) {
            tasksHtml = `
                <div class="empty-state" style="padding: 40px 20px; border: 1px dashed var(--border-glass); border-radius: 12px;">
                    <div class="empty-icon" style="font-size: 2.5rem; margin-bottom: 10px;">📧</div>
                    <h3 style="font-size: 1rem; margin-bottom: 5px; color: var(--text-primary);">Žádné e-mailové úkoly</h3>
                    <p style="font-size: 0.8rem; max-width: 320px; margin: auto; opacity: 0.7;">Pošlete e-mail na schránku asistentů nebo použijte simulátor v levém panelu.</p>
                </div>
            `;
        } else {
            tasksHtml = this.emailTasks.map(task => {
                const dateStr = new Date(task.createdAt).toLocaleString('cs-CZ');
                // Text/předmět jdou přes data-* (escapeHtml v JS řetězci v onclick nestačí: entity se v atributu dekódují).
                const safeSubject = escapeHtml('Odpověd na email: ' + (task.subject || ''));
                const escapedResponse = escapeHtml(task.responseSent);
                
                return `
                    <div class="glass email-task-card" style="border: 1px solid var(--border-glass); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 12px; background: rgba(15, 23, 42, 0.35); transition: border-color 0.2s;">
                        <div style="display: flex; justify-content: space-between; align-items: start;">
                            <div>
                                <span style="font-size: 0.72rem; color: var(--text-muted); display: block; margin-bottom: 2px;">Doručeno: ${dateStr}</span>
                                <strong style="color: var(--text-primary); font-size: 0.95rem; font-family: 'Outfit', sans-serif;">${escapeHtml(task.subject)}</strong>
                                <span style="font-size: 0.75rem; color: #94a3b8; display: block; margin-top: 2px;">Od: ${escapeHtml(task.sender)}</span>
                            </div>
                            <span style="background: rgba(59,130,246,0.12); border: 1px solid rgba(59,130,246,0.25); padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; color: #93c5fd; font-weight: 600; display: flex; align-items: center; gap: 4px;">
                                ${escapeHtml(task.assignedAgentEmoji)} ${escapeHtml(task.assignedAgentName)}
                            </span>
                        </div>
                        
                        <div style="background: var(--sunken-1); padding: 10px 14px; border-radius: 8px; font-size: 0.82rem; color: var(--text-secondary); border-left: 3px solid var(--accent-blue);">
                            <strong style="color: var(--text-primary);">Zadání v e-mailu:</strong><br/>
                            <span style="display: block; margin-top: 4px; line-height: 1.4;">${escapeHtml(task.body)}</span>
                        </div>
                        
                        <div style="margin-top: 5px;">
                            <span style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 5px;">Odpověď odeslaná advokátovi:</span>
                            <div style="background: var(--sunken-2); border: 1px solid var(--border-glass); padding: 12px; border-radius: 8px; font-family: 'Fira Code', 'Courier New', monospace; font-size: 0.78rem; color: var(--text-primary); max-height: 200px; overflow-y: auto; white-space: pre-wrap; line-height: 1.4; scrollbar-gutter: stable;">${escapeHtml(task.responseSent)}</div>
                        </div>
                        
                        <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border-glass); padding-top: 10px; margin-top: 5px;">
                            <button class="btn btn-secondary" data-text="${escapedResponse}" data-title="${safeSubject}" onclick="window.appInstance.sendTextToLexisEditor(this.dataset.text, this.dataset.title)" style="font-size: 0.75rem; padding: 6px 12px; border: 1px solid var(--border-glass); background: var(--sf-02); color: var(--text-primary);">
                                ✍️ Odeslat do Editoru
                            </button>
                            <button class="btn btn-secondary" onclick="window.appInstance.deleteEmailTask('${safeId(task.id)}')" style="font-size: 0.75rem; padding: 6px 12px; border: 1px solid rgba(239,68,68,0.2); background: rgba(239,68,68,0.02); color: #f87171;">
                                🗑️ Smazat
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        container.innerHTML = `
            <div class="email-tasks-layout" style="display: grid; grid-template-columns: 1fr 1.8fr; gap: 25px; margin-top: 15px; align-items: start;">
                <!-- Settings Panel -->
                <div class="glass" style="border: 1px solid var(--border-glass); border-radius: 14px; padding: 20px; background: rgba(30, 41, 59, 0.25); backdrop-filter: blur(12px);">
                    <h3 style="margin-top: 0; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; font-family: 'Outfit', sans-serif; font-size: 1.1rem; color: var(--text-primary);">
                        <span>⚙️</span> E-mailové propojení
                    </h3>
                    <form id="form-email-settings" onsubmit="window.appInstance.saveEmailSettings(event)" style="display: flex; flex-direction: column; gap: 12px; font-size: 0.82rem;">
                        <div style="background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.25); border-radius: 8px; padding: 10px 12px;">
                            <strong style="color: var(--accent-blue); display: block; margin-bottom: 6px; font-size: 0.8rem;">⚡ Rychlé nastavení</strong>
                            <div style="opacity:0.75; font-size:0.72rem; margin-bottom:8px;">Zadejte svůj e-mail a heslo — servery se doplní automaticky.</div>
                            <input type="email" id="em-quick-email" placeholder="vas@email.cz" style="width: 100%; padding: 8px; margin-bottom: 6px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                            <input type="password" id="em-quick-pass" placeholder="Heslo k e-mailu (u Gmailu/Outlooku heslo aplikace)" autocomplete="new-password" style="width: 100%; padding: 8px; margin-bottom: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                            <button type="button" class="btn btn-secondary" onclick="window.appInstance.quickSetupEmail()" style="width:100%; justify-content:center; padding:8px; font-size:0.8rem; border:1px solid rgba(59,130,246,0.4); background:rgba(59,130,246,0.15); color:white;">Vyplnit podle e-mailu ✨</button>
                            <div id="em-quick-note" style="font-size:0.72rem; margin-top:6px; opacity:0.85;"></div>
                        </div>
                        <details style="font-size:0.8rem;">
                            <summary style="cursor:pointer; opacity:0.8; padding:4px 0;">Ruční nastavení (pokročilé)</summary>
                        <div style="margin-top:8px;">
                            <label style="opacity: 0.8; display: block; margin-bottom: 4px; font-weight: 500;">Váš autorizovaný e-mail (Advokát)</label>
                            <input type="email" id="em-auth-sender" required style="width: 100%; padding: 8px 12px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); outline: none;" />
                        </div>
                        <div>
                            <label style="opacity: 0.8; display: block; margin-bottom: 4px; font-weight: 500;">Cílová adresa asistentů (filtr)</label>
                            <input type="text" id="em-recip-filter" required style="width: 100%; padding: 8px 12px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); outline: none;" />
                        </div>
                        
                        <div style="border-top: 1px solid var(--border-glass); padding-top: 10px; margin-top: 5px;">
                            <strong style="color: var(--accent-blue); display: block; margin-bottom: 8px; font-size: 0.8rem;">Příchozí pošta (IMAP)</strong>
                            <div style="display: grid; grid-template-columns: 1.5fr 0.8fr; gap: 10px; margin-bottom: 8px;">
                                <input type="text" id="em-imap-host" placeholder="imap.domain.cz" required style="width: 100%; padding: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                                <input type="text" id="em-imap-port" placeholder="993" required style="width: 100%; padding: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                            </div>
                            <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 8px;">
                                <input type="text" id="em-imap-user" placeholder="Uživatel / Login" required style="flex: 1; padding: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                                <div style="display: flex; align-items: center; gap: 5px; font-size: 0.72rem; white-space: nowrap; color: var(--text-secondary);">
                                    <input type="checkbox" id="em-imap-ssl" /> SSL/TLS
                                </div>
                            </div>
                            <input type="password" id="em-imap-pass" placeholder="Heslo k IMAP (pro příjem pošty)" autocomplete="new-password" style="width: 100%; padding: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                        </div>

                        <div style="border-top: 1px solid var(--border-glass); padding-top: 10px;">
                            <strong style="color: var(--accent-yellow); display: block; margin-bottom: 8px; font-size: 0.8rem;">Odesílání odpovědí (SMTP)</strong>
                            <div style="display: grid; grid-template-columns: 1.5fr 0.8fr; gap: 10px; margin-bottom: 8px;">
                                <input type="text" id="em-smtp-host" placeholder="smtp.domain.cz" required style="width: 100%; padding: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                                <input type="text" id="em-smtp-port" placeholder="465" required style="width: 100%; padding: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                            </div>
                            <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 8px;">
                                <input type="text" id="em-smtp-user" placeholder="Uživatel / Login" required style="flex: 1; padding: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                                <div style="display: flex; align-items: center; gap: 5px; font-size: 0.72rem; white-space: nowrap; color: var(--text-secondary);">
                                    <input type="checkbox" id="em-smtp-ssl" /> SSL/TLS
                                </div>
                            </div>
                            <input type="password" id="em-smtp-pass" placeholder="Heslo k SMTP (pro odesílání)" autocomplete="new-password" style="width: 100%; padding: 8px; background: var(--sunken-1); border: 1px solid var(--border-glass); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem;" />
                        </div>
                        </details>
                        
                        <label style="display:flex; gap:8px; align-items:center; font-size:0.8rem; margin-top:4px; cursor:pointer;">
                            <input type="checkbox" id="em-imap-enabled" /> <b>Zapnout automatický příjem</b> (číst schránku a zpracovávat úkoly)
                        </label>
                        <div style="display:flex; gap:8px; align-items:center; font-size:0.78rem; opacity:0.85;">
                            <span>Kontrolovat každých</span>
                            <input type="number" id="em-poll-min" min="1" value="5" style="width:60px; padding:4px 6px; background:var(--sunken-1); border:1px solid var(--border-glass); border-radius:6px; color:white;" />
                            <span>minut</span>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
                            <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center; padding: 10px; font-size: 0.82rem; background: var(--accent-blue); border: none; font-weight: 600; color: white;">
                                Uložit nastavení 💾
                            </button>
                            <div style="display:flex; gap:8px;">
                                <button type="button" class="btn btn-secondary" onclick="window.appInstance.testEmailConnection()" style="flex:1; justify-content:center; padding:8px; font-size:0.78rem; border:1px solid rgba(255,255,255,0.15); background:var(--sf-05); color:white;">Otestovat spojení 🔌</button>
                                <button type="button" class="btn btn-secondary" onclick="window.appInstance.pollEmailNow()" style="flex:1; justify-content:center; padding:8px; font-size:0.78rem; border:1px solid rgba(255,255,255,0.15); background:var(--sf-05); color:white;">Vyzvednout teď 📥</button>
                            </div>
                            <div id="em-test-note" style="font-size:0.75rem; opacity:0.9;"></div>
                            <button type="button" class="btn btn-secondary" onclick="window.appInstance.openEmailSimulationModal()" style="width: 100%; justify-content: center; padding: 10px; font-size: 0.82rem; border: 1px solid rgba(255,255,255,0.15); background: var(--sf-05); color: white;">
                                Simulovat zaslání úkolu 🚀
                            </button>
                        </div>
                    </form>
                </div>

                <!-- Tasks List -->
                <div style="display: flex; flex-direction: column; gap: 15px;">
                    <h3 style="margin-top: 0; margin-bottom: 5px; font-family: 'Outfit', sans-serif; font-size: 1.1rem; color: var(--text-primary);">
                        📥 Úkoly pro asistenty z e-mailu
                    </h3>
                    ${tasksHtml}
                </div>
            </div>
        `;

        // Fill form inputs
        document.getElementById('em-auth-sender').value = s.authorized_sender || '';
        document.getElementById('em-recip-filter').value = s.recipient_filter || '';
        document.getElementById('em-imap-host').value = s.imap_host || '';
        document.getElementById('em-imap-port').value = s.imap_port || '';
        document.getElementById('em-imap-user').value = s.imap_user || '';
        document.getElementById('em-imap-ssl').checked = s.imap_ssl !== false;
        document.getElementById('em-smtp-host').value = s.smtp_host || '';
        document.getElementById('em-smtp-port').value = s.smtp_port || '';
        document.getElementById('em-smtp-user').value = s.smtp_user || '';
        document.getElementById('em-smtp-ssl').checked = s.smtp_ssl !== false;
        const smtpPassEl = document.getElementById('em-smtp-pass');
        if (smtpPassEl) smtpPassEl.value = s.smtp_pass || '';
        const imapPassEl = document.getElementById('em-imap-pass');
        if (imapPassEl) imapPassEl.value = s.imap_pass || '';
        const imapEnEl = document.getElementById('em-imap-enabled');
        if (imapEnEl) imapEnEl.checked = s.imap_enabled === true;
        const pollEl = document.getElementById('em-poll-min');
        if (pollEl) pollEl.value = s.imap_poll_minutes || 5;
    },

    // Rychlé nastavení: z e-mailu odvodí servery a vyplní formulář.
    async quickSetupEmail() {
        const email = (document.getElementById('em-quick-email') || {}).value;
        const pass = (document.getElementById('em-quick-pass') || {}).value || '';
        const note = document.getElementById('em-quick-note');
        if (!email || !email.trim()) { if (note) note.textContent = 'Zadejte prosím e-mail.'; return; }
        try {
            const res = await fetch(`${this.apiBase}/email/derive`, {
                method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ email: email.trim() })
            });
            const d = await res.json();
            if (!d.success) { if (note) note.textContent = '❌ ' + (d.error || 'Nepodařilo se odvodit servery.'); return; }
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
            const check = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
            set('em-auth-sender', d.authorized_sender); set('em-recip-filter', d.recipient_filter);
            set('em-imap-host', d.imap_host); set('em-imap-port', d.imap_port); set('em-imap-user', d.imap_user); check('em-imap-ssl', d.imap_ssl !== false);
            set('em-smtp-host', d.smtp_host); set('em-smtp-port', d.smtp_port); set('em-smtp-user', d.smtp_user); check('em-smtp-ssl', d.smtp_ssl !== false);
            if (pass) { set('em-imap-pass', pass); set('em-smtp-pass', pass); }
            if (note) note.innerHTML = '✅ Servery vyplněny (' + escapeHtml(d.provider) + '). ' + (d.note ? '<span style="color:var(--accent-yellow);">' + escapeHtml(d.note) + '</span>' : '');
        } catch (e) { if (note) note.textContent = '❌ Síťová chyba: ' + e.message; }
    },

    // Otestuje IMAP i SMTP připojení podle aktuálně vyplněného formuláře.
    async testEmailConnection() {
        const note = document.getElementById('em-test-note');
        if (note) note.textContent = 'Testuji připojení…';
        const g = (id) => (document.getElementById(id) || {}).value || '';
        const c = (id) => !!(document.getElementById(id) || {}).checked;
        const settings = {
            imap_host: g('em-imap-host'), imap_port: g('em-imap-port'), imap_user: g('em-imap-user'), imap_ssl: c('em-imap-ssl'), imap_pass: g('em-imap-pass'),
            smtp_host: g('em-smtp-host'), smtp_port: g('em-smtp-port'), smtp_user: g('em-smtp-user'), smtp_ssl: c('em-smtp-ssl'), smtp_pass: g('em-smtp-pass')
        };
        try {
            const res = await fetch(`${this.apiBase}/email/test`, {
                method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ settings })
            });
            const d = await res.json();
            const line = (label, r) => (r && r.ok) ? ('✅ ' + label + ' OK') : ('❌ ' + label + ': ' + escapeHtml((r && r.error) || 'chyba'));
            if (note) note.innerHTML = line('IMAP', d.imap) + '<br>' + line('SMTP', d.smtp);
        } catch (e) { if (note) note.textContent = '❌ Síťová chyba: ' + e.message; }
    },

    // Ručně vyzvedne a zpracuje nové e-maily teď.
    async pollEmailNow() {
        const note = document.getElementById('em-test-note');
        if (note) note.textContent = 'Vyzvedávám poštu…';
        try {
            const res = await fetch(`${this.apiBase}/email/poll`, { method: 'POST', headers: this.getHeaders() });
            const d = await res.json();
            if (d.success) {
                if (note) note.textContent = `✅ Hotovo: zpracováno ${d.processed}, přeskočeno ${d.skipped}${d.errors ? ', chyby ' + d.errors : ''} (z ${d.total}).`;
                await this.loadEmailTasks();
                this.renderInbox();
            } else {
                if (note) note.textContent = '⚠️ ' + (d.reason === 'imap-config' ? 'IMAP není nastavené — doplňte přihlašovací údaje.' : (d.error || 'Nepodařilo se vyzvednout poštu.'));
            }
        } catch (e) { if (note) note.textContent = '❌ Síťová chyba: ' + e.message; }
    },

    async loadGreenMetricsAndTelemetry() {
        try {
            // Fetch green metrics
            const greenRes = await fetch(`${this.apiBase}/system/green-metrics`, { headers: this.getHeaders() });
            const greenData = await greenRes.json();
            
            // Fetch system telemetry
            const teleRes = await fetch(`${this.apiBase}/system/telemetry`, { headers: this.getHeaders() });
            const teleData = await teleRes.json();
            
            const savedEl = document.getElementById('green-telemetry-energy-saved');
            const co2El = document.getElementById('green-telemetry-co2-reduction');
            if (savedEl) savedEl.textContent = `${greenData.savedWh ? greenData.savedWh.toFixed(1) : 0} Wh`;
            if (co2El) co2El.textContent = `${greenData.savedCo2Grams ? greenData.savedCo2Grams.toFixed(1) : 0}g CO₂`;

            // Telemetry
            const cpuEl = document.getElementById('sys-telemetry-cores');
            const loadEl = document.getElementById('sys-telemetry-load');
            const ramEl = document.getElementById('sys-telemetry-ram');
            const vramEl = document.getElementById('sys-telemetry-vram');
            const uptimeEl = document.getElementById('sys-telemetry-uptime');

            if (cpuEl) cpuEl.textContent = `${teleData.cpuCores || '--'} jader (${teleData.arch || '--'})`;
            if (loadEl) loadEl.textContent = `${teleData.systemLoad !== undefined ? teleData.systemLoad.toFixed(2) : '--'}`;
            if (ramEl) ramEl.textContent = `${teleData.memoryUsedGb || '--'} GB / ${teleData.memoryTotalGb || '--'} GB`;
            if (vramEl) vramEl.textContent = `${teleData.vramFreeGb || '--'} GB volno / ${teleData.vramTotalGb || '--'} GB celkem`;
            if (uptimeEl) {
                const hours = Math.floor((teleData.uptimeSeconds || 0) / 3600);
                const mins = Math.floor(((teleData.uptimeSeconds || 0) % 3600) / 60);
                uptimeEl.textContent = `${hours}h ${mins}m`;
            }
        } catch (e) {
            console.error("❌ Nepodařilo se načíst zelenou telemetrii:", e.message);
        }
    },

    async loadTransparencyLedger() {
        try {
            const res = await fetch(`${this.apiBase}/audit/transparency`, { headers: this.getHeaders() });
            const data = await res.json();
            
            const container = document.getElementById('ledger-entries-list');
            if (!container) return;

            if (!Array.isArray(data) || data.length === 0) {
                container.innerHTML = `<div style="text-align: center; opacity: 0.6; padding: 10px;">Ledger je prázdný.</div>`;
                return;
            }

            let html = "";
            // Show latest entries first
            [...data].reverse().forEach(entry => {
                const isApproved = entry.humanApproved === true;
                const approveBtn = isApproved 
                    ? `<span style="color: var(--accent-green); font-weight: bold; font-size: 0.75rem;">✓ Schváleno</span>`
                    : `<button class="btn btn-secondary" onclick="window.appInstance.approveTransparencyEntry('${safeId(entry.id)}')" style="font-size: 0.7rem; padding: 3px 8px; border-color: #fbbf24; color: #fbbf24; background: rgba(251, 191, 36, 0.05);">Schválit</button>`;

                html += `
                    <div style="padding: 8px; border-bottom: 1px solid var(--border-glass); display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-weight: bold; display: flex; align-items: center; gap: 4px;">
                                🤖 ${escapeHtml(entry.agentName || 'AI')} <span style="font-weight: normal; color: var(--text-muted); font-size: 0.7rem;">(${escapeHtml(entry.model)})</span>
                            </div>
                            <div style="font-size: 0.7rem; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-top: 2px;">
                                Hash: ${entry.hash ? escapeHtml(entry.hash.substring(0, 12)) : 'N/A'}... | Prompt: "${escapeHtml(entry.prompt)}"
                            </div>
                        </div>
                        <div style="flex: 0 0 auto; text-align: right;">
                            ${approveBtn}
                        </div>
                    </div>
                `;
            });
            container.innerHTML = html;
        } catch (e) {
            console.error("❌ Nepodařilo se načíst transparency ledger:", e.message);
        }
    },

    async approveTransparencyEntry(id) {
        try {
            const res = await fetch(`${this.apiBase}/audit/transparency/${id}/approve`, {
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                this.loadTransparencyLedger();
            } else {
                alert(`❌ Nepodařilo se schválit záznam: ${data.error}`);
            }
        } catch (e) {
            console.error("❌ Chyba při schvalování záznamu:", e.message);
        }
    },

    async verifyTransparencyLedger() {
        const resultDiv = document.getElementById('ledger-verify-result');
        const shieldSpan = document.getElementById('ledger-status-shield');
        if (!resultDiv) return;

        resultDiv.style.display = 'block';
        resultDiv.style.background = 'var(--sf-05)';
        resultDiv.style.color = 'white';
        resultDiv.innerHTML = '⚙️ Ověřuji kryptografickou integritu ledgeru (Hash-Chaining)...';

        try {
            const res = await fetch(`${this.apiBase}/audit/transparency/verify`, { headers: this.getHeaders() });
            const data = await res.json();

            if (data.valid) {
                resultDiv.style.background = 'rgba(16, 185, 129, 0.15)';
                resultDiv.style.border = '1px solid #10b981';
                resultDiv.style.color = '#34d399';
                resultDiv.innerHTML = '🛡️ <strong>Integrita ověřena!</strong> Celý blockchain řetězec je neporušen a validní.';
                
                if (shieldSpan) {
                    shieldSpan.textContent = '🛡️ Zabezpečen';
                    shieldSpan.style.background = 'rgba(16, 185, 129, 0.2)';
                    shieldSpan.style.borderColor = '#10b981';
                    shieldSpan.style.color = '#10b981';
                }
            } else {
                resultDiv.style.background = 'rgba(239, 68, 68, 0.15)';
                resultDiv.style.border = '1px solid #ef4444';
                resultDiv.style.color = '#fca5a5';
                resultDiv.innerHTML = `⚠️ <strong>Detekováno narušení!</strong><br>Důvod: ${escapeHtml(String(data.reason||""))}<br>Index poškození: ${escapeHtml(String(data.index))} (ID: ${escapeHtml(String(data.id))})`;
                
                if (shieldSpan) {
                    shieldSpan.textContent = '⚠️ Narušen!';
                    shieldSpan.style.background = 'rgba(239, 68, 68, 0.2)';
                    shieldSpan.style.borderColor = '#ef4444';
                    shieldSpan.style.color = '#ef4444';
                }
            }
        } catch (e) {
            resultDiv.style.background = 'rgba(239, 68, 68, 0.1)';
            resultDiv.style.color = '#fca5a5';
            resultDiv.innerHTML = `❌ Chyba při ověřování ledgeru: ${escapeHtml(String(e.message||""))}`;
        }
    }

});
