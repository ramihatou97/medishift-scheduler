import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

// Initialize Firebase Admin SDK once
if (!admin.apps.length) {
    admin.initializeApp();
}

// ===================================================================
// VACATION & LEAVE SYSTEM
// ===================================================================
export { analyzeLeaveRequest } from './vacation/vacation-analyzer';
export { nightlyConflictAudit } from './auditing/conflict-detector';

// ===================================================================
// EDUCATION SYSTEM
// ===================================================================
export { onORCaseFinalized } from './education/epaHandler';

// ===================================================================
// NOTIFICATION SYSTEM
// ===================================================================
export { 
    onLeaveRequestStatusChange,
    onEpaAssigned,
    onConflictDetected 
} from './notifications/notification-service';

// ===================================================================
// ANALYTICS & REPORTING
// ===================================================================
import { generateAnalyticsReportHandler } from './analytics/analytics-engine';
export const generateAnalyticsReport = generateAnalyticsReportHandler;

// ===================================================================
// SCHEDULING SYSTEM (CALLABLE FUNCTIONS)
// ===================================================================

import { YearlyScheduleEngine } from './scheduling/yearly-scheduler';
import { MonthlyCallScheduler } from './scheduling/monthly-scheduler';
import { WeeklyScheduleGenerator } from './scheduling/weekly-scheduler';
import { validateScheduleRequest } from './utils/validators';
import { AppError, wrapAsync } from './utils/error-handler';

/**
 * Generate yearly rotation schedule
 */
export const generateYearlySchedule = functions
    .runWith({
        timeoutSeconds: 540,
        memory: '2GB'
    })
    .https.onCall(wrapAsync(async (data, context) => {
        // Authentication check
        if (!context.auth?.token?.admin) {
            throw new AppError('permission-denied', 'Admin access required', 403);
        }

        // Validate input
        const validated = validateScheduleRequest(data);
        
        // Generate schedule
        const engine = new YearlyScheduleEngine(
            validated.residents,
            validated.externalRotators,
            validated.config,
            validated.academicYearId
        );
        
        const schedule = await engine.generateSchedule();
        
        // Save to Firestore
        await admin.firestore()
            .collection('academicYears')
            .doc(validated.academicYearId)
            .set(schedule);
        
        // Log audit trail
        await admin.firestore().collection('auditLogs').add({
            action: 'YEARLY_SCHEDULE_GENERATED',
            performedBy: context.auth.uid,
            academicYearId: validated.academicYearId,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return { 
            success: true, 
            scheduleId: validated.academicYearId,
            message: 'Yearly schedule generated successfully'
        };
    }));

/**
 * Generate monthly call schedule
 */
export const generateMonthlySchedule = functions
    .runWith({
        timeoutSeconds: 300,
        memory: '1GB'
    })
    .https.onCall(wrapAsync(async (data, context) => {
        if (!context.auth?.token?.admin) {
            throw new AppError('permission-denied', 'Admin access required', 403);
        }

        const { month, year, staffingLevel = 'Normal' } = data;
        
        // Fetch required data
        const [residents, config, academicYear, approvedLeave] = await Promise.all([
            getResidents(),
            getConfiguration(),
            getAcademicYear(`${year}-${year + 1}`),
            getApprovedLeave(month, year)
        ]);
        
        // Generate schedule
        const scheduler = new MonthlyCallScheduler(
            residents,
            config,
            academicYear,
            approvedLeave,
            month,
            year
        );
        
        const assignments = scheduler.generateSchedule(staffingLevel);
        
        // Save to Firestore
        const scheduleId = `${year}-${(month + 1).toString().padStart(2, '0')}`;
        await admin.firestore()
            .collection('monthlySchedules')
            .doc(scheduleId)
            .set({ 
                id: scheduleId,
                assignments,
                generatedAt: admin.firestore.FieldValue.serverTimestamp(),
                generatedBy: context.auth.uid,
                staffingLevel
            });
        
        return { 
            success: true, 
            scheduleId,
            assignmentCount: assignments.length
        };
    }));

/**
 * Generate weekly clinical schedule
 */
export const generateWeeklySchedule = functions
    .runWith({
        timeoutSeconds: 300,
        memory: '1GB'
    })
    .https.onCall(wrapAsync(async (data, context) => {
        if (!context.auth?.token?.admin) {
            throw new AppError('permission-denied', 'Admin access required', 403);
        }

        const generator = new WeeklyScheduleGenerator(
            data.residents,
            new Date(data.weekStartDate),
            data.orSlots,
            data.clinicSlots,
            data.callAssignments,
            data.config
        );
        
        const weeklySchedule = generator.generate();
        
        // Save to Firestore
        await admin.firestore()
            .collection('weeklySchedules')
            .doc(weeklySchedule.id)
            .set(weeklySchedule);
        
        return { 
            success: true, 
            scheduleId: weeklySchedule.id
        };
    }));

// ===================================================================
// ADMIN FUNCTIONS
// ===================================================================

export const setAdminClaim = functions.https.onCall(wrapAsync(async (data, context) => {
    if (!context.auth?.token?.admin) {
        throw new AppError('permission-denied', 'Admin access required', 403);
    }

    const { uid, isAdmin } = data;
    
    await admin.auth().setCustomUserClaims(uid, { admin: isAdmin });
    
    await admin.firestore().collection('auditLogs').add({
        action: isAdmin ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED',
        targetUserId: uid,
        performedBy: context.auth.uid,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return { success: true };
}));

// ===================================================================
// HELPER FUNCTIONS
// ===================================================================

async function getResidents() {
    const snapshot = await admin.firestore()
        .collection('residents')
        .where('onService', '==', true)
        .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getConfiguration() {
    const doc = await admin.firestore()
        .collection('configuration')
        .doc('main')
        .get();
    if (!doc.exists) {
        throw new AppError('not-found', 'Configuration not found', 404);
    }
    return doc.data();
}

async function getAcademicYear(yearId: string) {
    const doc = await admin.firestore()
        .collection('academicYears')
        .doc(yearId)
        .get();
    if (!doc.exists) {
        throw new AppError('not-found', `Academic year ${yearId} not found`, 404);
    }
    return doc.data();
}

async function getApprovedLeave(month: number, year: number) {
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0);
    
    const snapshot = await admin.firestore()
        .collection('leaveRequests')
        .where('status', '==', 'Approved')
        .where('startDate', '<=', admin.firestore.Timestamp.fromDate(endDate))
        .where('endDate', '>=', admin.firestore.Timestamp.fromDate(startDate))
        .get();
    
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}