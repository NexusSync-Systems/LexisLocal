// app-users.js — identita přihlášeného (hlavička) + správa uživatelů kanceláře (záložka „Uživatelé“).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
// Tokeny se zobrazí jen jednou po vytvoření (server je ukládá jen jako hash).
Object.assign(LexisLocalApp.prototype, {

    async initIdentity() {
        const chip = document.getElementById('me-chip');
        try {
            const res = await fetch(`${this.apiBase}/me`, { headers: this.getHeaders() });
            if (!res.ok) return;
            const me = await res.json();
            this.me = me;
            const isAdmin = (me.scopes || []).includes('admin');
            const nav = document.getElementById('nav-users');
            if (nav) nav.style.display = isAdmin ? '' : 'none';
            if (chip) {
                chip.style.display = '';
                chip.textContent = '';
                const name = document.createElement('strong');
                name.textContent = me.name || '—';
                const role = document.createElement('span');
                role.style.cssText = 'opacity:0.7;margin-left:6px;font-size:0.75rem;';
                role.textContent = me.roleLabel || '';
                chip.append('👤 ', name, role);
                chip.title = me.sharedIdentity
                    ? 'Sdílený hlavní účet — úpravy se v historii zobrazí jako „Místní uživatel“. Založte kolegům vlastní účty v záložce Uživatelé.'
                    : `Přihlášen(a) jako ${me.name}${me.device ? ' · zařízení: ' + me.device : ''}`;
                chip.classList.toggle('me-chip-shared', !!me.sharedIdentity);
            }
        } catch (e) { /* identita je doplněk — dashboard funguje dál */ }
    },

    async loadUsersTab() {
        const list = document.getElementById('users-list');
        const roleSel = document.getElementById('user-new-role');
        if (!list) return;
        list.innerHTML = '<div style="opacity:0.6;padding:12px;">Načítám uživatele…</div>';
        try {
            const res = await fetch(`${this.apiBase}/users`, { headers: this.getHeaders() });
            const data = await res.json();
            if (!res.ok) { list.innerHTML = `<div style="color:#b45309;padding:12px;">${escapeHtml(data.error || 'Nelze načíst uživatele.')}</div>`; return; }
            this.usersRoles = data.roles || [];
            if (roleSel && !roleSel.options.length) {
                this.usersRoles.forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; roleSel.appendChild(o); });
                roleSel.value = 'koncipient';
            }
            this.renderUsers(data.users || []);
        } catch (e) {
            list.innerHTML = `<div style="color:#b45309;padding:12px;">⚠️ ${escapeHtml(e.message)}</div>`;
        }
    },

    renderUsers(users) {
        const list = document.getElementById('users-list');
        if (!users.length) {
            list.innerHTML = `<div style="padding:16px;opacity:0.75;line-height:1.5;">Zatím žádní uživatelé. Všichni se přihlašují sdíleným hlavním tokenem, takže historie konceptů a audit ukazují jen „Místní uživatel“.<br>Založte každému kolegovi vlastní účet — pak bude vidět, kdo co upravil a schválil.</div>`;
            return;
        }
        const fmt = (d) => d ? new Date(d).toLocaleString('cs-CZ') : 'nikdy';
        const roleOpts = (cur) => (this.usersRoles || []).map(r => `<option value="${escapeHtml(r.id)}"${r.id === cur ? ' selected' : ''}>${escapeHtml(r.label)}</option>`).join('');
        list.innerHTML = users.map(u => `
            <div class="glass user-card" style="padding:14px 16px;border-radius:10px;border:1px solid var(--border-glass);${u.disabled ? 'opacity:0.55;' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                    <div>
                        <strong style="font-size:0.95rem;">${escapeHtml(u.name)}</strong>
                        ${u.disabled ? '<span style="margin-left:6px;font-size:0.7rem;padding:2px 6px;border-radius:4px;background:var(--sf-03);">deaktivován</span>' : ''}
                        <div style="font-size:0.72rem;opacity:0.65;margin-top:2px;">Založen ${escapeHtml(fmt(u.createdAt))}${u.createdBy ? ' · ' + escapeHtml(u.createdBy) : ''}</div>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                        <select data-uid="${escapeHtml(u.id)}" onchange="window.appInstance.changeUserRole(this.dataset.uid, this.value)" ${u.disabled ? 'disabled' : ''} style="padding:5px 8px;border-radius:6px;font-size:0.8rem;">${roleOpts(u.role)}</select>
                        ${u.disabled ? '' : `<button class="btn btn-secondary" data-uid="${escapeHtml(u.id)}" onclick="window.appInstance.addUserDevice(this.dataset.uid)" style="padding:5px 10px;font-size:0.75rem;">＋ Zařízení / párovat</button>`}
                        <button class="btn btn-secondary" data-uid="${escapeHtml(u.id)}" data-off="${u.disabled ? '0' : '1'}" onclick="window.appInstance.setUserDisabled(this.dataset.uid, this.dataset.off === '1')" style="padding:5px 10px;font-size:0.75rem;">${u.disabled ? 'Znovu aktivovat' : 'Deaktivovat'}</button>
                    </div>
                </div>
                <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px;">
                    ${(u.devices || []).length ? u.devices.map(d => `
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;padding:5px 8px;border-radius:6px;background:var(--sf-01);">
                            <span>💻 ${escapeHtml(d.label)} <span style="opacity:0.6;">· použito ${escapeHtml(fmt(d.lastUsedAt))}</span></span>
                            <button class="btn btn-secondary" data-uid="${escapeHtml(u.id)}" data-did="${escapeHtml(d.id)}" data-label="${escapeHtml(d.label)}" onclick="window.appInstance.revokeUserDevice(this.dataset.uid, this.dataset.did, this.dataset.label)" style="padding:2px 8px;font-size:0.7rem;">Zrušit</button>
                        </div>`).join('') : '<div style="font-size:0.75rem;opacity:0.6;">Žádné aktivní zařízení.</div>'}
                </div>
            </div>`).join('');
    },

    async _usersCall(method, path, body) {
        const res = await fetch(`${this.apiBase}/users${path}`, {
            method, headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
    },

    async createUser(e) {
        if (e) e.preventDefault();
        const name = document.getElementById('user-new-name').value.trim();
        const role = document.getElementById('user-new-role').value;
        const deviceLabel = document.getElementById('user-new-device').value.trim() || 'LexisEditor';
        if (!name) return;
        try {
            const r = await this._usersCall('POST', '', { name, role, deviceLabel });
            document.getElementById('user-new-name').value = '';
            this.showUserSecret(r, `Účet „${r.user.name}“ je založený`);
            await this.loadUsersTab();
        } catch (err) { alert('❌ ' + err.message); }
    },

    async addUserDevice(uid) {
        const label = prompt('Název zařízení (např. „LexisEditor – notebook“, „Telefon“):', 'LexisEditor');
        if (label === null) return;
        try {
            const r = await this._usersCall('POST', `/${encodeURIComponent(uid)}/devices`, { label });
            this.showUserSecret(r, `Nové zařízení pro „${r.user.name}“`);
            await this.loadUsersTab();
        } catch (err) { alert('❌ ' + err.message); }
    },

    async revokeUserDevice(uid, did, label) {
        if (!confirm(`Zrušit zařízení „${label}“? Přestane okamžitě fungovat.`)) return;
        try { await this._usersCall('DELETE', `/${encodeURIComponent(uid)}/devices/${encodeURIComponent(did)}`); await this.loadUsersTab(); }
        catch (err) { alert('❌ ' + err.message); }
    },

    async changeUserRole(uid, role) {
        try { await this._usersCall('PATCH', `/${encodeURIComponent(uid)}`, { role }); }
        catch (err) { alert('❌ ' + err.message); }
        await this.loadUsersTab();
    },

    async setUserDisabled(uid, disabled) {
        if (disabled && !confirm('Deaktivovat uživatele? Všechna jeho zařízení se okamžitě odhlásí. Jméno zůstane v historii a auditu.')) return;
        try { await this._usersCall('PATCH', `/${encodeURIComponent(uid)}`, { disabled }); }
        catch (err) { alert('❌ ' + err.message); }
        await this.loadUsersTab();
    },

    // Jednorázové zobrazení přístupu: párovací odkazy (2 min) + token pro ruční zadání.
    showUserSecret(r, heading) {
        const old = document.getElementById('user-secret-modal'); if (old) old.remove();
        const ov = document.createElement('div');
        ov.id = 'user-secret-modal';
        ov.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(15,23,42,0.6);display:flex;align-items:center;justify-content:center;padding:16px;';
        const box = document.createElement('div');
        box.className = 'glass';
        box.style.cssText = 'max-width:560px;width:100%;background:var(--bg-secondary);border-radius:14px;padding:22px;border:1px solid var(--border-glass);max-height:90vh;overflow:auto;';
        const p = r.pairing || {};
        const editorLink = p.editor && p.editor.connectUrl;
        const phoneLink = (p.urls || [])[0];
        box.innerHTML = `
            <h3 style="margin:0 0 4px;">${escapeHtml(heading)}</h3>
            <div style="font-size:0.8rem;opacity:0.75;margin-bottom:14px;">Zařízení: <strong>${escapeHtml(r.device && r.device.label)}</strong> · role ${escapeHtml(r.user.roleLabel || r.user.role)}</div>
            <div style="font-size:0.82rem;font-weight:700;margin-bottom:4px;">1) Párování (platí <span id="usr-pair-ttl">${Number(p.ttl) || 120}</span> s, jednorázově)</div>
            ${editorLink ? `<div style="font-size:0.78rem;margin-bottom:6px;">LexisEditor: Nastavení → Server LexisLocal v kanceláři → Spárovat → vložte odkaz:</div>
                <div style="display:flex;gap:6px;margin-bottom:10px;"><input readonly id="usr-editor-link" value="${escapeHtml(editorLink)}" style="flex:1;font-size:0.72rem;padding:6px 8px;border-radius:6px;"><button class="btn btn-secondary" data-copy="usr-editor-link" style="padding:4px 10px;font-size:0.75rem;">Kopírovat</button></div>
                <div style="font-size:0.72rem;opacity:0.7;margin-bottom:10px;">Otisk serveru (ověřte v editoru): <code>${escapeHtml(p.editor.pinShort || '')}</code></div>` : `<div style="font-size:0.75rem;opacity:0.7;margin-bottom:10px;">Odkaz pro LexisEditor je k dispozici jen na HTTPS serveru — použijte token níže.</div>`}
            ${phoneLink ? `<div style="font-size:0.78rem;margin-bottom:4px;">Telefon / tablet: otevřete odkaz</div>
                <div style="display:flex;gap:6px;margin-bottom:12px;"><input readonly id="usr-phone-link" value="${escapeHtml(phoneLink)}" style="flex:1;font-size:0.72rem;padding:6px 8px;border-radius:6px;"><button class="btn btn-secondary" data-copy="usr-phone-link" style="padding:4px 10px;font-size:0.75rem;">Kopírovat</button></div>` : ''}
            <div style="font-size:0.82rem;font-weight:700;margin:6px 0 4px;">2) Nebo ruční zadání tokenu</div>
            <div style="font-size:0.75rem;color:#b45309;margin-bottom:6px;">Token se zobrazí jen teď — server ho neukládá. Předejte ho bezpečně (osobně, ne e-mailem).</div>
            <div style="display:flex;gap:6px;margin-bottom:16px;"><input readonly type="password" id="usr-token" value="${escapeHtml(r.token)}" style="flex:1;font-family:monospace;font-size:0.72rem;padding:6px 8px;border-radius:6px;"><button class="btn btn-secondary" id="usr-token-show" style="padding:4px 10px;font-size:0.75rem;">Zobrazit</button><button class="btn btn-secondary" data-copy="usr-token" style="padding:4px 10px;font-size:0.75rem;">Kopírovat</button></div>
            <div style="text-align:right;"><button class="btn btn-primary" id="usr-secret-close" style="padding:6px 16px;">Hotovo</button></div>`;
        ov.appendChild(box);
        document.body.appendChild(ov);
        box.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
            const el = document.getElementById(b.dataset.copy);
            try { await navigator.clipboard.writeText(el.value); b.textContent = 'Zkopírováno ✓'; }
            catch (e) { el.type = 'text'; el.select(); }
        }));
        box.querySelector('#usr-token-show').addEventListener('click', () => { const t = document.getElementById('usr-token'); t.type = t.type === 'password' ? 'text' : 'password'; });
        let left = Number(p.ttl) || 120;
        const ttlEl = box.querySelector('#usr-pair-ttl');
        const timer = setInterval(() => { left--; if (ttlEl) ttlEl.textContent = left > 0 ? String(left) : '0 — vypršelo, použijte token nebo vytvořte nové zařízení'; if (left <= 0) clearInterval(timer); }, 1000);
        const close = () => { clearInterval(timer); ov.remove(); };
        box.querySelector('#usr-secret-close').addEventListener('click', close);
    }
});

// Identita do hlavičky hned po startu (instance vzniká v app.js na DOMContentLoaded).
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => { if (window.appInstance && window.appInstance.initIdentity) window.appInstance.initIdentity(); }, 0);
});
