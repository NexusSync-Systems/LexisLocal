/**
 * LexisLocal Managerial Intelligence & Profitability Module (Fáze 4)
 * Analyzes case timesheet profitability against budgets and tracks capacity allocation
 * for lawyers and assistants based on pending deadlines.
 */

const db = require('./database');

class ManagerialIntelligence {
    constructor() {
        this.initDefaultBudgets();
        this.initDefaultFees();
    }

    /**
     * Seeds initial budgets for demonstration and backward compatibility
     */
    initDefaultBudgets() {
        // Dřív se zakládaly dva ukázkové rozpočty („Nájemní smlouva.docx“, „Odvolání proti
        // rozsudku.docx“), které se pak v kanceláři tvářily jako skutečné spisy (UX kontrola
        // 5. 10. 2026). Nic se nezakládá a dřív založené ukázky (beze změny) se odstraní.
        const DEMO = [
            { documentName: "Nájemní smlouva.docx", budgetType: "hourly_cap", limitHours: 10, hourlyRate: 2500 },
            { documentName: "Odvolání proti rozsudku.docx", budgetType: "flat", limitHours: 5, hourlyRate: 3000 }
        ];
        try {
            (db.get('budgets') || []).forEach(b => {
                if (DEMO.some(d => d.documentName === b.documentName && d.budgetType === b.budgetType &&
                    Number(d.limitHours) === Number(b.limitHours) && Number(d.hourlyRate) === Number(b.hourlyRate))) {
                    db.delete('budgets', b.id);
                }
            });
        } catch (e) { /* nekritické */ }
    }

    /**
     * Gets the office default hourly rate from database settings
     */
    getDefaultHourlyRate() {
        const settings = db.get('settings');
        const rateSetting = settings.find(s => s.key === 'default_hourly_rate');
        return rateSetting ? parseFloat(rateSetting.value) : 2500;
    }

    /**
     * Returns office managerial settings
     */
    getOfficeSettings() {
        return {
            defaultHourlyRate: this.getDefaultHourlyRate()
        };
    }

    /**
     * Updates office managerial settings
     */
    updateOfficeSettings(settingsData) {
        const rate = parseFloat(settingsData.defaultHourlyRate);
        if (isNaN(rate) || rate <= 0) {
            throw new Error("Neplatná výše hodinové sazby.");
        }

        const settings = db.get('settings');
        const existing = settings.find(s => s.key === 'default_hourly_rate');

        if (existing) {
            db.update('settings', existing.id, { value: rate.toString() });
        } else {
            db.insert('settings', { key: 'default_hourly_rate', value: rate.toString() });
        }

        return { defaultHourlyRate: rate };
    }

    /**
     * Returns a profitability report for all monitored documents/cases
     */
    getProfitabilityReport() {
        const budgets = db.get('budgets');
        const activities = db.get('activities');
        const defaultRate = this.getDefaultHourlyRate();

        // Aggregate actual time spent per document
        const timeSpent = {};
        activities.forEach(act => {
            const doc = act.documentName;
            if (!timeSpent[doc]) {
                timeSpent[doc] = 0;
            }
            timeSpent[doc] += act.activeSeconds || 30;
        });

        const report = budgets.map(budget => {
            const actualSeconds = timeSpent[budget.documentName] || 0;
            const actualHours = parseFloat((actualSeconds / 3600).toFixed(2));
            const limitHours = budget.limitHours || 10;
            const spentPercentage = parseFloat(((actualHours / limitHours) * 100).toFixed(1));

            let status = 'profitable';
            if (spentPercentage > 100) {
                status = 'unprofitable';
            } else if (spentPercentage > 80) {
                status = 'warning';
            }

            const currentRate = budget.hourlyRate || defaultRate;
            const estimatedCost = actualHours * currentRate;

            return {
                id: budget.id,
                documentName: budget.documentName,
                budgetType: budget.budgetType,
                limitHours,
                actualHours,
                spentPercentage,
                hourlyRate: currentRate,
                estimatedCost,
                status
            };
        });

        // Add any tracked documents that don't have an explicit budget set
        Object.entries(timeSpent).forEach(([docName, seconds]) => {
            const hasBudget = budgets.some(b => b.documentName === docName);
            if (!hasBudget) {
                const actualHours = parseFloat((seconds / 3600).toFixed(2));
                report.push({
                    documentName: docName,
                    budgetType: "unassigned",
                    limitHours: 0,
                    actualHours,
                    spentPercentage: 0,
                    hourlyRate: defaultRate,
                    estimatedCost: actualHours * defaultRate,
                    status: 'profitable'
                });
            }
        });

        return report;
    }

    /**
     * Set or edit a custom case/document budget
     */
    setBudget(budgetData) {
        const existing = db.get('budgets').find(b => b.documentName === budgetData.documentName);
        const defaultRate = this.getDefaultHourlyRate();
        const rate = parseFloat(budgetData.hourlyRate) || defaultRate;
        
        if (existing) {
            return db.update('budgets', existing.id, {
                budgetType: budgetData.budgetType || existing.budgetType,
                limitHours: parseFloat(budgetData.limitHours) || existing.limitHours,
                hourlyRate: parseFloat(budgetData.hourlyRate) || existing.hourlyRate || defaultRate
            });
        }

        return db.insert('budgets', {
            documentName: budgetData.documentName,
            budgetType: budgetData.budgetType || "hourly_cap",
            limitHours: parseFloat(budgetData.limitHours) || 8,
            hourlyRate: rate
        });
    }

