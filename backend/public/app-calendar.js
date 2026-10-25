// app-calendar.js — část dashboardu vytažená z app.js (prototype-mixin, beze změny chování).
// Načítá se v index.html PO app.js. Metody se přidávají na LexisLocalApp.prototype.
Object.assign(LexisLocalApp.prototype, {

    renderCalendar() {
        const monthYearEl = document.getElementById('calendar-month-year');
        const daysContainer = document.getElementById('calendar-days-grid');
        if (!monthYearEl || !daysContainer) return;

        const currentYear = this.calendarState.currentYear;
        const currentMonth = this.calendarState.currentMonth;

        const monthNamesCs = [
            "Leden", "Únor", "Březen", "Duben", "Květen", "Červen", 
            "Červenec", "Srpen", "Září", "Říjen", "Listopad", "Prosinec"
        ];

        monthYearEl.textContent = `${monthNamesCs[currentMonth]} ${currentYear}`;

        // Calculate days to display
        let firstDayIndex = new Date(currentYear, currentMonth, 1).getDay();
        if (firstDayIndex === 0) firstDayIndex = 7; // Convert Sunday to 7
        
        const prevMonthDays = new Date(currentYear, currentMonth, 0).getDate();
        const currentMonthDays = new Date(currentYear, currentMonth + 1, 0).getDate();

        const days = [];

        // Prev month days padding
        const prevDaysCount = firstDayIndex - 1;
        for (let i = prevDaysCount; i > 0; i--) {
            days.push({
                day: prevMonthDays - i + 1,
                dateString: null,
                isPrevNext: true
            });
        }

        // Current month days
        for (let i = 1; i <= currentMonthDays; i++) {
            const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
            days.push({
                day: i,
                dateString: dateStr,
                isPrevNext: false
            });
        }

        // Next month days padding to make full grid of 42
        const remaining = 42 - days.length;
        for (let i = 1; i <= remaining; i++) {
            days.push({
                day: i,
                dateString: null,
                isPrevNext: true
            });
        }

        // Render days
        daysContainer.innerHTML = '';
        days.forEach(day => {
            const cell = document.createElement('div');
            cell.className = 'calendar-day';
            
            if (day.isPrevNext) {
                cell.classList.add('prev-next');
                cell.innerHTML = `<span class="day-number">${day.day}</span>`;
                daysContainer.appendChild(cell);
                return;
            }

            if (day.dateString === this.calendarState.selectedDate) {
                cell.classList.add('active');
            }

            const _n = new Date(); const todayStr = `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, '0')}-${String(_n.getDate()).padStart(2, '0')}`;
            if (day.dateString === todayStr) {
                cell.classList.add('today');
            }

            const dayEvents = this.calendarState.events.filter(e => e.date === day.dateString);
            
            let dotsHtml = '';
            if (dayEvents.length > 0) {
                dotsHtml = '<div class="calendar-day-events">';
                // Render max 3 dots, then "+" indicator
                const renderLimit = 3;
                dayEvents.slice(0, renderLimit).forEach(e => {
                    const dotClass = e.status === 'completed' ? 'completed' : e.type === 'hearing' ? 'hearing' : 'deadline';
                    dotsHtml += `<span class="calendar-day-dot ${dotClass}" title="${escapeHtml(e.title)}"></span>`;
                });
                if (dayEvents.length > renderLimit) {
                    dotsHtml += `<span style="font-size:0.6rem; line-height:1; opacity:0.6; margin-left:1px;">+</span>`;
                }
                dotsHtml += '</div>';
            }

            cell.innerHTML = `
                <span class="day-number">${day.day}</span>
                ${dotsHtml}
            `;

            cell.addEventListener('click', () => this.selectDay(day.dateString));
            daysContainer.appendChild(cell);
        });
    },

    renderAgenda() {
        const agendaEl = document.getElementById('calendar-day-agenda');
        const dateLabel = document.getElementById('calendar-selected-date-label');
        if (!agendaEl || !dateLabel) return;

        const selectedDate = this.calendarState.selectedDate;
        const parts = selectedDate.split('-');
        dateLabel.textContent = `${parseInt(parts[2])}. ${parseInt(parts[1])}. ${parts[0]}`;

        const dayEvents = this.calendarState.events.filter(e => e.date === selectedDate);

        if (dayEvents.length === 0) {
            agendaEl.innerHTML = `
                <div style="text-align: center; padding: 30px; opacity: 0.6; font-size: 0.85rem;">
                    🌴 Dnes nemáte žádné lhůty ani jednání.
                </div>
            `;
            return;
        }

        agendaEl.innerHTML = dayEvents.map(event => {
            const isCompleted = event.status === 'completed';
            const isCancelled = event.status === 'cancelled';
            const isHearing = event.type === 'hearing';

            let icon = '⏰';
            let typeLabel = 'Procesní lhůta';
            let itemClass = 'deadline';

            if (isCompleted) {
                icon = '🟢';
                itemClass = 'completed';
            } else if (isCancelled) {
                icon = '❌';
                typeLabel = 'ZRUŠENÉ JEDNÁNÍ';
                itemClass = 'completed';
            } else if (isHearing) {
                icon = '⚖️';
                typeLabel = 'Soudní jednání';
                itemClass = 'hearing';
            } else if (event.type === 'meeting') {
                icon = '🤝';
                typeLabel = 'Schůzka';
                itemClass = 'hearing';
            }

            let metaHtml = '';
            if (event.time || event.location) {
                metaHtml = `<div style="font-size: 0.75rem; opacity: 0.8; display: flex; flex-direction: column; gap: 2px; margin-top: 4px;">`;
                if (event.time) metaHtml += `<span>🕒 ${escapeHtml(event.time)}</span>`;
                if (event.location) metaHtml += `<span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(event.location)}">📍 ${escapeHtml(event.location)}</span>`;
                metaHtml += `</div>`;
            }
            // Hlídač jednání: kdy bylo naposledy ověřeno na InfoJednání / proč ne.
            if (isHearing && (event.lastVerifiedAt || event.lastCheckError)) {
                metaHtml += event.lastCheckError
                    ? `<div style="font-size:0.72rem;color:#d97706;margin-top:3px;">⚠️ Neověřeno: ${escapeHtml(event.lastCheckError)}</div>`
                    : `<div style="font-size:0.72rem;opacity:0.7;margin-top:3px;">✔ Ověřeno na InfoJednání ${escapeHtml(new Date(event.lastVerifiedAt).toLocaleString('cs-CZ'))}</div>`;
            }

            // ID jde do onclick → jen bezpečné znaky (escapeHtml nestačí: entity se v atributu dekódují).
            const safeId = String(event.id || '').replace(/[^A-Za-z0-9_.:-]/g, '');
            let actionButtons = '';
            if (!isCompleted && !isCancelled) {
                actionButtons = `<div style="display: flex; gap: 8px; margin-top: 8px;">`;
                if (isHearing && event.needsReview) {
                    actionButtons += `<button class="btn btn-primary" onclick="window.appInstance.confirmHearing('${safeId}')" style="padding: 4px 8px; font-size: 0.7rem;">Potvrdit jednání ✓</button>`;
                }
                if (event.type === 'deadline') {
                    actionButtons += `<button class="btn btn-secondary" onclick="window.appInstance.completeAlert('${safeId}')" style="padding: 4px 8px; font-size: 0.7rem; background: rgba(16,185,129,0.1); border-color: rgba(16,185,129,0.2); color: #34d399;">Splnit ✓</button>`;
                }
                actionButtons += `<button class="btn btn-secondary" onclick="window.appInstance.syncEventToSystemCalendar('${safeId}')" style="padding: 4px 8px; font-size: 0.7rem; background: rgba(59,130,246,0.1); border-color: rgba(59,130,246,0.2); color: #60a5fa;">Zapsat do kalendáře 📅</button>`;
                actionButtons += `</div>`;
            }

            return `
                <div class="calendar-event-item ${itemClass}">
                    <div style="display: flex; align-items: flex-start; gap: 10px;">
                        <span style="font-size: 1.1rem; line-height: 1;">${icon}</span>
                        <div style="flex-grow: 1; min-width: 0;">
                            <strong style="color: var(--text-primary); font-size: 0.85rem; display: block; text-decoration: ${isCompleted ? 'line-through' : 'none'}; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${escapeHtml(event.title)}">${escapeHtml(event.title)}</strong>
                            <span style="font-size: 0.7rem; opacity: 0.6; display: block; margin-top: 2px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${typeLabel} — ${escapeHtml(event.description || '')}</span>
                            ${metaHtml}
                            ${actionButtons}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    prevMonth() {
        this.calendarState.currentMonth--;
        if (this.calendarState.currentMonth < 0) {
            this.calendarState.currentMonth = 11;
            this.calendarState.currentYear--;
        }
        this.renderCalendar();
    },

    nextMonth() {
        this.calendarState.currentMonth++;
        if (this.calendarState.currentMonth > 11) {
            this.calendarState.currentMonth = 0;
            this.calendarState.currentYear++;
        }
        this.renderCalendar();
    },

    jumpToToday() {
        const today = new Date();
        this.calendarState.currentYear = today.getFullYear();
        this.calendarState.currentMonth = today.getMonth();
        this.calendarState.selectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        this.renderCalendar();
        this.renderAgenda();
    },

    selectDay(dateString) {
        this.calendarState.selectedDate = dateString;
        this.renderCalendar();
        this.renderAgenda();
    },

    async confirmHearing(id) {
        try {
            const res = await fetch(`${this.apiBase}/calendar/hearings/${encodeURIComponent(id)}/confirm`, { method: 'POST', headers: this.getHeaders() });
            const data = await res.json();
            if (!res.ok) { alert('❌ ' + (data.error || 'Potvrzení selhalo.')); return; }
            if (typeof this.loadWorkflowTab === 'function') await this.loadWorkflowTab();
        } catch (e) { alert('❌ Síťová chyba: ' + e.message); }
    },

    // ── Vyhledání jednání (InfoJednání) + porovnání se spisy ────────────────
    async hearingSearchInit() {
        if (this._hsCourtsLoaded) return;
        const sel = document.getElementById('hs-court');
        try {
            const res = await fetch(`${this.apiBase}/calendar/hearings/courts`, { headers: this.getHeaders() });
            const data = await res.json();
            const courts = (data.courts || []).slice().sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs'));
            sel.innerHTML = '<option value="">— vyberte soud —</option>' +
                courts.map(c => `<option value="${escapeHtml(c.kod)}">${escapeHtml(c.nazev)}</option>`).join('');
            this._hsCourtsLoaded = true;
        } catch (e) { sel.innerHTML = '<option value="">Seznam soudů se nepodařilo načíst</option>'; }
        const d = document.getElementById('hs-date');
        if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
    },

    _hearingSearchModeValue() {
        const r = document.querySelector('input[name="hs-mode"]:checked');
        return r ? r.value : 'spzn';
    },

    hearingSearchMode() {
        const mode = this._hearingSearchModeValue();
        const room = mode === 'room', isir = mode === 'isir';
        document.getElementById('hs-spzn-wrap').style.display = room ? 'none' : '';
        document.getElementById('hs-room-wrap').style.display = room ? 'grid' : 'none';
        // ISIR: číslo INS je celostátní — soud se nevybírá (zadá se v sp. zn., je-li známý).
        document.getElementById('hs-court-wrap').style.display = isir ? 'none' : '';
        document.getElementById('hs-court').required = !isir;
        const zn = document.getElementById('hs-spzn');
        zn.placeholder = isir ? 'např. KSBR 56 INS 1000/2026' : 'např. 12 C 45/2026';
        const note = document.getElementById('hs-note');
        if (note) note.textContent = isir
            ? 'Insolvenční rejstřík (veřejná služba ISIR). Posílá se jen spisová značka.'
            : 'Informativní zdroj (cca 30 dní dopředu). Závazné je předvolání z datové schránky.';
        document.getElementById('hs-results').innerHTML = '';
        if (room) this.hearingSearchLoadRooms();
    },

    async hearingSearchLoadRooms() {
        if (this._hearingSearchModeValue() !== 'room') return;
        const court = document.getElementById('hs-court').value;
        const sel = document.getElementById('hs-room');
        if (!court) { sel.innerHTML = '<option value="">Nejdřív vyberte soud</option>'; return; }
        sel.innerHTML = '<option value="">Načítám síně…</option>';
        try {
            const res = await fetch(`${this.apiBase}/calendar/hearings/rooms?court=${encodeURIComponent(court)}`, { headers: this.getHeaders() });
            const data = await res.json();
            if (!res.ok) { sel.innerHTML = `<option value="">${escapeHtml(data.error || 'Síně se nepodařilo načíst')}</option>`; return; }
            sel.innerHTML = '<option value="">— vyberte síň —</option>' + (data.rooms || []).map(r => `<option>${escapeHtml(r)}</option>`).join('');
        } catch (e) { sel.innerHTML = '<option value="">InfoJednání nedostupné</option>'; }
    },

    async hearingSearchRun(ev) {
        if (ev) ev.preventDefault();
        const out = document.getElementById('hs-results');
        const mode = this._hearingSearchModeValue();
        if (mode === 'isir') return this._isirSearchRun(out);
        const court = document.getElementById('hs-court').value;
        const q = new URLSearchParams({ mode, court });
        if (mode === 'room') {
            const room = document.getElementById('hs-room').value, date = document.getElementById('hs-date').value;
            if (!court || !room || !date) { out.innerHTML = '<div style="opacity:0.8;">Vyberte soud, jednací síň a datum.</div>'; return; }
            q.set('room', room); q.set('date', date);
        } else {
            const zn = document.getElementById('hs-spzn').value.trim();
            if (!court || !zn) { out.innerHTML = '<div style="opacity:0.8;">Vyberte soud a zadejte spisovou značku.</div>'; return; }
            q.set('spisZn', zn);
        }
        const btn = document.getElementById('hs-submit');
        btn.disabled = true; out.innerHTML = '<div style="opacity:0.7;">Hledám v InfoJednání…</div>';
        try {
            const res = await fetch(`${this.apiBase}/calendar/hearings/search?${q.toString()}`, { headers: this.getHeaders() });
            const data = await res.json();
            if (!res.ok) { out.innerHTML = `<div style="color: var(--danger, #e06c75);">⚠️ ${escapeHtml(data.error || 'Vyhledání selhalo.')}</div>`; return; }
            this._hsLast = data;
            this._renderHearingResults(data);
        } catch (e) {
            out.innerHTML = `<div style="color: var(--danger, #e06c75);">⚠️ Síťová chyba: ${escapeHtml(e.message)}</div>`;
        } finally { btn.disabled = false; }
    },

    // ── Insolvenční řízení podle sp. zn. (ISIR) ─────────────────────────────
    async _isirSearchRun(out) {
        const zn = document.getElementById('hs-spzn').value.trim();
        if (!zn) { out.innerHTML = '<div style="opacity:0.8;">Zadejte spisovou značku, např. „KSBR 56 INS 1000/2026“ nebo „INS 1000/2026“.</div>'; return; }
        const btn = document.getElementById('hs-submit');
        btn.disabled = true; out.innerHTML = '<div style="opacity:0.7;">Hledám v insolvenčním rejstříku…</div>';
        try {
            const res = await fetch(`${this.apiBase}/registries/isir/case?spisZn=${encodeURIComponent(zn)}`, { headers: this.getHeaders() });
            const data = await res.json();
            if (!res.ok) { out.innerHTML = `<div style="color: var(--danger, #e06c75);">⚠️ ${escapeHtml(data.error || 'Vyhledání v ISIR selhalo.')}</div>`; return; }
            this._renderIsirResults(data);
        } catch (e) {
            out.innerHTML = `<div style="color: var(--danger, #e06c75);">⚠️ Síťová chyba: ${escapeHtml(e.message)}</div>`;
        } finally { btn.disabled = false; }
    },

    _renderIsirResults(data) {
        const out = document.getElementById('hs-results');
        const cases = data.cases || [], spisy = data.spisy || [];
        const fmt = d => { const p = String(d || '').split('-'); return p.length === 3 ? `${+p[2]}. ${+p[1]}. ${p[0]}` : (d || ''); };
        if (!cases.length) { out.innerHTML = `<div style="opacity:0.8;">Řízení ${escapeHtml(data.query || '')} v ISIR nenalezeno.</div>`; return; }
        const spisInfo = spisy.length
            ? `<div style="font-size:0.8rem;"><span style="background:#1f6f43;color:#fff;border-radius:6px;padding:2px 8px;font-size:0.72rem;">Váš spis: ${spisy.map(s => escapeHtml(s.nazev || s.spisZn || s.id)).join(', ')}</span> — stav řízení se hlídá automaticky každou hodinu, změnu uvidíte v upozorněních.</div>`
            : '<div style="font-size:0.78rem;opacity:0.8;">Žádný váš spis tuto sp. zn. nemá. Pro automatické hlídání otevřete spis a zvolte „Sledovat insolvenci“.</div>';
        out.innerHTML = `<div style="font-size:0.8rem;opacity:0.8;">${escapeHtml(data.query || '')} · nalezeno ${cases.length} ${cases.length === 1 ? 'záznam' : 'záznamů'}${data.syncedAt ? ' · data ISIR k ' + escapeHtml(String(data.syncedAt).replace('T', ' ').slice(0, 16)) : ''}</div>` + spisInfo +
            cases.map(c => `<div class="glass" style="padding:10px 12px;border-radius:10px;border:1px solid ${spisy.length ? '#1f6f43' : 'var(--border-glass)'};display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">
                <div style="display:flex;flex-direction:column;gap:3px;">
                    <div><strong>${escapeHtml(c.spisZn)}</strong> · <span style="font-weight:600;">${escapeHtml(c.stav || 'stav neuveden')}</span></div>
                    <div style="font-size:0.78rem;opacity:0.8;">${escapeHtml(c.dluznik || '')}${c.mesto ? ' · ' + escapeHtml(c.mesto) : ''}${c.zahajeni ? ' · zahájeno ' + escapeHtml(fmt(c.zahajeni)) : ''}${c.ukonceni ? ' · ukončeno ' + escapeHtml(fmt(c.ukonceni)) : ''}${c.dalsiDluznik ? ' · více dlužníků' : ''}</div>
                </div>
                ${/^https:\/\/isir\.justice\.cz\//.test(c.url || '') ? `<a class="btn btn-secondary" style="padding:4px 10px;font-size:0.75rem;" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">Detail v ISIR</a>` : ''}
            </div>`).join('');
    },

    _renderHearingResults(data) {
        const out = document.getElementById('hs-results');
        const evs = data.events || [];
        if (!evs.length) { out.innerHTML = `<div style="opacity:0.8;">Nebylo nalezeno žádné jednání (${escapeHtml(data.court || '')}).</div>`; return; }
        const fmt = d => { const p = String(d || '').split('-'); return p.length === 3 ? `${+p[2]}. ${+p[1]}. ${p[0]}` : d; };
        const head = `<div style="font-size:0.8rem;opacity:0.8;">${escapeHtml(data.court || '')} · nalezeno ${evs.length} jednání · ve vašich spisech: <strong>${data.matches || 0}</strong></div>`;
        out.innerHTML = head + evs.map((e, i) => {
            const m = e.match;
            const badge = m ? (m.exact
                ? `<span style="background:#1f6f43;color:#fff;border-radius:6px;padding:2px 8px;font-size:0.72rem;">Váš spis: ${escapeHtml(m.nazev || m.spisId)}</span>`
                : `<span style="background:#8a6d1d;color:#fff;border-radius:6px;padding:2px 8px;font-size:0.72rem;" title="Stejná sp. zn., ale spis má jiný nebo nevyplněný soud (${escapeHtml(m.spisSoud || '—')})">Možná shoda: ${escapeHtml(m.nazev || m.spisId)}</span>`)
                : '';
            const status = e.cancelled ? '<span style="color:#e06c75;font-weight:600;">ZRUŠENO</span>' : '';
            const action = e.tracked
                ? `<span style="font-size:0.75rem;opacity:0.8;">✓ Sledováno${e.tracked.status === 'needs_review' ? ' (k potvrzení)' : ''}</span>`
                : (e.cancelled ? '' : `<button class="btn btn-secondary" style="padding:4px 10px;font-size:0.75rem;" onclick="window.appInstance.hearingSearchTrack(${i})">Sledovat${m && m.exact ? ' ve spisu' : ''}</button>`);
            return `<div class="glass" style="padding:10px 12px;border-radius:10px;border:1px solid ${m && m.exact ? '#1f6f43' : 'var(--border-glass)'};display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">
                <div style="display:flex;flex-direction:column;gap:3px;">
                    <div><strong>${escapeHtml(e.spisZn || '—')}</strong> · ${escapeHtml(fmt(e.date))} ${escapeHtml(e.time || '')} ${status}</div>
                    <div style="font-size:0.78rem;opacity:0.8;">${escapeHtml(e.room || '')}${e.kind ? ' · ' + escapeHtml(e.kind) : ''}${e.judge ? ' · ' + escapeHtml(e.judge) : ''}${e.nonPublic ? ' · neveřejné' : ''}</div>
                    ${badge ? `<div>${badge}</div>` : ''}
                </div>
                <div>${action}</div>
            </div>`;
        }).join('');
    },

    async hearingSearchTrack(i) {
        const data = this._hsLast; if (!data) return;
        const e = (data.events || [])[i]; if (!e) return;
        const body = { courtCode: data.courtCode, spisZn: e.spisZn, date: e.date, time: e.time, room: e.room,
            spisId: e.match && e.match.exact ? e.match.spisId : undefined };
        try {
            const res = await fetch(`${this.apiBase}/calendar/hearings/track`, {
                method: 'POST', headers: { ...this.getHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            const r = await res.json();
            if (!res.ok) { alert('❌ ' + (r.error || 'Přidání selhalo.')); return; }
            e.tracked = { id: r.hearing.id, status: r.hearing.status };
            this._renderHearingResults(data);
            if (typeof this.loadWorkflowTab === 'function') this.loadWorkflowTab();
        } catch (err) { alert('❌ Síťová chyba: ' + err.message); }
    },

    async syncHearingsPortal() {
        try {
            console.log("⚖️ Synchronizuji jednání z portálu InfoJednání...");
            const res = await fetch(`${this.apiBase}/calendar/sync`, {
                method: 'POST',
                headers: this.getHeaders()
            });
            const data = await res.json();
            if (data.success) {
                const sp = data.spisy || {};
                const hh = data.health || {};
                let msg = `Zkontrolováno: ${data.checked} jednání, změn: ${data.updated}` +
                    `\nProhledáno spisů: ${sp.checked || 0}, nových jednání k potvrzení: ${sp.found || 0}`;
                if ((sp.unmonitorable || []).length) msg += `\nNelze hlídat (chybí soud / kód soudu): ${sp.unmonitorable.length} spisů`;
                if (hh.status === 'down' || hh.status === 'degraded' || data.failed || sp.failed) {
                    msg = `⚠️ InfoJednání se nepodařilo ověřit: ${hh.lastError || 'bez odpovědi'}\nTermíny ověřte ručně (datová schránka, web soudu).\n\n` + msg;
                } else {
                    msg = '✓ Kontrola jednání dokončena.\n' + msg;
                }
                alert(msg);
                await this.loadWorkflowTab();
            } else {
                alert("❌ Portálová synchronizace selhala: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba při synchronizaci: " + err.message);
        }
    },

    async syncEventToSystemCalendar(eventId) {
        const event = this.calendarState.events.find(e => e.id === eventId);
        if (!event) return;

        try {
            console.log(`📅 Zapisuji událost [${event.title}] do systémového kalendáře...`);
            const res = await fetch(`${this.apiBase}/calendar/add`, {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    id: event.id,
                    title: event.title,
                    dueDate: event.date,
                    time: event.time || null,
                    location: event.location || null,
                    context: event.description,
                    isHearing: event.type === 'hearing'
                })
            });

            const data = await res.json();
            if (data.success) {
                if (data.syncStatus === 'created') {
                    alert(`✓ Událost "${event.title}" byla úspěšně zapsána do Vašeho systémového kalendáře.`);
                } else if (data.syncStatus === 'duplicate') {
                    alert(`ℹ️ Událost "${event.title}" již ve Vašem systémovém kalendáři existuje.`);
                } else if (data.syncStatus === 'unsupported_platform') {
                    alert(`⚠️ Tato platforma nepodporuje přímý zápis do kalendáře, ale ICS soubor byl uložen v adresáři Kalendář.`);
                } else {
                    alert(`✓ ICS soubor byl vygenerován.`);
                }
            } else {
                alert("❌ Chyba při zápisu do kalendáře: " + data.error);
            }
        } catch (err) {
            alert("❌ Síťová chyba zápisu: " + err.message);
        }
    }

});
