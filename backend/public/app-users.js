// app-users.js — identita přihlášeného (hlavička) + správa uživatelů kanceláře (záložka „Uživatelé“).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
// Tokeny se zobrazí jen jednou po vytvoření (server je ukládá jen jako hash).
Object.assign(LexisLocalApp.prototype, {

    async initIdentity() {
        this.loadBranding();
        const chip = document.getElementById('me-chip');
        try {
            const res = await fetch(`${this.apiBase}/me`, { headers: this.getHeaders() });
            if (!res.ok) return;
            const me = await res.json();
            this.me = me;
            const isAdmin = (me.scopes || []).includes('admin');
            const nav = document.getElementById('nav-users');
            if (nav) nav.style.display = isAdmin ? '' : 'none';
            if (typeof this.applyProfile === 'function') this.applyProfile();
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
                const caret = document.createElement('span');
                caret.textContent = ' ▾'; caret.style.cssText = 'opacity:0.6;margin-left:4px;';
                chip.append(caret);
                if (!chip._menuBound) { chip._menuBound = true; chip.addEventListener('click', (e) => { e.stopPropagation(); this.toggleAccountMenu(); }); }
            }
        } catch (e) { /* identita je doplněk — dashboard funguje dál */ }
    },

    // Název a logo kanceláře v hlavičce postranního panelu a v titulku okna (GET /api/settings/kancelar).
    async loadBranding() {
        try {
            const r = await fetch(`${this.apiBase}/settings/kancelar`, { headers: this.getHeaders() });
            if (!r.ok) return;
            const k = await r.json();
            this.kancelar = k;
            const nm = document.getElementById('brand-name'), sub = document.getElementById('brand-sub'), logo = document.getElementById('brand-logo');
            if (nm) { nm.textContent = k.nazev || 'LexisLocal'; nm.title = k.nazev || ''; nm.classList.toggle('brand-name-firm', !!k.nazev); }
            if (sub) sub.textContent = k.nazev ? 'LexisLocal' : 'SECURITY HUB';
            if (logo) {
                logo.textContent = '';
                if (k.logo && /^data:image\/(png|jpeg|webp);base64,/.test(k.logo)) {
                    const img = document.createElement('img');
                    img.src = k.logo; img.alt = k.nazev ? `Logo – ${k.nazev}` : 'Logo kanceláře';
                    img.className = 'brand-logo-img';
                    logo.appendChild(img); logo.classList.add('has-img');
                } else { logo.textContent = '⚖️'; logo.classList.remove('has-img'); }
            }
            document.title = k.nazev ? `${k.nazev} · LexisLocal` : 'LexisLocal Hub — Právní AI pod kontrolou';
        } catch (e) { /* značka je doplněk */ }
    },

    // Menu účtu v hlavičce: kdo je přihlášen, z jakého zařízení, připojení dalšího zařízení, odhlášení.
    toggleAccountMenu(force) {
        const chip = document.getElementById('me-chip');
        let m = document.getElementById('account-menu');
        const open = force !== undefined ? force : !m;
        if (m) { m.remove(); m = null; }
        if (chip) chip.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open || !chip) return;
        const me = this.me || {};
        m = document.createElement('div');
        m.id = 'account-menu'; m.className = 'glass account-menu'; m.setAttribute('role', 'menu');
        const r = chip.getBoundingClientRect();
        m.style.cssText = `position:fixed;top:${Math.round(r.bottom + 6)}px;right:${Math.max(8, Math.round(window.innerWidth - r.right))}px;z-index:10002;`;
        const own = me.kind === 'user';
        const devs = Array.isArray(me.devices) ? me.devices.filter(d => !d.revoked) : [];
        m.innerHTML = `
            <div class="acc-head">
                ${this.kancelar && this.kancelar.nazev ? `<div class="acc-firm">${escapeHtml(this.kancelar.nazev)}</div>` : ''}
                <div class="acc-name">👤 ${escapeHtml(me.name || '—')}</div>
                <div class="acc-meta">${escapeHtml(me.roleLabel || (me.sharedIdentity ? 'Správce (hlavní účet)' : ''))}${me.device ? ' · ' + escapeHtml(me.device) : ''}</div>
                ${me.sharedIdentity ? `<div class="acc-warn">Přihlášen sdíleným hlavním účtem — úpravy se v historii zapíší jako „Místní uživatel“. Pro práci použijte vlastní účet.</div>` : ''}
            </div>
            ${own ? `<button type="button" class="acc-item" data-acc="pair">📱 Připojit další zařízení nebo prohlížeč</button>` : ''}
            ${own && devs.length ? `<div class="acc-sec">Moje zařízení (${devs.length})</div>${devs.map(d => `
                <div class="acc-dev"><span>${escapeHtml(d.label || 'zařízení')}${d.lastUsedAt ? ` <small>· naposledy ${escapeHtml(new Date(d.lastUsedAt).toLocaleDateString('cs-CZ'))}</small>` : ''}</span>
                ${d.id === me.deviceId ? '<small>toto</small>' : `<button type="button" class="acc-mini" data-revoke="${escapeHtml(d.id)}" title="Zrušit přístup ztraceného / nepoužívaného zařízení">Zrušit</button>`}</div>`).join('')}` : ''}
            <button type="button" class="acc-item acc-out" data-acc="logout">🚪 Odhlásit z tohoto prohlížeče</button>`;
        document.body.appendChild(m);
        const close = (e) => { if (!m.contains(e.target) && e.target !== chip) { this.toggleAccountMenu(false); document.removeEventListener('click', close); } };
        setTimeout(() => document.addEventListener('click', close), 0);
        m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.toggleAccountMenu(false); chip.focus(); } });
        const pairBtn = m.querySelector('[data-acc="pair"]');
        if (pairBtn) pairBtn.addEventListener('click', () => { this.toggleAccountMenu(false); this.pairOwnDevice(); });
        m.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
            if (!(await LexisUI.confirm('Zrušit přístup tohoto zařízení? Na něm se bude potřeba znovu přihlásit.'))) return;
            const x = await fetch(`${this.apiBase}/me/devices/${encodeURIComponent(b.dataset.revoke)}`, { method: 'DELETE', headers: this.getHeaders() });
            if (!x.ok) alert('❌ ' + ((await x.json().catch(() => ({}))).error || 'HTTP ' + x.status));
            this.toggleAccountMenu(false); await this.initIdentity();
        }));
        m.querySelector('[data-acc="logout"]').addEventListener('click', () => this.logoutBrowser());
    },

    async pairOwnDevice() {
        const label = await LexisUI.prompt('Název zařízení (např. „Notebook doma“, „iPhone“):', 'Další zařízení');
        if (label == null) return;
        try {
            const r = await fetch(`${this.apiBase}/pair/new`, { method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ deviceLabel: label || 'Další zařízení' }) });
            const d = await r.json();
            if (!r.ok) { alert('❌ ' + (d.error || 'HTTP ' + r.status)); return; }
            this.showPairLinks(d, label || 'Další zařízení');
            await this.initIdentity();
        } catch (e) { alert('❌ ' + e.message); }
    },

    // Párovací odkazy bez tokenu: dashboard v prohlížeči / telefon (platí 2 min, jednou).
    showPairLinks(p, label) {
        const old = document.getElementById('pair-links-modal'); if (old) old.remove();
        const ov = document.createElement('div');
        ov.id = 'pair-links-modal';
        ov.style.cssText = 'position:fixed;inset:0;z-index:10003;background:rgba(15,23,42,0.6);display:flex;align-items:center;justify-content:center;padding:16px;';
        const dash = (p.dashboardUrls || [])[0], phone = (p.urls || [])[0];
        ov.innerHTML = `<div class="glass" style="max-width:520px;width:100%;background:var(--bg-secondary);border-radius:14px;padding:22px;border:1px solid var(--border-glass);">
            <h3 style="margin:0 0 6px;">📱 Připojit zařízení „${escapeHtml(label)}“</h3>
            <div style="font-size:0.8rem;opacity:0.8;margin-bottom:12px;">Odkaz otevřete na novém zařízení do <strong id="pl-ttl">${Number(p.ttl) || 120}</strong> s. Platí jen jednou; zařízení se přihlásí vaším účtem.</div>
            ${dash ? `<div style="font-size:0.8rem;margin-bottom:4px;">Dashboard v prohlížeči (notebook, jiný počítač):</div>
            <div style="display:flex;gap:6px;margin-bottom:12px;"><input readonly id="pl-dash" value="${escapeHtml(dash)}" style="flex:1;font-size:0.72rem;padding:6px 8px;border-radius:6px;"><button class="btn btn-secondary" data-copy="pl-dash" style="padding:4px 10px;font-size:0.75rem;">Kopírovat</button></div>` : ''}
            ${phone ? `<div style="font-size:0.8rem;margin-bottom:4px;">Telefon / tablet (mobilní aplikace):</div>
            <div style="display:flex;gap:6px;margin-bottom:14px;"><input readonly id="pl-phone" value="${escapeHtml(phone)}" style="flex:1;font-size:0.72rem;padding:6px 8px;border-radius:6px;"><button class="btn btn-secondary" data-copy="pl-phone" style="padding:4px 10px;font-size:0.75rem;">Kopírovat</button></div>` : ''}
            <div style="text-align:right;"><button class="btn btn-primary" id="pl-close" style="padding:6px 16px;">Hotovo</button></div></div>`;
        document.body.appendChild(ov);
        ov.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
            const el = document.getElementById(b.dataset.copy);
            try { await navigator.clipboard.writeText(el.value); b.textContent = 'Zkopírováno ✓'; } catch (e) { el.select(); }
        }));
        let left = Number(p.ttl) || 120;
        const t = setInterval(() => { left--; const e = document.getElementById('pl-ttl'); if (e) e.textContent = left > 0 ? String(left) : '0 — vypršelo'; if (left <= 0) clearInterval(t); }, 1000);
        ov.querySelector('#pl-close').addEventListener('click', () => { clearInterval(t); ov.remove(); });
    },

    async logoutBrowser() {
        const loopbackAdmin = typeof window !== 'undefined' && !!window.LEXIS_API_TOKEN;
        const msg = loopbackAdmin
            ? 'Odhlásit váš účet z tohoto prohlížeče? Na tomto počítači (server kanceláře) pak dashboard poběží pod hlavním účtem správce.'
            : 'Odhlásit z tohoto prohlížeče? Pro další přihlášení budete potřebovat párovací odkaz nebo token.';
        if (!(await LexisUI.confirm(msg))) return;
        try { localStorage.removeItem('lexis_api_token'); } catch (e) { /* bez úložiště */ }
        location.reload();
    },

    // Karta „Kancelář“ (záložka Uživatelé, jen správce): název a logo do hlavičky dashboardu.
    async loadKancelarCard() {
        const el = document.getElementById('kancelar-card');
        if (!el) return;
        let k = { nazev: '', logo: null };
        try { const r = await fetch(`${this.apiBase}/settings/kancelar`, { headers: this.getHeaders() }); if (r.ok) k = await r.json(); } catch (e) { /* prázdné */ }
        el.innerHTML = `
            <h3 style="margin:0 0 6px;">🏢 Kancelář</h3>
            <p style="font-size:0.78rem;opacity:0.8;margin:0 0 10px;line-height:1.45;">Název a logo se zobrazí v hlavičce dashboardu všem uživatelům kanceláře.</p>
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
                <div id="kc-preview" class="kc-preview">${k.logo ? `<img src="${escapeHtml(k.logo)}" alt="Logo">` : '⚖️'}</div>
                <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:6px;">
                    <input id="kc-nazev" type="text" maxlength="120" placeholder="Advokátní kancelář …" value="${escapeHtml(k.nazev || '')}" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border-glass);background:var(--bg-primary);color:var(--text-primary);">
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <label class="btn btn-secondary" style="padding:4px 10px;font-size:0.75rem;cursor:pointer;">Nahrát logo<input id="kc-logo" type="file" accept="image/png,image/jpeg,image/webp" style="display:none;"></label>
                        ${k.logo ? '<button class="btn btn-secondary" id="kc-logo-del" style="padding:4px 10px;font-size:0.75rem;">Odebrat logo</button>' : ''}
                        <button class="btn btn-primary" id="kc-save" style="padding:4px 12px;font-size:0.75rem;">Uložit</button>
                    </div>
                    <div style="font-size:0.72rem;opacity:0.65;">PNG, JPEG nebo WebP; obrázek se zmenší na výšku 128 px.</div>
                </div>
            </div>`;
        let logo; // undefined = beze změny, null = odebrat, string = nové
        const fileIn = el.querySelector('#kc-logo');
        fileIn.addEventListener('change', async () => {
            const f = fileIn.files && fileIn.files[0];
            if (!f) return;
            try { logo = await this._shrinkLogo(f); el.querySelector('#kc-preview').innerHTML = `<img src="${escapeHtml(logo)}" alt="Logo">`; }
            catch (e) { alert('❌ ' + e.message); }
        });
        const del = el.querySelector('#kc-logo-del');
        if (del) del.addEventListener('click', () => { logo = null; el.querySelector('#kc-preview').textContent = '⚖️'; });
        el.querySelector('#kc-save').addEventListener('click', async () => {
            const body = { nazev: el.querySelector('#kc-nazev').value };
            if (logo !== undefined) body.logo = logo;
            const r = await fetch(`${this.apiBase}/settings/kancelar`, { method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { alert('❌ ' + (d.error || 'HTTP ' + r.status)); return; }
            await this.loadBranding();
            this.loadKancelarCard();
        });
    },

    // Logo zmenšené v prohlížeči na výšku 128 px (PNG zachová průhlednost) → data URL pod limit serveru.
    _shrinkLogo(file) {
        return new Promise((resolve, reject) => {
            if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Logo musí být PNG, JPEG nebo WebP.'));
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                const h = Math.min(128, img.naturalHeight || 128);
                const w = Math.max(1, Math.round((img.naturalWidth || h) * h / (img.naturalHeight || h)));
                const c = document.createElement('canvas'); c.width = Math.min(w, 512); c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                URL.revokeObjectURL(url);
                const out = c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
                if (out.length > 340000) return reject(new Error('Logo je i po zmenšení příliš velké.'));
                resolve(out);
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Obrázek nejde načíst.')); };
            img.src = url;
        });
    },

    async loadUsersTab() {
        if (typeof this.loadKancelarCard === 'function') this.loadKancelarCard();
        if (typeof this.loadFirmModeCard === 'function') this.loadFirmModeCard();
        if (typeof this.loadCodexisCard === 'function') this.loadCodexisCard();
        if (typeof this.loadProfileCard === 'function') this.loadProfileCard();
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
        const label = await LexisUI.prompt('Název zařízení (např. „LexisEditor – notebook“, „Telefon“):', 'LexisEditor');
        if (label === null) return;
        try {
            const r = await this._usersCall('POST', `/${encodeURIComponent(uid)}/devices`, { label });
            this.showUserSecret(r, `Nové zařízení pro „${r.user.name}“`);
            await this.loadUsersTab();
        } catch (err) { alert('❌ ' + err.message); }
    },

    async revokeUserDevice(uid, did, label) {
        if (!await LexisUI.confirm(`Zrušit zařízení „${label}“? Přestane okamžitě fungovat.`)) return;
        try { await this._usersCall('DELETE', `/${encodeURIComponent(uid)}/devices/${encodeURIComponent(did)}`); await this.loadUsersTab(); }
        catch (err) { alert('❌ ' + err.message); }
    },

    async changeUserRole(uid, role) {
        try { await this._usersCall('PATCH', `/${encodeURIComponent(uid)}`, { role }); }
        catch (err) { alert('❌ ' + err.message); }
        await this.loadUsersTab();
    },

    async setUserDisabled(uid, disabled) {
        if (disabled && !await LexisUI.confirm('Deaktivovat uživatele? Všechna jeho zařízení se okamžitě odhlásí. Jméno zůstane v historii a auditu.')) return;
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
            ${(p.dashboardUrls || [])[0] ? `<div style="font-size:0.78rem;margin-bottom:4px;">Dashboard v prohlížeči (přihlásí se tímto účtem): otevřete odkaz</div>
                <div style="display:flex;gap:6px;margin-bottom:10px;"><input readonly id="usr-dash-link" value="${escapeHtml(p.dashboardUrls[0])}" style="flex:1;font-size:0.72rem;padding:6px 8px;border-radius:6px;"><button class="btn btn-secondary" data-copy="usr-dash-link" style="padding:4px 10px;font-size:0.75rem;">Kopírovat</button></div>` : ''}
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

// ── Firemní režim + přístup ke spisu ────────────────────────────────────────
Object.assign(LexisLocalApp.prototype, {

    async loadFirmModeCard() {
        const el = document.getElementById('firm-mode-card');
        if (!el) return;
        try {
            const r = await fetch(`${this.apiBase}/settings/firm-mode`, { headers: this.getHeaders() });
            const d = await r.json();
            if (!r.ok) { el.innerHTML = `<div style="color:#b45309;">${escapeHtml(d.error || 'Nelze načíst.')}</div>`; return; }
            const locked = d.source === 'env';
            el.innerHTML = `
                <h3 style="margin:0 0 6px;">🔐 Firemní režim</h3>
                <p style="font-size:0.78rem;opacity:0.8;margin:0 0 10px;line-height:1.45;">
                    Zapnutý: každý uživatel vidí jen spisy, které vlastní nebo které s ním někdo sdílel (správce vidí vše).
                    Vypnutý: všichni přihlášení vidí všechny spisy.</p>
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <strong style="color:${d.enabled ? '#15803d' : 'var(--text-secondary)'};">${d.enabled ? 'Zapnuto' : 'Vypnuto'}</strong>
                    ${locked ? '<span style="font-size:0.75rem;opacity:0.7;">(pevně nastaveno na serveru proměnnou LEXIS_FIRM_MODE)</span>'
                        : `<button class="btn ${d.enabled ? 'btn-secondary' : 'btn-primary'}" id="firm-mode-toggle" data-on="${d.enabled ? '0' : '1'}" style="padding:5px 12px;font-size:0.8rem;">${d.enabled ? 'Vypnout' : 'Zapnout'}</button>`}
                </div>
                <div id="kor-card" style="margin-top:10px;font-size:0.8rem;"></div>
                ${d.spisyWithoutOwnerAccount ? `<div style="font-size:0.75rem;color:#b45309;margin-top:8px;">⚠️ ${escapeHtml(String(d.spisyWithoutOwnerAccount))} z ${escapeHtml(String(d.spisy))} spisů nemá vlastníka s účtem — ve firemním režimu je uvidí jen správce. Vlastníka nastavíte v detailu spisu (Spisová služba → spis → Přístup).</div>` : ''}`;
            const btn = document.getElementById('firm-mode-toggle');
            if (btn) btn.addEventListener('click', () => this.setFirmMode(btn.dataset.on === '1'));
            this.loadKorespondenceToggle();
        } catch (e) { el.innerHTML = `<div style="color:#b45309;">⚠️ ${escapeHtml(e.message)}</div>`; }
    },

    // Podatelna smí připravovat rutinní korespondenci (výchozí vypnuto, přepíná správce).
    async loadKorespondenceToggle() {
        const el = document.getElementById('kor-card');
        if (!el) return;
        try {
            const r = await fetch(`${this.apiBase}/settings/podatelna-korespondence`, { headers: this.getHeaders() });
            const d = await r.json();
            el.innerHTML = `✉️ Podatelna smí připravovat rutinní korespondenci (vždy ke schválení advokátem): <strong>${d.enabled ? 'ano' : 'ne'}</strong>
                ${d.source === 'env' ? '<span style="opacity:0.7;">(pevně na serveru)</span>' : `<button class="btn btn-secondary" id="kor-toggle" style="padding:3px 10px;font-size:0.75rem;margin-left:6px;">${d.enabled ? 'Zakázat' : 'Povolit'}</button>`}`;
            const b = document.getElementById('kor-toggle');
            if (b) b.addEventListener('click', async () => {
                const x = await fetch(`${this.apiBase}/settings/podatelna-korespondence`, { method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ enabled: !d.enabled }) });
                if (!x.ok) alert('❌ ' + ((await x.json().catch(() => ({}))).error || 'HTTP ' + x.status));
                this.loadKorespondenceToggle();
            });
        } catch (e) { el.textContent = ''; }
    },

    // CODEXIS AI — licence kanceláře, zapíná správce. Klíč se jen ukládá, nikdy nezobrazuje.
    async loadCodexisCard() {
        const el = document.getElementById('codexis-card');
        if (!el) return;
        try {
            const r = await fetch(`${this.apiBase}/settings/codexis`, { headers: this.getHeaders() });
            const d = await r.json();
            const stav = d.localOnly ? 'Zakázáno lokálním režimem (mlčenlivost)'
                : d.enabled ? 'Zapnuto' : d.configured ? 'Vypnuto (klíč uložen)' : 'Nenastaveno';
            el.innerHTML = `
                <h3 style="margin:0 0 6px;">📚 CODEXIS AI (volitelné)</h3>
                <p style="font-size:0.78rem;opacity:0.8;margin:0 0 10px;line-height:1.45;">
                    Pro kanceláře s vlastní licencí CODEXIS AI: rešeršník se může zeptat jejich databáze (komentáře, judikatura).
                    Každý dotaz čerpá kredity vaší licence. <b>Odchází jen obecná právní otázka</b> — osobní údaje se odstraní,
                    dokumenty spisu se neposílají; CODEXIS AI ale využívá i externí AI (OpenAI). Každý dotaz se zapisuje do auditu.</p>
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
                    <strong style="color:${d.enabled ? '#15803d' : 'var(--text-secondary)'};">${escapeHtml(stav)}</strong>
                    ${d.configured && !d.localOnly ? `<button class="btn ${d.switchOn ? 'btn-secondary' : 'btn-primary'}" id="cx-toggle" style="padding:5px 12px;font-size:0.8rem;">${d.switchOn ? 'Vypnout' : 'Zapnout'}</button>
                        <button class="btn btn-secondary" id="cx-check" style="padding:5px 12px;font-size:0.8rem;">Ověřit licenci</button>` : ''}
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <input type="password" id="cx-key" placeholder="${d.configured ? 'Nový klíč API (nahradí uložený)' : 'Klíč API z CODEXIS AI (Nastavení → Komunikační kanály → API)'}" autocomplete="off" style="flex:1;min-width:220px;font-size:0.8rem;">
                    <button class="btn btn-secondary" id="cx-save" style="padding:5px 12px;font-size:0.8rem;">Uložit klíč</button>
                    ${d.configured ? '<button class="btn btn-secondary" id="cx-remove" style="padding:5px 12px;font-size:0.8rem;">Odebrat klíč</button>' : ''}
                </div>
                <div id="cx-msg" style="font-size:0.78rem;margin-top:6px;"></div>`;
            const msg = (t, ok) => { const m = document.getElementById('cx-msg'); if (m) { m.textContent = t; m.style.color = ok ? '#15803d' : '#b45309'; } };
            const post = async (p, body) => {
                const rr = await fetch(`${this.apiBase}/settings/codexis${p}`, { method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}) });
                const dd = await rr.json().catch(() => ({}));
                if (!rr.ok) throw new Error(dd.error || ('HTTP ' + rr.status));
                return dd;
            };
            const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
            on('cx-save', async () => {
                const k = (document.getElementById('cx-key').value || '').trim();
                if (!k) return msg('Vložte klíč.', false);
                try { await post('', { apiKey: k }); this.loadCodexisCard(); } catch (e) { msg('❌ ' + e.message, false); }
            });
            on('cx-remove', async () => {
                if (!await LexisUI.confirm('Odebrat klíč CODEXIS AI?')) return;
                try { await post('', { apiKey: '', enabled: false }); this.loadCodexisCard(); } catch (e) { msg('❌ ' + e.message, false); }
            });
            on('cx-toggle', async () => {
                if (!d.switchOn && !await LexisUI.confirm('Zapnout CODEXIS AI? Rešeršní otázky (bez údajů klienta) pak mohou odcházet mimo kancelář a čerpat kredity licence.')) return;
                try { await post('', { enabled: !d.switchOn }); this.loadCodexisCard(); } catch (e) { msg('❌ ' + e.message, false); }
            });
            on('cx-check', async () => {
                msg('Ověřuji…', true);
                try { const c = await post('/check'); msg(c.ok ? `✅ Klíč platí (virtuální stroj: ${c.vm || '?'})` : '❌ ' + c.error, c.ok); } catch (e) { msg('❌ ' + e.message, false); }
            });
        } catch (e) { el.innerHTML = `<div style="color:#b45309;">⚠️ ${escapeHtml(e.message)}</div>`; }
    },

    // Pilotní profil: skryje v navigaci moduly, které v pilotu nejsou.
    async applyProfile() {
        try {
            const r = await fetch(`${this.apiBase}/settings/profile`, { headers: this.getHeaders() });
            if (!r.ok) return;
            const d = await r.json();
            const hidden = new Set(d.hiddenTabs || []);
            document.querySelectorAll('.sidebar-nav .nav-btn[data-tab]').forEach(b => {
                if (b.id === 'nav-users') return;
                b.hidden = hidden.has(b.dataset.tab);
            });
            const active = document.querySelector('.sidebar-nav .nav-btn.active');
            if (active && active.hidden && typeof this.switchTab === 'function') this.switchTab('overview');
            this.profile = d.profile;
        } catch (e) { /* bez profilu je vidět vše */ }
    },

    async loadProfileCard() {
        const el = document.getElementById('profile-card');
        if (!el) return;
        try {
            const r = await fetch(`${this.apiBase}/settings/profile`, { headers: this.getHeaders() });
            const d = await r.json();
            const pilot = d.profile === 'pilot';
            el.innerHTML = `
                <h3 style="margin:0 0 6px;">🧪 Pilotní profil</h3>
                <p style="font-size:0.78rem;opacity:0.8;margin:0 0 10px;line-height:1.45;">
                    Zapnutý: v nabídce zůstane jen doručená pošta, lhůty a jednání, spisy, koncepty, asistenti, lustrace a audit.
                    Skryje se správce modelů, konzultace s AI, time-tracking, rizika a judikatura, AML a manažerský přehled. Data se nemažou.</p>
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <strong style="color:${pilot ? '#15803d' : 'var(--text-secondary)'};">${pilot ? 'Zapnuto' : 'Vypnuto'}</strong>
                    ${d.source === 'env' ? '<span style="font-size:0.75rem;opacity:0.7;">(pevně nastaveno na serveru proměnnou LEXIS_PROFILE)</span>'
                        : `<button class="btn ${pilot ? 'btn-secondary' : 'btn-primary'}" id="profile-toggle" style="padding:5px 12px;font-size:0.8rem;">${pilot ? 'Vypnout' : 'Zapnout'}</button>`}
                </div>`;
            const btn = document.getElementById('profile-toggle');
            if (btn) btn.addEventListener('click', async () => {
                const rr = await fetch(`${this.apiBase}/settings/profile`, { method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ profile: pilot ? 'full' : 'pilot' }) });
                const dd = await rr.json().catch(() => ({}));
                if (!rr.ok) alert('❌ ' + (dd.error || ('HTTP ' + rr.status)));
                await this.applyProfile();
                this.loadProfileCard();
            });
        } catch (e) { el.innerHTML = `<div style="color:#b45309;">⚠️ ${escapeHtml(e.message)}</div>`; }
    },

    async setFirmMode(enabled) {
        if (enabled && !await LexisUI.confirm('Zapnout firemní režim? Uživatelé pak uvidí jen své a nasdílené spisy.')) return;
        try {
            const r = await fetch(`${this.apiBase}/settings/firm-mode`, { method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ enabled }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) alert('❌ ' + (d.error || ('HTTP ' + r.status)));
        } catch (e) { alert('❌ ' + e.message); }
        this.loadFirmModeCard();
    },

    async renderSpisAccess(spisId) {
        const el = document.getElementById('ss-spis-access');
        if (!el) return;
        const H = this.getHeaders();
        try {
            const [cr, ar, fr] = await Promise.all([
                fetch(`${this.apiBase}/me/colleagues`, { headers: H }),
                fetch(`${this.apiBase}/spisy/${encodeURIComponent(spisId)}/access`, { headers: H }),
                fetch(`${this.apiBase}/settings/firm-mode`, { headers: H })
            ]);
            const colleagues = cr.ok ? ((await cr.json()).users || []) : [];
            if (!colleagues.length) { el.innerHTML = ''; return; } // bez uživatelů nemá sdílení smysl
            const acc = ar.ok ? (await ar.json()).access : null;
            const firm = fr.ok ? (await fr.json()).enabled : false;
            if (!acc) { el.innerHTML = ''; return; }
            const byId = Object.fromEntries(colleagues.map(u => [u.id, u]));
            const nm = (id) => byId[id] ? byId[id].name : id;
            const me = this.me || {};
            const canManage = (me.scopes || []).includes('admin') || me.userId === acc.owner;
            const shared = [...acc.writers.map(id => ({ id, level: 'write' })), ...(acc.filers || []).map(id => ({ id, level: 'podatelna' })), ...acc.readers.map(id => ({ id, level: 'read' }))];
            const sid = String(spisId).replace(/[^A-Za-z0-9_.:-]/g, '');
            const opts = (filter) => colleagues.filter(filter).map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)} (${escapeHtml(u.roleLabel || u.role)})</option>`).join('');
            el.innerHTML = `
                <div class="glass" style="padding:12px 14px;border-radius:10px;border:1px solid var(--border-glass);font-size:0.82rem;">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                        <strong>🔐 Přístup</strong>
                        <span style="font-size:0.72rem;opacity:0.75;">${firm ? 'Firemní režim: přístup se vynucuje' : 'Firemní režim vypnutý — přístup se zatím nevynucuje'}</span>
                    </div>
                    <div style="margin-top:8px;">Vlastník: <b>${escapeHtml(nm(acc.owner))}</b>
                        ${canManage ? `<select id="acc-owner" style="margin-left:6px;padding:3px 6px;border-radius:6px;font-size:0.78rem;"><option value="">— změnit —</option>${opts(u => u.id !== acc.owner)}</select>` : ''}</div>
                    <div style="margin-top:6px;">Sdíleno s: ${shared.length ? shared.map(x => `<span style="display:inline-flex;align-items:center;gap:4px;margin:2px 6px 2px 0;padding:2px 8px;border-radius:12px;background:var(--sf-02);">${escapeHtml(nm(x.id))} · ${x.level === 'write' ? 'úpravy' : x.level === 'podatelna' ? 'podatelna' : 'čtení'}${canManage ? ` <a href="#" data-revoke="${escapeHtml(x.id)}" title="Odebrat přístup" style="text-decoration:none;">✕</a>` : ''}</span>`).join('') : '<span style="opacity:0.6;">nikým</span>'}</div>
                    ${canManage ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                        <select id="acc-share-user" style="padding:3px 6px;border-radius:6px;font-size:0.78rem;"><option value="">Sdílet s…</option>${opts(u => u.id !== acc.owner && !shared.some(x => x.id === u.id))}</select>
                        <select id="acc-share-level" style="padding:3px 6px;border-radius:6px;font-size:0.78rem;"><option value="read">jen čtení</option><option value="podatelna" title="Čte spis, zařazuje došlé dokumenty, potvrzuje lhůty, fakturuje; nemění spis ani dokumenty ve spisu">podatelna (došlá pošta, lhůty)</option><option value="write">čtení i úpravy</option></select>
                        <button class="btn btn-secondary" id="acc-share-btn" style="padding:3px 10px;font-size:0.75rem;">Sdílet</button></div>` : ''}
                </div>`;
            const post = async (path, body) => {
                const r = await fetch(`${this.apiBase}/spisy/${encodeURIComponent(sid)}/${path}`, { method: 'POST', headers: this.getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) alert('❌ ' + (d.error || ('HTTP ' + r.status)));
                this.renderSpisAccess(sid);
            };
            const own = document.getElementById('acc-owner');
            if (own) own.addEventListener('change', async () => { if (own.value && await LexisUI.confirm('Změnit vlastníka spisu?')) post('owner', { userId: own.value }); });
            const sb = document.getElementById('acc-share-btn');
            if (sb) sb.addEventListener('click', () => {
                const u = document.getElementById('acc-share-user').value;
                if (u) post('share', { userId: u, level: document.getElementById('acc-share-level').value });
            });
            el.querySelectorAll('[data-revoke]').forEach(a => a.addEventListener('click', async (ev) => {
                ev.preventDefault();
                if (await LexisUI.confirm('Odebrat přístup ke spisu?')) post('revoke', { userId: a.dataset.revoke });
            }));
        } catch (e) { el.innerHTML = ''; }
    }
});