    /**
     * Computes capacity allocation and team load indicators based on pending tasks (alerts)
     */
    getCapacityAllocation() {
        const alerts = db.get('alerts').filter(a => a.status === 'pending');

        // Tým se primárně načítá z konfigurace (db kolekce 'staff'). Pokud není
        // nastaven, použije se NEUTRÁLNÍ ukázkový tým označený demo:true — dřív
        // zde byla natvrdo konkrétní (fabrikovaná) jména vydávaná za reálný tým.
        let configured = db.get('staff');
        let isDemo = false;
        let staff;
        if (Array.isArray(configured) && configured.length > 0) {
            staff = configured.map(s => ({
                id: s.id,
                name: s.name,
                role: s.role || 'Koncipient',
                load: 0,
                status: 'optimal'
            }));
        } else {
            // Bez ručně nastaveného týmu se vezmou skuteční uživatelé kanceláře (záložka
            // Uživatelé). Advokát/správce = „partner“. Žádní uživatelé → prázdný seznam a UI
            // nabídne jejich založení (dřív se zobrazovali vymyšlení „Partner (ukázka)“ atd.).
            let users = [];
            try { users = require('./users').listUsers().filter(u => !u.disabled && u.role !== 'ctenar'); } catch (e) { users = []; }
            staff = users.map(u => ({
                id: u.id, name: u.name,
                role: (u.role === 'advokat' || u.role === 'spravce') ? 'Partner' : (u.roleLabel || 'Koncipient'),
                load: 0, status: 'optimal'
            }));
            isDemo = staff.length === 0;
        }

        // Rozdělení úkolů podle klíčových slov — cílíme podle role (robustní i pro
        // jinou velikost týmu než 3).
        const partner = staff.find(s => (s.role || '').toLowerCase().includes('partner')) || staff[0];
        const koncipienti = staff.filter(s => s !== partner);
        let rr = 0;
        alerts.forEach(alert => {
            const titleLower = (alert.title || '').toLowerCase();
            if (titleLower.includes('odvolání') || titleLower.includes('rozsudek')) {
                if (partner) partner.load += 1.5;
            } else if (koncipienti.length > 0) {
                const target = koncipienti[rr % koncipienti.length];
                target.load += (titleLower.includes('smlouva') || titleLower.includes('lustrace')) ? 1.0 : 0.8;
                rr++;
            } else if (partner) {
                partner.load += 0.8;
            }
        });

        // Determine load status levels
        const updatedStaff = staff.map(member => {
            let status = 'optimal';
            if (member.load > 3.0) {
                status = 'overloaded';
            } else if (member.load < 1.0) {
                status = 'underloaded';
            }
            return {
                ...member,
                status
            };
        });

        return {
            staff: updatedStaff,
            demo: isDemo,
            totalAlertsCount: alerts.length,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Seeds initial fee items (ceník odměn)
     */
    initDefaultFees() {
        const existing = db.get('fees');
        if (existing.length === 0) {
            db.insert('fees', {
                name: "Právní konzultace",
                type: "hourly",
                amount: 2500
            });
            db.insert('fees', {
                name: "Sepis standardní smlouvy",
                type: "flat",
                amount: 8000
            });
            db.insert('fees', {
                name: "Zastupování před soudem",
                type: "hourly",
                amount: 3500
            });
            db.insert('fees', {
                name: "Právní rešerše a analýza",
                type: "hourly",
                amount: 2000
            });
            db.insert('fees', {
                name: "AML prověrka & Onboarding",
                type: "flat",
                amount: 1500
            });
        }
    }

    /**
     * Retrieves all fee items
     */
    getFees() {
        return db.get('fees');
    }

    /**
     * Adds or updates a fee item
     */
    saveFee(feeData) {
        if (!feeData.name) {
            throw new Error("Název služby je povinný.");
        }
        const amount = parseFloat(feeData.amount);
        if (isNaN(amount) || amount < 0) {
            throw new Error("Sazba musí být nezáporné číslo.");
        }

        const type = feeData.type || "hourly";

        if (feeData.id) {
            // Update existing
            return db.update('fees', feeData.id, {
                name: feeData.name,
                type: type,
                amount: amount
            });
        }

        // Check if item with this name already exists
        const existing = db.get('fees').find(f => f.name.toLowerCase() === feeData.name.toLowerCase());
        if (existing) {
            return db.update('fees', existing.id, {
                type: type,
                amount: amount
            });
        }

        // Insert new
        return db.insert('fees', {
            name: feeData.name,
            type: type,
            amount: amount
        });
    }

    /**
     * Deletes a fee item
     */
    deleteFee(id) {
        return db.delete('fees', id);
    }
}

module.exports = new ManagerialIntelligence();
