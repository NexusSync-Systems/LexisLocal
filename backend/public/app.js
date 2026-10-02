/**
 * LexisLocal Dashboard Application Controller
 * Handles tabs navigation, status checking, Ollama model manager, RAG inbox, and Agent Chat.
 */

document.addEventListener('DOMContentLoaded', () => {
    const app = new LexisLocalApp();
    app.init();
    window.appInstance = app;
});


// Chybějící / neplatný token: dřív aplikace bez tokenu tiše zobrazovala „undefined/0“
// a prázdné seznamy (test 2. 10. 2026) a pole pro token bylo schované v nápovědě.
// Jakákoli odpověď 401 z /api/ teď ukáže lištu s polem pro token.
(function installAuthBanner() {
    if (typeof window === 'undefined' || !window.fetch || window.__lexisAuthBanner) return;
    window.__lexisAuthBanner = true;
    const origFetch = window.fetch.bind(window);
    function showBanner(hadToken) {
        if (document.getElementById('lexis-auth-banner')) return;
        const bar = document.createElement('div');
        bar.id = 'lexis-auth-banner';
        bar.setAttribute('role', 'alert');
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;padding:10px 16px;background:#7f1d1d;color:#fff;font-size:0.9rem;box-shadow:0 2px 8px rgba(0,0,0,.3);';
        const msg = document.createElement('span');
        msg.textContent = hadToken
            ? '🔑 Uložený přístupový token server odmítl. Zadejte platný token:'
            : '🔑 Server vyžaduje přístupový token (najdete ho v _connect.txt nebo u správce). Zadejte ho:';
        const inp = document.createElement('input');
        inp.type = 'password'; inp.id = 'lexis-auth-banner-input'; inp.autocomplete = 'off';
        inp.placeholder = 'přístupový token';
        inp.style.cssText = 'padding:6px 10px;border-radius:6px;border:none;min-width:220px;color:#111;';
        const btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = 'Uložit a načíst znovu';
        btn.style.cssText = 'padding:6px 12px;border-radius:6px;border:none;background:#fff;color:#7f1d1d;font-weight:600;cursor:pointer;';
        const save = () => {
            const t = inp.value.trim();
            if (!t) return;
            try { localStorage.setItem('lexis_api_token', t); } catch (e) { /* bez úložiště */ }
            location.reload();
        };
        btn.addEventListener('click', save);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
        bar.append(msg, inp, btn);
        (document.body || document.documentElement).appendChild(bar);
    }
    window.fetch = function (input, init) {
        return origFetch(input, init).then(res => {
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                // Jen když požadavek nesl UŽIVATELŮV token (nebo žádný) — 401 na požadavek
                // s jiným, explicitně zadaným tokenem lištu nevyvolá.
                let sentTok = null;
                try {
                    const h = (init && init.headers) || {};
                    sentTok = (typeof h.get === 'function') ? h.get('X-API-Token') : (h['X-API-Token'] || h['x-api-token'] || null);
                } catch (e) { /* bez hlaviček */ }
                let stored = ''; try { stored = localStorage.getItem('lexis_api_token') || ''; } catch (e) {}
                const ownToken = !sentTok || sentTok === stored || sentTok === (window.LEXIS_API_TOKEN || '');
                if (res.status === 401 && url.indexOf('/api/') !== -1 && ownToken) {
                    let had = false; try { had = !!localStorage.getItem('lexis_api_token'); } catch (e) {}
                    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => showBanner(had));
                    else showBanner(had);
                }
            } catch (e) { /* lišta nesmí rozbít požadavek */ }
            return res;
        });
    };
})();

// escapeHtml je vytažen do app-helpers.js (načítá se před app.js) — jeden zdroj pravdy.

class LexisLocalApp {
    constructor() {
        // Dynamically adjust API base to current location host (Tailscale / remote IP / VPN)
        const origin = window.location.origin;
        this.apiBase = origin.startsWith('file://') || origin.includes('null') ? 'http://localhost:4000/api' : `${origin}/api`;
        this.activeTab = 'overview';
        this.models = [];
        this.inbox = [];
        this.watcherActive = true;
        this.apiToken = (typeof window !== 'undefined' && window.LEXIS_API_TOKEN) || localStorage.getItem('lexis_api_token') || '';
        
        // Calendar state
        this.calendarState = {
            currentYear: new Date().getFullYear(),
            currentMonth: new Date().getMonth(),
            selectedDate: new Date().toISOString().split('T')[0],
            events: []
        };
        this.expandedTimelines = new Set();
        this.emailSettings = null;
        this.emailTasks = [];
    }

