import { testEnv } from './test-setup';
import { analyzeLeaveRequest } from '../modules/vacation/vacation-analyzer';
import * as admin from 'firebase-admin';

describe('Vacation Analyzer', () => {
    let db: admin.firestore.Firestore;

    beforeAll(async () => {
        db = testEnv.firestore();
        
        // Seed test data
        await seedTestData(db);
    });

    afterAll(async () => {
        await testEnv.cleanup();
    });

    describe('analyzeLeaveRequest', () => {
        test('should approve low-risk request with good fairness', async () => {
            // Create leave request
            const requestRef = await db.collection('leaveRequests').add({
                residentId: 'test-resident-1',
                residentName: 'Dr. Test',
                type: 'Personal',
                status: 'Pending Analysis',
                startDate: admin.firestore.Timestamp.fromDate(
                    new Date('2025-09-15')
                ),
                endDate: admin.firestore.Timestamp.fromDate(
                    new Date('2025-09-17')
                )
            });

            // Wait for function to process
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Check results
            const updatedRequest = await requestRef.get();
            const data = updatedRequest.data();

            expect(data?.status).toBe('Pending Approval');
            expect(data?.analysisReportId).toBeDefined();

            // Check report was created
            const reportDoc = await db
                .collection('leaveAnalysisReports')
                .doc(data?.analysisReportId)
                .get();

            expect(reportDoc.exists).toBe(true);
            expect(reportDoc.data()?.overallRecommendation).toBe('Approve');
        });

        test('should deny high-risk request with conflicts', async () => {
            // Create conflicting call assignment
            await db.collection('monthlySchedules').doc('2025-09').set({
                assignments: [{
                    residentId: 'test-resident-2',
                    type: 'Weekend',
                    date: admin.firestore.Timestamp.fromDate(
                        new Date('2025-09-20')
                    )
                }]
            });

            // Create leave request that conflicts
            const requestRef = await db.collection('leaveRequests').add({
                residentId: 'test-resident-2',
                residentName: 'Dr. Conflict',
                type: 'Personal',
                status: 'Pending Analysis',
                startDate: admin.firestore.Timestamp.fromDate(
                    new Date('2025-09-19')
                ),
                endDate: admin.firestore.Timestamp.fromDate(
                    new Date('2025-09-21')
                )
            });

            // Wait for processing
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Check denial
            const updated = await requestRef.get();
            expect(updated.data()?.status).toBe('Denied');
            expect(updated.data()?.denialJustification).toContain('conflict');
        });
    });
});

async function seedTestData(db: admin.firestore.Firestore) {
    // Add test residents
    await db.collection('residents').doc('test-resident-1').set({
        name: 'Dr. Test',
        pgyLevel: 3,
        specialty: 'Neurosurgery',
        onService: true
    });

    await db.collection('residents').doc('test-resident-2').set({
        name: 'Dr. Conflict',
        pgyLevel: 2,
        specialty: 'Neurosurgery',
        onService: true
    });

    // Add configuration
    await db.collection('configuration').doc('main').set({
        leavePolicy: {
            minNoticeDays: 30,
            maxConsecutiveDays: 14,
            annualLimit: 21
        }
    });
}