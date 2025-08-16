/**
 * MediShift Cloud Functions Entry Point
 * Version: 4.0 - Production Ready
 * Date: August 2025
 */

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

// Initialize Firebase Admin SDK once (FIXED)
if (admin.apps.length === 0) {
    admin.initializeApp();
}

// ===================================================================
// CONFIGURATION & ENVIRONMENT VALIDATION
// ===================================================================
import { validateEnvironment } from './config/env';
validateEnvironment();

// ===================================================================
// MIDDLEWARE IMPORTS
// ===================================================================
import { rateLimit } from './middleware/rateLimiter';
import { validateRequest } from './middleware/validator';
import { sanitizeInput } from './utils/sanitizer';
import { PerformanceTracker } from './utils/performance';

// ===================================================================
// VACATION & LEAVE SYSTEM
// ===================================================================
export { analyzeLeaveRequest } from './vacation/vacation-analyzer';
export { nightlyConflictAudit } from './auditing/conflict-detector';

// ===================================================================
// EDUCATION SYSTEM
// ===================================================================
export { onORCaseFinalized, sendEPAReminders } from './education/epaHandler';

// ===================================================================
// NOTIFICATION SYSTEM
// ===================================================================
export { 
    onLeaveRequestStatusChange,
    onEpaAssigned,
    onConflictDetected,
    cleanupOldNotifications
} from './notifications/notification-service';

// ===================================================================
// ANALYTICS & REPORTING
// ===================================================================
import { generateAnalyticsReportHandler } from './analytics/analytics-engine';
export const generateAnalyticsReport = functions
    .runWith({
        timeoutSeconds: 300,
        memory: '2GB'
    })
    .https.onCall(async (data, context) => {
        // Apply rate limiting
        rateLimit(10, 60000)(context);
        
        // Track performance
        return PerformanceTracker.track('generateAnalyticsReport', async () => {
            const sanitized = sanitizeInput(data);
            return generateAnalyticsReportHandler(sanitized, context);
        });
    });

// ===================================================================
// SCHEDULING SYSTEM (CALLABLE FUNCTIONS)
// ===================================================================