    getHeaders(extraHeaders = {}) {
        const headers = { ...extraHeaders };
        if (this.apiToken) {
            headers['X-API-Token'] = this.apiToken;
        }
        return headers;
    }

    async init() {
        this.bindEvents();
        this.startClock();
        
        // Load API token input value if present
        const tokenInput = document.getElementById('api-token-input');
        if (tokenInput && this.apiToken) {
            tokenInput.value = this.apiToken;
        }
        
        // Initial data load
        await this.checkSystemStatus();
        await this.checkRagStatus();
        await this.loadModels();
        await this.loadEmailSettings();
        await this.loadEmailTasks();
        await this.loadInbox();
        await this.loadAlerts();
        await this.loadAgentsList();
        await this.loadReadiness();

        // Periodically refresh stats and inbox
        setInterval(() => this.checkSystemStatus(), 10000);
        setInterval(() => this.checkRagStatus(), 10000);
        setInterval(() => {
            const activeFilterBtn = document.querySelector('.filter-btn.active');
            const filter = activeFilterBtn ? activeFilterBtn.getAttribute('data-filter') : 'all';
            if (filter === 'emails') {
                this.loadEmailTasks().then(() => this.renderInbox());
            } else {
                this.loadInbox();
            }
        }, 8000);
        setInterval(() => this.loadAlerts(), 10000);
    }

