// app-datovka.js — záložka „Datová schránka“ (dřív schovaná v Lustračním centru → Přístupy).
// Stav připojení, „Stáhnout teď“, seznam přijatých zpráv (doručení, lhůta, spis), import .zfo
// a nastavení připojení. Pole připojení mají stejná id jako dřív, takže loadRegistryConfig,
// saveRegistryConfig a isdsPollNow (app-chat.js) fungují beze změny.
(function () {
    'use strict';
    if (typeof LexisLocalApp === 'undefined') return;
    const P = LexisLocalApp.prototype;
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const czDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${+m[3]}. ${+m[2]}. ${m[1]}` : (d || '—'); };

    Object.assign(P, {
        async loadDatovka() {
            try { await this.loadRegistryConfig(); } catch (e) { /* stav se ukáže níže */ }
            await this.loadDatovkaMessages();
        },

        async loadDatovkaMessages(opts) {
            const box = document.getElementById('dsx-messages');
            try {
                const res = await fetch(`${this.apiBase}/registries/isds/messages`, { headers: this.getHeaders() });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || res.status);
                if (!(opts && opts.keepStatus)) this._renderIsdsStatus(data.status);
                const badge = document.getElementById('datovka-badge');
                if (badge) badge.style.display = data.status && data.status.lastError ? '' : 'none';
                if (!box) return;
                const list = data.messages || [];
                if (!list.length) {
                    box.innerHTML = '<div style="opacity:0.6;">Zatím žádné zprávy. Klikněte na „Stáhnout teď“, nebo nahrajte .zfo.</div>';
                    return;
                }
                box.innerHTML = list.map(m => {
                    const deadline = m.systemMessage ? '<span style="opacity:0.7;">systémová zpráva — bez lhůty</span>'
                        : m.deadlineDate ? `⏳ lhůta <b>${esc(czDate(m.deadlineDate))}</b>${m.deadlineDays ? ` (${esc(m.deadlineDays)} dnů)` : ''}`
                        : '<span style="opacity:0.7;">lhůta nenalezena</span>';
                    const spis = m.spisId
                        ? `<a href="#" onclick="window.appInstance.switchTab('spisova'); window.appInstance.openSpis('${esc(m.spisId)}'); return false;">📁 ${esc(m.spisZn || m.caseNumber)}</a>`
                        : (m.caseNumber ? `sp. zn. ${esc(m.caseNumber)} <span style="opacity:0.7;">(spis nezaložen)</span>` : '<span style="opacity:0.7;">bez spisu</span>');
                    const how = m.deliveryHow ? ` (${esc(m.deliveryHow)})` : '';
                    return `<div style="background:var(--sf-03);border:1px solid var(--border-glass);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px;">
                        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                            <b>${esc(m.annotation || '(bez věci)')}</b>
                            <span style="opacity:0.7;font-size:0.75rem;">ID zprávy ${esc(m.dmID)}</span>
                        </div>
                        <div>od: ${esc(m.sender || '—')}${m.senderRefNumber ? ` · č. j. ${esc(m.senderRefNumber)}` : ''}</div>
                        <div>📨 doručeno <b>${esc(czDate(m.deliveryDate))}</b>${how}${m.deliveryExact === false ? ' <span style="color:#f59e0b;">— ověřit</span>' : ''} · ${deadline} · ${spis}</div>
                        <div style="opacity:0.7;font-size:0.75rem;">přílohy: ${(m.files || []).map(f => esc(f.fileName)).join(', ') || '—'}</div>
                    </div>`;
                }).join('');
            } catch (err) {
                if (box) box.innerHTML = `<div style="color:#f87171;">Zprávy nejde načíst: ${esc(err.message)}</div>`;
            }
        },

        async datovkaUploadZfo(input) {
            const st = document.getElementById('dsx-zfo-status');
            const files = Array.from((input && input.files) || []);
            if (!files.length) return;
            const out = [];
            for (const f of files) {
                if (st) { st.textContent = `Nahrávám ${f.name}…`; st.style.color = ''; }
                try {
                    const base64 = await new Promise((resolve, reject) => {
                        const r = new FileReader();
                        r.onload = () => resolve(String(r.result).replace(/^data:.*?;base64,/, ''));
                        r.onerror = () => reject(new Error('soubor nejde přečíst'));
                        r.readAsDataURL(f);
                    });
                    const res = await fetch(`${this.apiBase}/inbox/upload`, {
                        method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ fileName: f.name, base64 })
                    });
                    const data = await res.json().catch(() => ({}));
                    out.push(res.ok ? `✅ ${f.name}: ${data.message || 'načteno'}` : `❌ ${f.name}: ${data.error || res.status}`);
                } catch (e) { out.push(`❌ ${f.name}: ${e.message}`); }
            }
            if (st) { st.textContent = out.join(' · '); st.style.color = out.some(x => x.startsWith('❌')) ? '#f87171' : '#4ade80'; }
            if (input) input.value = '';
            await this.loadDatovkaMessages();
            if (typeof this.loadInbox === 'function') this.loadInbox();
        }
    });

    // Po „Stáhnout teď“ obnovit i seznam zpráv v záložce.
    const origPoll = P.isdsPollNow;
    if (typeof origPoll === 'function') {
        P.isdsPollNow = async function () {
            await origPoll.apply(this, arguments);
            if (this.activeTab === 'datovka') { try { await this.loadDatovkaMessages({ keepStatus: true }); } catch (e) { /* ignore */ } }
        };
    }
})();