import { YearlyScheduleEngine } from './scheduling/yearly-scheduler';
import { MonthlyCallScheduler } from './scheduling/monthly-scheduler';
import { WeeklyScheduleGenerator } from './scheduling/weekly-scheduler';
import { 
    YearlyScheduleSchema,
    MonthlyScheduleSchema,
    WeeklyScheduleSchema 
} from './schemas/scheduleSchemas';
import { AppError, wrapAsync } from './utils/error-handler';
import { CacheService } from './services/cache.service';
import { retryWithBackoff } from './utils/retry';

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

        // Apply rate limiting
        rateLimit(5, 300000)(context); // 5 requests per 5 minutes

        // Validate and sanitize input
        const validated = validateRequest(YearlyScheduleSchema)(sanitizeInput(data));
        
        // Track performance
        return PerformanceTracker.track('generateYearlySchedule', async () => {
            // Check cache first
            const cacheKey = `yearly:${validated.academicYearId}`;
            const cached = await CacheService.get(cacheKey);
            if (cached && !validated.forceRegenerate) {
                console.log('Returning cached yearly schedule');
                return cached;
            }

            // Generate schedule
            const engine = new YearlyScheduleEngine(
                validated.residents,
                validated.externalRotators,
                validated.config,
                validated.academicYearId
            );
            
            const schedule = await engine.generateSchedule();
            
            // Save to Firestore with retry logic
            await retryWithBackoff(async () => {
                await admin.firestore()
                    .collection('academicYears')
                    .doc(validated.academicYearId)
                    .set(schedule);
            });
            
            // Cache the result
            await CacheService.set(cacheKey, schedule, 3600); // 1 hour cache
            
            // Log audit trail
            await admin.firestore().collection('auditLogs').add({
                action: 'YEARLY_SCHEDULE_GENERATED',
                performedBy: context.auth.uid,
                performedByEmail: context.auth.token.email,
                academicYearId: validated.academicYearId,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                metadata: {
                    residentCount: validated.residents.length,
                    externalRotatorCount: validated.externalRotators.length
                }
            });
            
            return { 
                success: true, 
                scheduleId: validated.academicYearId,
                message: 'Yearly schedule generated successfully',
                schedule
            };
        });
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

        // Apply rate limiting
        rateLimit(10, 60000)(context); // 10 requests per minute

        // Validate and sanitize
        const validated = validateRequest(MonthlyScheduleSchema)(sanitizeInput(data));
        const { month, year, staffingLevel = 'Normal' } = validated;
        
        return PerformanceTracker.track('generateMonthlySchedule', async () => {
            // Check cache
            const cacheKey = `monthly:${year}-${month}:${staffingLevel}`;
            const cached = await CacheService.get(cacheKey);
            if (cached && !validated.forceRegenerate) {
                console.log('Returning cached monthly schedule');
                return cached;
            }

            // Fetch required data with retry logic
            const [residents, config, academicYear, approvedLeave] = await Promise.all([
                retryWithBackoff(() => getResidents()),
                retryWithBackoff(() => getConfiguration()),
                retryWithBackoff(() => getAcademicYear(`${year}-${year + 1}`)),
                retryWithBackoff(() => getApprovedLeave(month, year))
            ]);
            
            // Generate schedule
            const scheduler = new MonthlyCallScheduler(
                residents,
                config,
                academicYear,
                approvedLeave,
                month,
                year,
                [],
                validated.debugMode || false
            );
            
            const assignments = scheduler.generateSchedule(staffingLevel);
            
            // Validate generated schedule
            const validationResult = validateGeneratedSchedule(assignments, residents, config);
            if (!validationResult.isValid) {
                throw new AppError('invalid-argument', 
                    `Schedule validation failed: ${validationResult.errors.join(', ')}`, 
                    400
                );
            }
            
            // Save to Firestore with transaction
            const scheduleId = `${year}-${(month + 1).toString().padStart(2, '0')}`;
            
            await admin.firestore().runTransaction(async (transaction) => {
                const scheduleRef = admin.firestore()
                    .collection('monthlySchedules')
                    .doc(scheduleId);
                
                // Check if schedule already exists
                const existing = await transaction.get(scheduleRef);
                if (existing.exists && !validated.forceRegenerate) {
                    throw new AppError('already-exists', 
                        'Schedule already exists. Use forceRegenerate to overwrite.', 
                        409
                    );
                }
                
                transaction.set(scheduleRef, { 
                    id: scheduleId,
                    month,
                    year,
                    assignments,
                    metadata: {
                        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        generatedBy: context.auth!.uid,
                        generatedByEmail: context.auth!.token.email,
                        staffingLevel,
                        totalCalls: assignments.filter(a => a.type !== 'PostCall').length,
                        uniqueResidents: new Set(assignments.map(a => a.residentId)).size,
                        version: '4.0.0'
                    },
                    published: false
                });
                
                // Update resident stats
                for (const assignment of assignments) {
                    if (assignment.type !== 'PostCall') {
                        const statsRef = admin.firestore()
                            .collection('residentStats')
                            .doc(`${assignment.residentId}_${year}-${month + 1}`);
                        
                        transaction.set(statsRef, {
                            residentId: assignment.residentId,
                            month: `${year}-${month + 1}`,
                            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });
                    }
                }
            });
            
            // Cache the result
            await CacheService.set(cacheKey, { assignments, scheduleId }, 600); // 10 minutes
            
            // Log audit
            await admin.firestore().collection('auditLogs').add({
                action: 'MONTHLY_SCHEDULE_GENERATED',
                performedBy: context.auth.uid,
                performedByEmail: context.auth.token.email,
                scheduleId,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                metadata: {
                    month,
                    year,
                    staffingLevel,
                    assignmentCount: assignments.length
                }
            });
            
            return { 
                success: true, 
                scheduleId,
                assignmentCount: assignments.length,
                metadata: {
                    totalCalls: assignments.filter(a => a.type !== 'PostCall').length,
                    uniqueResidents: new Set(assignments.map(a => a.residentId)).size,
                    staffingLevel
                }
            };
        });
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

        // Apply rate limiting
        rateLimit(20, 60000)(context);

        // Validate and sanitize
        const validated = validateRequest(WeeklyScheduleSchema)(sanitizeInput(data));
        
        return PerformanceTracker.track('generateWeeklySchedule', async () => {
            const generator = new WeeklyScheduleGenerator(
                validated.residents,
                new Date(validated.weekStartDate),
                validated.orSlots,
                validated.clinicSlots,
                validated.callAssignments,
                validated.config
            );
            
            const weeklySchedule = generator.generate();
            
            // Save to Firestore
            await retryWithBackoff(async () => {
                await admin.firestore()
                    .collection('weeklySchedules')
                    .doc(weeklySchedule.id)
                    .set(weeklySchedule);
            });
            
            // Invalidate related caches
            await CacheService.invalidate(`weekly:${weeklySchedule.year}*`);
            
            return { 
                success: true, 
                scheduleId: weeklySchedule.id,
                daysScheduled: weeklySchedule.days.length
            };
        });
    }));

// ===================================================================
// ADMIN FUNCTIONS
// ===================================================================