    bindEvents() {
        // Tab Navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                this.switchTab(tab);
            });
        });

        // Test File Mock Generator Button
        const parseTestBtn = document.getElementById('btn-parse-test');
        if (parseTestBtn) {
            parseTestBtn.addEventListener('click', () => this.generateTestSpis());
        }

        // Upload File trigger
        const uploadBtn = document.getElementById('btn-upload-file');
        const fileUploader = document.getElementById('file-uploader');
        if (uploadBtn && fileUploader) {
            uploadBtn.addEventListener('click', () => fileUploader.click());
            fileUploader.addEventListener('change', (e) => {
                const files = Array.from(e.target.files || []);
                if (files.length) this.handleFilesSelected(files);
            });
        }
        // Přetažení souborů kamkoli do okna → nahrání do doručené pošty
        // (kromě zóny znalostní báze asistenta, ta má vlastní drop).
        if (!window.__lexisDropInstalled) {
            window.__lexisDropInstalled = true;
            const hasFiles = ev => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
            document.addEventListener('dragover', ev => { if (hasFiles(ev)) { ev.preventDefault(); document.body.classList.add('lexis-dragging'); } });
            document.addEventListener('dragleave', ev => { if (!ev.relatedTarget) document.body.classList.remove('lexis-dragging'); });
            document.addEventListener('drop', ev => {
                document.body.classList.remove('lexis-dragging');
                if (!hasFiles(ev)) return;
                ev.preventDefault();
                if (ev.target && ev.target.closest && ev.target.closest('#agent-kb-drop')) return;
                const files = Array.from(ev.dataTransfer.files || []);
                if (files.length) this.handleFilesSelected(files);
            });
        }

        // Registry Search Action
        const regSearchBtn = document.getElementById('btn-registry-search');
        if (regSearchBtn) {
            regSearchBtn.addEventListener('click', () => this.performRegistrySearch());
        }
        
        // Registry input Enter key
        const regInput = document.getElementById('registry-search-input');
        if (regInput) {
            regInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.performRegistrySearch();
                }
            });
        }

        // Pull Model Action
        const pullModelBtn = document.getElementById('btn-btn-pull-model') || document.getElementById('btn-pull-model');
        if (pullModelBtn) {
            pullModelBtn.addEventListener('click', () => this.pullOllamaModel());
        }

        // Chat send trigger
        const chatSendBtn = document.getElementById('btn-chat-send');
        if (chatSendBtn) {
            chatSendBtn.addEventListener('click', () => this.sendChatMessage());
        }
        const chatTextarea = document.getElementById('chat-textarea');
        if (chatTextarea) {
            chatTextarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendChatMessage();
                }
            });
            chatTextarea.addEventListener('input', () => {
                chatTextarea.style.height = 'auto';
                chatTextarea.style.height = chatTextarea.scrollHeight + 'px';
            });
        }

        // Swarm Debate Toggle UI behavior
        const swarmToggle = document.getElementById('toggle-swarm-debate');
        const swarmOrchestrateToggle = document.getElementById('toggle-swarm-orchestrate');
        
        if (swarmToggle) {
            swarmToggle.addEventListener('change', (e) => {
                const agent1Container = document.getElementById('config-agent-1-container');
                const agent2Container = document.getElementById('config-agent-2-container');
                const lblAgent1 = document.getElementById('lbl-agent-1');
                
                if (e.target.checked) {
                    if (swarmOrchestrateToggle) {
                        swarmOrchestrateToggle.checked = false;
                    }
                    if (agent1Container) agent1Container.style.display = 'block';
                    if (agent2Container) agent2Container.style.display = 'block';
                    if (lblAgent1) lblAgent1.textContent = 'Aktivní AI Asistent / Tvůrce:';
                } else {
                    if (agent2Container) agent2Container.style.display = 'none';
                    if (lblAgent1) lblAgent1.textContent = 'Aktivní AI Asistent:';
                }
            });
        }

        if (swarmOrchestrateToggle) {
            swarmOrchestrateToggle.addEventListener('change', (e) => {
                const agent1Container = document.getElementById('config-agent-1-container');
                const agent2Container = document.getElementById('config-agent-2-container');
                
                if (e.target.checked) {
                    if (swarmToggle) {
                        swarmToggle.checked = false;
                    }
                    if (agent1Container) agent1Container.style.display = 'none';
                    if (agent2Container) agent2Container.style.display = 'none';
                } else {
                    if (agent1Container) agent1Container.style.display = 'block';
                }
            });
        }

        // Auto-select recommended model when active assistant changes
        const chatAgentSelect = document.getElementById('chat-agent-select');
        if (chatAgentSelect) {
            chatAgentSelect.addEventListener('change', (e) => {
                const agentId = e.target.value;
                const agent = this.agents.find(a => a.id === agentId);
                if (agent && agent.preferredModel) {
                    const modelSelect = document.getElementById('chat-model-select');
                    if (modelSelect) {
                        modelSelect.value = agent.preferredModel;
                        console.log(`🤖 Auto-selected recommended model [${agent.preferredModel}] for assistant [${agent.name}]`);
                    }
                }
            });
        }

        // Semantic Search triggers
        const searchBtn = document.getElementById('btn-semantic-search');
        if (searchBtn) {
            searchBtn.addEventListener('click', () => this.performSemanticSearch());
        }
        const searchInput = document.getElementById('semantic-search-input');
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    this.performSemanticSearch();
                }
            });
        }
        const reindexBtn = document.getElementById('btn-reindex-all');
        if (reindexBtn) {
            reindexBtn.addEventListener('click', () => this.reindexAllRag());
        }

        // Save API Token Action
        const saveTokenBtn = document.getElementById('btn-save-token');
        if (saveTokenBtn) {
            saveTokenBtn.addEventListener('click', () => {
                const tokenInput = document.getElementById('api-token-input');
                if (tokenInput) {
                    const token = tokenInput.value.trim();
                    this.apiToken = token;
                    localStorage.setItem('lexis_api_token', token);
                    
                    const statusText = document.getElementById('token-status-text');
                    if (statusText) {
                        statusText.textContent = token ? "✓ Bezpečnostní klíč byl bezpečně uložen v prohlížeči." : "✓ Bezpečnostní klíč byl smazán.";
                        statusText.style.display = 'block';
                        setTimeout(() => {
                            statusText.style.display = 'none';
                        }, 4000);
                    }
                    
                    // Reload data with new credentials
                    this.checkSystemStatus();
                    this.loadModels();
                    this.loadInbox();
                }
            });
        }

        // Refresh Audit Log Action
        const refreshAuditBtn = document.getElementById('btn-refresh-audit');
        if (refreshAuditBtn) {
            refreshAuditBtn.addEventListener('click', () => this.loadAuditLogs());
        }

        // Clear Audit Log Action
        const clearAuditBtn = document.getElementById('btn-clear-audit');
        if (clearAuditBtn) {
            clearAuditBtn.addEventListener('click', () => {
                if (confirm("Opravdu chcete vymazat celou historii auditních logů? Všechny provozní statistiky budou vynulovány.")) {
                    this.clearAuditLogs();
                }
            });
        }

        // Search Audit Log Input
        const auditSearchInput = document.getElementById('audit-search-input');
        if (auditSearchInput) {
            auditSearchInput.addEventListener('input', () => this.filterAuditLogs());
        }

        // Verify Ledger Action
        const verifyLedgerBtn = document.getElementById('btn-verify-ledger');
        if (verifyLedgerBtn) {
            verifyLedgerBtn.addEventListener('click', () => this.verifyTransparencyLedger());
        }

        // --- AI Agents Customizer Listeners ---
        const btnAddAgent = document.getElementById('btn-add-agent');
        if (btnAddAgent) {
            btnAddAgent.addEventListener('click', () => this.showNewAgentForm());
        }

        const agentEditorForm = document.getElementById('agent-editor-form');
        if (agentEditorForm) {
            agentEditorForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitAgentForm();
            });
        }

        const btnResetAgent = document.getElementById('btn-reset-agent');
        if (btnResetAgent) {
            btnResetAgent.addEventListener('click', () => {
                const agentId = document.getElementById('agent-form-id').value;
                if (confirm("Opravdu chcete tohoto systémového agenta vrátit do výchozího stavu? Vaše úpravy promptu budou smazány.")) {
                    this.resetAgent(agentId);
                }
            });
        }

        const btnDeleteAgent = document.getElementById('btn-delete-agent');
        if (btnDeleteAgent) {
            btnDeleteAgent.addEventListener('click', () => {
                const agentId = document.getElementById('agent-form-id').value;
                if (confirm("Opravdu chcete tohoto vlastního agenta trvale smazat?")) {
                    this.deleteAgent(agentId);
                }
            });
        }

        // --- Modální dialog editoru asistenta: zavírání ---
        const agentDialog = document.getElementById('dialog-agent-editor');
        const btnCloseAgentDialog = document.getElementById('btn-close-agent-dialog');
        if (btnCloseAgentDialog) {
            btnCloseAgentDialog.addEventListener('click', () => this.closeAgentDialog());
        }
        const btnRefreshOborCoverage = document.getElementById('btn-refresh-obor-coverage');
        if (btnRefreshOborCoverage) {
            btnRefreshOborCoverage.addEventListener('click', () => {
                if (typeof this.loadOborCoverage === 'function') this.loadOborCoverage();
            });
        }
        const btnRefreshReadiness = document.getElementById('btn-refresh-readiness');
        if (btnRefreshReadiness) {
            btnRefreshReadiness.addEventListener('click', () => {
                if (typeof this.loadReadiness === 'function') this.loadReadiness();
            });
        }
        if (agentDialog) {
            // Klik mimo obsah (na ::backdrop) zavře dialog
            agentDialog.addEventListener('click', (e) => {
                if (e.target === agentDialog) this.closeAgentDialog();
            });
            // Zavření přes Esc (nativní 'cancel'/'close') → odznač položku v seznamu
            agentDialog.addEventListener('close', () => {
                const container = document.getElementById('agents-list-container');
                if (container) container.querySelectorAll('.agents-list-item').forEach(i => i.classList.remove('active'));
            });
        }

        // Global Keyboard Shortcuts
        window.addEventListener('keydown', (e) => {
            // Alt+T (or Option+T on macOS)
            if (e.altKey && (e.code === 'KeyT' || e.key.toLowerCase() === 't')) {
                e.preventDefault();
                const dialog = document.getElementById('dialog-quick-timelog');
                if (dialog) {
                    if (dialog.open) {
                        dialog.close();
                    } else {
                        this.openQuickTimeLogModal();
                    }
                }
            }
        });
    }

    startClock() {
        const timeEl = document.getElementById('system-time');
        const updateClock = () => {
            const now = new Date();
            if (timeEl) {
                timeEl.textContent = now.toLocaleTimeString('cs-CZ');
            }
        };
        updateClock();
        setInterval(updateClock, 1000);
    }

    async loadReadiness() {
        const listEl = document.getElementById('readiness-list');
        const sumEl = document.getElementById('readiness-summary');
        if (!listEl) return;
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const ICON = { ok: '🟢', warn: '🟡', fail: '🔴' };
        try {
            const res = await fetch(`${this.apiBase}/readiness`, { headers: this.getHeaders() });
            if (res.status === 401) {
                if (sumEl) { sumEl.textContent = 'chybí přístupový token'; sumEl.style.color = 'var(--accent-red)'; }
                listEl.innerHTML = '<div style="font-size:0.85rem;">🔑 Bez platného přístupového tokenu nelze stav serveru zjistit — zadejte ho v liště nahoře.</div>';
                return;
            }
            const data = await res.json();
            const checks = data.checks || [];
            const s = data.summary || {};
            if (sumEl) {
                sumEl.textContent = s.ready
                    ? `vše připraveno (${s.ok || 0}/${checks.length})`
                    : `${s.ok || 0}/${checks.length} v pořádku${s.warn ? `, ${s.warn} varování` : ''}${s.fail ? `, ${s.fail} kritických` : ''}`;
                sumEl.style.color = s.fail ? 'var(--accent-red)' : (s.warn ? '#d9a441' : 'var(--accent-green, #10b981)');
            }
            listEl.innerHTML = checks.map(c => {
                const fix = (c.status !== 'ok' && c.fix)
                    ? `<div style="font-size:0.74rem; color:var(--text-secondary); margin-top:2px;">→ ${esc(c.fix)}</div>` : '';
                return `<div style="display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border-radius:8px; background:var(--sunken-1); border:1px solid var(--border-glass);">
                    <span style="font-size:0.85rem; line-height:1.4;">${ICON[c.status] || '⚪'}</span>
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:0.85rem; color:var(--text-primary);">${esc(c.label)}
                            <span style="color:var(--text-secondary); font-weight:400;">— ${esc(c.detail)}</span>
                        </div>
                        ${fix}
                    </div>
                </div>`;
            }).join('') || '<div style="opacity:.6; font-size:0.85rem;">Žádné kontroly.</div>';
        } catch (e) {
            listEl.innerHTML = `<div style="color:var(--accent-red); font-size:0.85rem;">Kontrolu se nepodařilo načíst: ${esc(e.message)}</div>`;
            if (sumEl) sumEl.textContent = '';
        }
    }

    switchTab(tabName) {
        this.activeTab = tabName;
        
        // Update sidebar state
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
        });

        // Update tab pane state
        document.querySelectorAll('.tab-pane').forEach(pane => {
            pane.classList.toggle('active', pane.getAttribute('id') === `tab-${tabName}`);
        });

        // Update titles
        const pageTitle = document.getElementById('page-title');
        const pageSubtitle = document.getElementById('page-subtitle');

        const headers = {
            overview: {
                title: "Řídicí panel",
                sub: "Rychlý přehled lokálního AI ekosystému a stavu služeb."
            },
            inbox: {
                title: "Doručená pošta spisy",
                sub: "Seznam naskenovaných a zindexovaných spisů ze složky LexisSpisy."
            },
            models: {
                title: "Správce AI modelů",
                sub: "Stahování a správa lokálních neuronových sítí z knihovny Ollama."
            },
            chat: {
                title: "Konzultace s AI",
                sub: "Konzultujte právní případy s jedním nebo více lokálními AI asistenty."
            },
            manual: {
                title: "Nápověda & Nastavení",
                sub: "Kompletní návod na konfiguraci lokální AI a chování asistentů."
            },
            agents: {
                title: "Správce AI asistentů",
                sub: "Vizuální konfigurátor chování a systémových instrukcí lokálních asistentů."
            },
            workflow: {
                title: "Workflow & Automatizace Lhůt",
                sub: "Hlídání procesních lhůt z příchozích zpráv a automatické recepty."
            },
            timetracking: {
                title: "Time-tracking & Výkazy práce",
                sub: "Automatické klientské timesheety a sledování aktivity v reálném čase."
            },
            risks: {
                title: "Hlídač rizik & Legislativa",
                sub: "Detektor střetu zájmů klienta a kontrola souladu doložek s judikaturou Nejvyššího soudu."
            },
            drafts: {
                title: "Koncepty",
                sub: "Sdílené koncepty dokumentů — úpravy v prohlížeči, verze, připomínky, schválení. Koncepty od AI čekají na kontrolu advokáta."
            },
            spisova: {
                title: "Spisová služba",
                sub: "Spisy jako entita, centrální lhůtník, skartační režim a fakturace na jednom místě."
            },
            aml: {
                title: "AML / Onboarding klienta",
                sub: "Identifikace a kontrola klienta dle zák. 253/2008 Sb., ověření registrů a PEP/sankční screening."
            },
            managerial: {
                title: "Manažerská inteligence & Přehledy",
                sub: "Ekonomické řízení ziskovosti spisů, rozpočty a přehled kapacitního vytížení týmu."
            },
            audit: {
                title: "Auditní logy & Provoz",
                sub: "Historie zpracování dat, OCR úkonů a klientského vytížení AI."
            }
        };

        if (pageTitle && pageSubtitle && headers[tabName]) {
            pageTitle.textContent = headers[tabName].title;
            pageSubtitle.textContent = headers[tabName].sub;
        }

        // Action triggers on tab switch
        if (tabName === 'overview') {
            if (typeof this.loadReadiness === 'function') this.loadReadiness();
        } else if (tabName === 'models') {
            this.loadModels();
        } else if (tabName === 'inbox') {
            this.loadInbox();
        } else if (tabName === 'audit') {
            this.loadAuditLogs();
        } else if (tabName === 'agents') {
            this.loadAgentsList();
            if (typeof this.loadOborCoverage === 'function') this.loadOborCoverage();
        } else if (tabName === 'workflow') {
            this.loadWorkflowTab();
        } else if (tabName === 'timetracking') {
            this.loadTimeTrackingTab();
        } else if (tabName === 'risks') {
            this.loadRisksTab();
        } else if (tabName === 'managerial') {
            this.loadManagerialTab();
        } else if (tabName === 'drafts') {
            if (typeof this.loadDraftsTab === 'function') this.loadDraftsTab();
        } else if (tabName === 'spisova') {
            this.loadSpisovaTab();
        } else if (tabName === 'aml') {
            this.loadAmlTab();
        }

        // Auto close mobile drawer on tab switch
        this.toggleMobileSidebar(false);
    }

    toggleMobileSidebar(open) {
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        if (sidebar) {
            sidebar.classList.toggle('open', open);
        }
        if (backdrop) {
            backdrop.classList.toggle('active', open);
        }
    }

    async checkSystemStatus() {
        try {
            const res = await fetch(`${this.apiBase}/status`, {
                headers: this.getHeaders()
            });
            const data = await res.json();
            
            // Set paths and counts
            const pathEl = document.getElementById('watch-dir-path');
            if (pathEl && data.watcherDir) {
                const full = data.watcherDir;
                const name = full.replace(/[\/\\]+$/, '').split(/[\/\\]/).pop() || full;
                pathEl.textContent = name;
                pathEl.title = full; // plná cesta v tooltipu
            }

            // Indikátor režimu AI (mlčenlivost): lokální vs cloud.
            const aiBadge = document.getElementById('ai-mode-badge');
            if (aiBadge && data.aiProvider) {
                const ap = data.aiProvider;
                const cloud = (ap.chat && ap.chat !== 'ollama') || (ap.embed && ap.embed !== 'ollama');
                const base = 'display:inline-flex;align-items:center;gap:5px;white-space:nowrap;padding:4px 10px;border-radius:999px;font-size:0.72rem;font-weight:600;';
                if (ap.localOnly && ap.compliant) {
                    aiBadge.textContent = '🔒 Lokální režim';
                    aiBadge.title = 'Pilotní lokální režim: AI běží jen lokálně (Ollama). Klientská data neopouští stroj.';
                    aiBadge.style.cssText = base + 'background:rgba(34,197,94,0.15);color:#16a34a;border:1px solid rgba(34,197,94,0.35);';
                } else if (cloud) {
                    aiBadge.textContent = '⚠️ Cloud AI';
                    aiBadge.title = 'AI přes cloud (chat: ' + ap.chat + ', embed: ' + ap.embed + '). Klientská data mohou opustit stroj — nevhodné pro mlčenlivost bez smlouvy o zpracování. Zapni LEXIS_PILOT_LOCAL_ONLY=1.';
                    aiBadge.style.cssText = base + 'background:rgba(239,68,68,0.15);color:#dc2626;border:1px solid rgba(239,68,68,0.35);';
                } else {
                    aiBadge.textContent = '🔒 Lokální AI';
                    aiBadge.title = 'AI běží lokálně (Ollama). Klientská data neopouští stroj.';
                    aiBadge.style.cssText = base + 'background:var(--sf-05);color:var(--text-secondary);border:1px solid var(--border-glass);';
                }
            }
            
            // Load Swarm info on Overview
            if (data.activeAgents) {
                this.renderOverviewAgents(data.activeAgents);
            }
        } catch (e) {
            console.warn("Chyba při komunikaci se serverem status:", e);
        }
    }











































    // --- WORKFLOW TAB INTEGRATIONS ---














    // --- TIME-TRACKING TAB INTEGRATIONS ---





    // --- RISKS & COMPLIANCE TAB INTEGRATIONS ---





    // --- MANAGERIAL INTELLIGENCE TAB INTEGRATIONS ---















    // ─── E-mailové úkoly a AI Asistenti ──────────────────────────────────────────────











}

// Bind to window for global inline onclick callbacks
window.addEventListener('DOMContentLoaded', () => {
    window.appInstance = new LexisLocalApp();
    window.appInstance.init();
});
