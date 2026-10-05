const fs = require('fs');
const path = require('path');
const os = require('os');

// Setup temporary environment variables BEFORE loading the database
const tempWatchDir = path.join(os.tmpdir(), `lexis_test_managerial_${Date.now()}`);
process.env.WATCH_DIR = tempWatchDir;

const db = require('../lib/database');
const managerial = require('../lib/managerial');

describe('Managerial Intelligence', () => {
    beforeAll(() => {
        if (!fs.existsSync(tempWatchDir)) {
            fs.mkdirSync(tempWatchDir, { recursive: true });
        }
    });

    afterAll(() => {
        if (fs.existsSync(tempWatchDir)) {
            fs.rmSync(tempWatchDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        // Clear all collections before each test
        for (const key in db.collections) {
            db.collections[key] = [];
        }
        db.save();
    });

    describe('getCapacityAllocation', () => {
        // Tým kanceláře (dřív ho nahrazovali vymyšlení „Partner (ukázka)“ apod.).
        beforeEach(() => {
            db.insert('staff', { id: 'partner', name: 'Partner', role: 'Partner' });
            db.insert('staff', { id: 'koncipient_a', name: 'Koncipient A', role: 'Koncipient' });
            db.insert('staff', { id: 'koncipient_b', name: 'Koncipient B', role: 'Koncipient' });
        });

        it('bez týmu a bez uživatelů: prázdný seznam, žádní vymyšlení lidé (UX 5. 10. 2026)', () => {
            db.collections.staff = []; db.save();
            const result = managerial.getCapacityAllocation();
            expect(result.staff).toEqual([]);
            expect(result.demo).toBe(true);
        });

        it('should return default underloaded staff when there are no alerts', () => {
            const result = managerial.getCapacityAllocation();

            expect(result.staff.length).toBe(3);
            expect(result.totalAlertsCount).toBe(0);

            result.staff.forEach(member => {
                expect(member.load).toBe(0);
                expect(member.status).toBe('underloaded');
            });
        });

        it('odvolání/rozsudek zatíží seniora (partner) po 1.5', () => {
            db.insert('alerts', { title: 'Nové odvolání v případu', status: 'pending' });
            db.insert('alerts', { title: 'Přišel rozsudek KS', status: 'pending' });

            const result = managerial.getCapacityAllocation();
            expect(result.demo).toBe(false); // nastavený tým

            const partner = result.staff.find(s => s.id === 'partner');
            expect(partner.load).toBe(3.0); // 1.5 + 1.5
            expect(partner.status).toBe('optimal'); // 3.0 není > 3.0

            // Koncipienti zůstávají nevytížení
            expect(result.staff.find(s => s.id === 'koncipient_a').load).toBe(0);
        });

        it('smlouva/lustrace se rozloží mezi koncipienty (round-robin, po 1.0)', () => {
            db.insert('alerts', { title: 'Příprava smlouva o dílo', status: 'pending' });
            db.insert('alerts', { title: 'Lustrace klienta', status: 'pending' });

            const result = managerial.getCapacityAllocation();

            // Dva úkoly po 1.0 padnou po jednom na každého koncipienta.
            expect(result.staff.find(s => s.id === 'koncipient_a').load).toBe(1.0);
            expect(result.staff.find(s => s.id === 'koncipient_b').load).toBe(1.0);
            expect(result.staff.find(s => s.id === 'partner').load).toBe(0);
        });

        it('běžný úkol (0.8) padne na prvního koncipienta', () => {
            db.insert('alerts', { title: 'Běžný úkol', status: 'pending' });

            const result = managerial.getCapacityAllocation();

            const koncipientA = result.staff.find(s => s.id === 'koncipient_a');
            expect(koncipientA.load).toBe(0.8);
            expect(koncipientA.status).toBe('underloaded'); // 0.8 < 1.0
        });

        it('should ignore alerts that are not pending', () => {
            db.insert('alerts', { title: 'smlouva hotová', status: 'resolved' });
            db.insert('alerts', { title: 'odvolání podáno', status: 'dismissed' });

            const result = managerial.getCapacityAllocation();

            expect(result.totalAlertsCount).toBe(0);
            result.staff.forEach(member => {
                expect(member.load).toBe(0);
            });
        });

        it('should mark staff as overloaded if load > 3.0', () => {
            db.insert('alerts', { title: 'odvolání 1', status: 'pending' });
            db.insert('alerts', { title: 'odvolání 2', status: 'pending' });
            db.insert('alerts', { title: 'odvolání 3', status: 'pending' });

            const result = managerial.getCapacityAllocation();

            const partner = result.staff.find(s => s.id === 'partner');
            expect(partner.load).toBe(4.5); // 1.5 * 3
            expect(partner.status).toBe('overloaded');
        });
    });

    describe('getProfitabilityReport', () => {
        beforeEach(() => {
            // Setup default setting for hourly rate
            db.insert('settings', { key: 'default_hourly_rate', value: '2500' });
        });

        it('should return an empty report when there are no budgets and no activities', () => {
            const report = managerial.getProfitabilityReport();
            expect(report).toEqual([]);
        });

        it('should correctly calculate profitability for an existing budget with activities', () => {
            db.insert('budgets', {
                documentName: "Smlouva.docx",
                budgetType: "hourly_cap",
                limitHours: 10,
                hourlyRate: 3000
            });

            // 5 hours = 18000 seconds
            db.insert('activities', { documentName: "Smlouva.docx", activeSeconds: 18000 });

            const report = managerial.getProfitabilityReport();

            expect(report.length).toBe(1);
            expect(report[0].documentName).toBe("Smlouva.docx");
            expect(report[0].budgetType).toBe("hourly_cap");
            expect(report[0].limitHours).toBe(10);
            expect(report[0].actualHours).toBe(5);
            expect(report[0].spentPercentage).toBe(50);
            expect(report[0].hourlyRate).toBe(3000);
            expect(report[0].estimatedCost).toBe(15000);
            expect(report[0].status).toBe('profitable');
        });

        it('should mark status as warning if spent percentage is > 80 and <= 100', () => {
            db.insert('budgets', {
                documentName: "Smlouva.docx",
                limitHours: 10,
                hourlyRate: 3000
            });

            // 9 hours = 32400 seconds
            db.insert('activities', { documentName: "Smlouva.docx", activeSeconds: 32400 });

            const report = managerial.getProfitabilityReport();

            expect(report.length).toBe(1);
            expect(report[0].spentPercentage).toBe(90);
            expect(report[0].status).toBe('warning');
        });

        it('should mark status as unprofitable if spent percentage is > 100', () => {
            db.insert('budgets', {
                documentName: "Smlouva.docx",
                limitHours: 10,
                hourlyRate: 3000
            });

            // 11 hours = 39600 seconds
            db.insert('activities', { documentName: "Smlouva.docx", activeSeconds: 39600 });

            const report = managerial.getProfitabilityReport();

            expect(report.length).toBe(1);
            expect(report[0].spentPercentage).toBe(110);
            expect(report[0].status).toBe('unprofitable');
        });

        it('should aggregate multiple activities for the same document', () => {
            db.insert('budgets', {
                documentName: "Smlouva.docx",
                limitHours: 10,
                hourlyRate: 3000
            });

            // 2 hours
            db.insert('activities', { documentName: "Smlouva.docx", activeSeconds: 7200 });
            // 3 hours
            db.insert('activities', { documentName: "Smlouva.docx", activeSeconds: 10800 });

            const report = managerial.getProfitabilityReport();

            expect(report.length).toBe(1);
            expect(report[0].actualHours).toBe(5);
            expect(report[0].spentPercentage).toBe(50);
        });

        it('should handle budgets with no activities', () => {
            db.insert('budgets', {
                documentName: "Smlouva.docx",
                limitHours: 10,
                hourlyRate: 3000
            });

            const report = managerial.getProfitabilityReport();

            expect(report.length).toBe(1);
            expect(report[0].actualHours).toBe(0);
            expect(report[0].spentPercentage).toBe(0);
            expect(report[0].status).toBe('profitable');
            expect(report[0].estimatedCost).toBe(0);
        });

        it('should create unassigned budget entries for activities with no explicitly defined budget', () => {
            // 4 hours = 14400 seconds
            db.insert('activities', { documentName: "Unknown.docx", activeSeconds: 14400 });

            const report = managerial.getProfitabilityReport();

            expect(report.length).toBe(1);
            expect(report[0].documentName).toBe("Unknown.docx");
            expect(report[0].budgetType).toBe("unassigned");
            expect(report[0].limitHours).toBe(0);
            expect(report[0].actualHours).toBe(4);
            expect(report[0].spentPercentage).toBe(0);
            expect(report[0].hourlyRate).toBe(2500); // Default rate from settings
            expect(report[0].estimatedCost).toBe(10000);
            expect(report[0].status).toBe('profitable');
        });

        it('should use default hourly rate and limit for budget if not specified', () => {
            // Insert budget with missing optional fields
            db.insert('budgets', {
                documentName: "Smlouva.docx"
            });

            // 5 hours = 18000 seconds
            db.insert('activities', { documentName: "Smlouva.docx", activeSeconds: 18000 });

            const report = managerial.getProfitabilityReport();

            expect(report.length).toBe(1);
            expect(report[0].documentName).toBe("Smlouva.docx");
            expect(report[0].limitHours).toBe(10); // default fallback
            expect(report[0].hourlyRate).toBe(2500); // default fallback from settings
            expect(report[0].actualHours).toBe(5);
            expect(report[0].spentPercentage).toBe(50);
            expect(report[0].estimatedCost).toBe(12500);
        });

        it('should fall back to 30 activeSeconds if activeSeconds is missing in activity', () => {
            db.insert('activities', { documentName: "Short.docx" }); // no activeSeconds

            const report = managerial.getProfitabilityReport();

            expect(report.length).toBe(1);
            // 30 seconds = 30 / 3600 = 0.008333... rounded to 2 decimal places = 0.01
            expect(report[0].actualHours).toBe(0.01);
        });
    });
});