export const setAdminClaim = functions.https.onCall(wrapAsync(async (data, context) => {
    if (!context.auth?.token?.admin) {
        throw new AppError('permission-denied', 'Admin access required', 403);
    }

    const { uid, isAdmin } = validateRequest(z.object({
        uid: z.string().min(1),
        isAdmin: z.boolean()
    }))(data);
    
    await admin.auth().setCustomUserClaims(uid, { admin: isAdmin });
    
    // Get user info for audit
    const user = await admin.auth().getUser(uid);
    
    await admin.firestore().collection('auditLogs').add({
        action: isAdmin ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED',
        targetUserId: uid,
        targetUserEmail: user.email,
        performedBy: context.auth.uid,
        performedByEmail: context.auth.token.email,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return { success: true, message: `Admin access ${isAdmin ? 'granted' : 'revoked'} for ${user.email}` };
}));

// ===================================================================
// HEALTH CHECK ENDPOINT
// ===================================================================
export const healthCheck = functions.https.onRequest(async (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '4.0.0',
        services: {
            firestore: 'unknown',
            auth: 'unknown',
            functions: 'healthy'
        }
    };
    
    try {
        // Check Firestore
        await admin.firestore().collection('_health').doc('check').set({
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        health.services.firestore = 'healthy';
        
        // Check Auth
        await admin.auth().getUserByEmail('health@check.com').catch(() => null);
        health.services.auth = 'healthy';
    } catch (error) {
        health.status = 'degraded';
    }
    
    res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// ===================================================================
// HELPER FUNCTIONS WITH ERROR HANDLING
// ===================================================================

async function getResidents() {
    try {
        const snapshot = await admin.firestore()
            .collection('residents')
            .where('onService', '==', true)
            .get();
        
        if (snapshot.empty) {
            throw new AppError('not-found', 'No residents on service', 404);
        }
        
        return snapshot.docs.map(doc => ({ 
            id: doc.id, 
            ...doc.data() 
        }));
    } catch (error) {
        console.error('Error fetching residents:', error);
        throw new AppError('internal', 'Failed to fetch residents', 500);
    }
}

async function getConfiguration() {
    try {
        const doc = await admin.firestore()
            .collection('configuration')
            .doc('main')
            .get();
            
        if (!doc.exists) {
            throw new AppError('not-found', 'Configuration not found', 404);
        }
        
        return doc.data();
    } catch (error) {
        console.error('Error fetching configuration:', error);
        throw new AppError('internal', 'Failed to fetch configuration', 500);
    }
}

async function getAcademicYear(yearId: string) {
    try {
        const doc = await admin.firestore()
            .collection('academicYears')
            .doc(yearId)
            .get();
            
        if (!doc.exists) {
            throw new AppError('not-found', `Academic year ${yearId} not found`, 404);
        }
        
        return doc.data();
    } catch (error) {
        console.error('Error fetching academic year:', error);
        throw new AppError('internal', 'Failed to fetch academic year', 500);
    }
}

async function getApprovedLeave(month: number, year: number) {
    try {
        const startDate = new Date(year, month, 1);
        const endDate = new Date(year, month + 1, 0, 23, 59, 59);
        
        const snapshot = await admin.firestore()
            .collection('leaveRequests')
            .where('status', '==', 'Approved')
            .where('startDate', '<=', admin.firestore.Timestamp.fromDate(endDate))
            .where('endDate', '>=', admin.firestore.Timestamp.fromDate(startDate))
            .get();
        
        return snapshot.docs.map(doc => ({ 
            id: doc.id, 
            ...doc.data() 
        }));
    } catch (error) {
        console.error('Error fetching approved leave:', error);
        // Return empty array on error - don't fail schedule generation
        return [];
    }
}

function validateGeneratedSchedule(assignments: any[], residents: any[], config: any) {
    const errors: string[] = [];
    
    // Check for required coverage
    const datesWithCoverage = new Set(
        assignments
            .filter(a => a.type !== 'PostCall')
            .map(a => a.date.toDate().toDateString())
    );
    
    // Check each resident's limits
    const residentCallCounts = new Map<string, number>();
    assignments.forEach(a => {
        if (a.type !== 'PostCall') {
            const count = residentCallCounts.get(a.residentId) || 0;
            residentCallCounts.set(a.residentId, count + 1);
        }
    });
    
    // Validate PARO limits
    residentCallCounts.forEach((count, residentId) => {
        const resident = residents.find(r => r.id === residentId);
        if (resident && count > 8) { // Max PARO limit
            errors.push(`Resident ${resident.name} exceeds PARO limit with ${count} calls`);
        }
    });
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

// Import zod for inline validation
import { z } from 'zod';

// ===================================================================
// PERFORMANCE MONITORING
// ===================================================================
export const getPerformanceStats = functions.https.onCall(async (data, context) => {
    if (!context.auth?.token?.admin) {
        throw new AppError('permission-denied', 'Admin access required', 403);
    }
    
    const operations = [
        'generateYearlySchedule',
        'generateMonthlySchedule', 
        'generateWeeklySchedule',
        'generateAnalyticsReport'
    ];
    
    const stats: any = {};
    operations.forEach(op => {
        const opStats = PerformanceTracker.getStats(op);
        if (opStats) {
            stats[op] = opStats;
        }
    });
    
    return { stats, timestamp: new Date().toISOString() };
});