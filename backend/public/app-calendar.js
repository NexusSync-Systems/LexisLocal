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

            const todayStr = new Date().toISOString().split('T')[0];
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
                    dotsHtml += `<span class="calendar-day-dot ${dotClass}" title="${e.title}"></span>`;
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
        this.calendarState.selectedDate = today.toISOString().split('T')[0];
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
