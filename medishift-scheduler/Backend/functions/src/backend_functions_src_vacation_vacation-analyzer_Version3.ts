import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { 
    LeaveRequest, 
    LeaveAnalysisReport, 
    Resident,
    MonthlySchedule,
    WeeklySchedule,
    CallAssignment,
    AppConfiguration
} from '../../../shared/types';

const db = admin.firestore();

interface CoverageAnalysis {
    riskLevel: 'Low' | 'Medium' | 'High';
    availableResidents: number;
    totalResidents: number;
    overlappingLeaveCount: number;
    coverageRatio: number;
    criticalDates: Date[];
}

interface FairnessAnalysis {
    score: number;
    historicalRate: number;
    recentDaysOff: number;
    peerComparison: number;
    recommendations: string[];
}

/**
 * Vacation & Leave Analyzer
 * Triggered when a new leave request is created
 * Analyzes fairness, coverage impact, and conflicts
 */
export const analyzeLeaveRequest = functions
    .runWith({
        timeoutSeconds: 120,
        memory: '1GB'
    })
    .firestore
    .document('leaveRequests/{requestId}')
    .onCreate(async (snap, context) => {
        const leaveRequest = { 
            id: snap.id, 
            ...snap.data() 
        } as LeaveRequest;
        
        // Only analyze if status is 'Pending Analysis'
        if (leaveRequest.status !== 'Pending Analysis') {
            console.log(`Skipping analysis for request ${leaveRequest.id} with status ${leaveRequest.status}`);
            return null;
        }

        console.log(`🔍 Analyzing leave request ${leaveRequest.id} for ${leaveRequest.residentName}`);
        
        try {
            // Run comprehensive analysis
            const analysisResult = await performComprehensiveAnalysis(leaveRequest);
            
            // Create analysis report
            const reportRef = db.collection('leaveAnalysisReports').doc();
            const report: LeaveAnalysisReport = {
                id: reportRef.id,
                requestId: leaveRequest.id,
                residentId: leaveRequest.residentId,
                residentName: leaveRequest.residentName,
                analyzedAt: admin.firestore.Timestamp.now(),
                
                // Overall recommendation
                overallRecommendation: analysisResult.recommendation,
                denialReason: analysisResult.denialReason,
                
                // Coverage impact
                estimatedCoverageImpact: {
                    projectedCoverageRisk: analysisResult.coverage.riskLevel,
                    availableResidents: analysisResult.coverage.availableResidents,
                    coverageRatio: analysisResult.coverage.coverageRatio,
                    criticalDates: analysisResult.coverage.criticalDates.map(d => 
                        admin.firestore.Timestamp.fromDate(d)
                    )
                },
                
                // Fairness analysis
                fairnessScore: {
                    score: analysisResult.fairness.score,
                    historicalSuccessRateForPeriod: analysisResult.fairness.historicalRate,
                    recentDaysOff: analysisResult.fairness.recentDaysOff,
                    peerComparison: analysisResult.fairness.peerComparison
                },
                
                // Conflicts
                scheduleConflicts: analysisResult.conflicts,
                
                // Recommendations
                alternativeDates: analysisResult.alternativeDates,
                notes: analysisResult.notes
            };
            
            // Save report and update request in a transaction
            await db.runTransaction(async (transaction) => {
                transaction.set(reportRef, report);
                transaction.update(snap.ref, {
                    status: analysisResult.recommendation === 'Deny' 
                        ? 'Denied' 
                        : 'Pending Approval',
                    analysisReportId: reportRef.id,
                    denialJustification: analysisResult.denialReason,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            
            console.log(`✅ Analysis complete for ${leaveRequest.id}: ${analysisResult.recommendation}`);
            
            // Trigger notification
            await createNotification(leaveRequest, analysisResult.recommendation);
            
            return { success: true, reportId: reportRef.id };
            
        } catch (error: any) {
            console.error(`❌ Error analyzing leave request ${leaveRequest.id}:`, error);
            
            // Update request with error status
            await snap.ref.update({
                status: 'Analysis Failed',
                error: error.message,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            throw new functions.https.HttpsError('internal', 'Analysis failed', error);
        }
    });

/**
 * Comprehensive analysis orchestrator
 */
async function performComprehensiveAnalysis(request: LeaveRequest): Promise<any> {
    // Fetch all required data in parallel
    const [
        resident,
        historicalLeave,
        scheduleConflicts,
        coverageAnalysis,
        config,
        peerData
    ] = await Promise.all([
        getResident(request.residentId),
        getHistoricalLeave(request.residentId),
        checkScheduleConflicts(request),
        analyzeCoverageImpact(request),
        getConfiguration(),
        getPeerComparisonData(request)
    ]);
    
    // Calculate fairness
    const fairnessAnalysis = calculateFairness(
        request,
        historicalLeave,
        resident,
        peerData
    );
    
    // Check policy compliance
    const policyCompliance = checkPolicyCompliance(
        request,
        resident,
        historicalLeave,
        config
    );
    
    // Generate recommendation
    const recommendation = generateRecommendation(
        fairnessAnalysis,
        coverageAnalysis,
        scheduleConflicts,
        policyCompliance
    );
    
    // Find alternative dates if needed
    const alternativeDates = recommendation.decision !== 'Approve' 
        ? await findAlternativeDates(request, coverageAnalysis)
        : [];
    
    return {
        recommendation: recommendation.decision,
        denialReason: recommendation.reason,
        coverage: coverageAnalysis,
        fairness: fairnessAnalysis,
        conflicts: scheduleConflicts,
        alternativeDates,
        notes: recommendation.notes || []
    };
}

/**
 * Get resident data
 */
async function getResident(residentId: string): Promise<Resident> {
    const doc = await db.collection('residents').doc(residentId).get();
    if (!doc.exists) {
        throw new Error(`Resident ${residentId} not found`);
    }
    return { id: doc.id, ...doc.data() } as Resident;
}

/**
 * Get historical leave for fairness calculation
 */
async function getHistoricalLeave(residentId: string): Promise<LeaveRequest[]> {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const snapshot = await db.collection('leaveRequests')
        .where('residentId', '==', residentId)
        .where('startDate', '>=', admin.firestore.Timestamp.fromDate(sixMonthsAgo))
        .orderBy('startDate', 'desc')
        .get();
    
    return snapshot.docs.map(doc => ({ 
        id: doc.id, 
        ...doc.data() 
    } as LeaveRequest));
}

/**
 * Check for schedule conflicts
 */
async function checkScheduleConflicts(request: LeaveRequest): Promise<any[]> {
    const conflicts: any[] = [];
    
    // Generate date range
    const dates = [];
    const current = new Date(request.startDate.toDate());
    const end = request.endDate.toDate();
    
    while (current <= end) {
        dates.push(new Date(current));
        current.setDate(current.getDate() + 1);
    }
    
    // Check monthly call schedule
    const monthIds = [...new Set(dates.map(d => 
        `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`
    ))];
    
    for (const monthId of monthIds) {
        const monthDoc = await db.collection('monthlySchedules').doc(monthId).get();
        if (monthDoc.exists) {
            const assignments = monthDoc.data()?.assignments || [];
            const residentCalls = assignments.filter((a: CallAssignment) => 
                a.residentId === request.residentId &&
                dates.some(d => isSameDay(a.date.toDate(), d))
            );
            
            conflicts.push(...residentCalls.map((call: CallAssignment) => ({
                type: 'Call',
                date: call.date,
                description: call.type,
                severity: 'High'
            })));
        }
    }
    
    // Check weekly clinical schedule
    const weekIds = [...new Set(dates.map(d => 
        `${d.getFullYear()}-${getWeekNumber(d)}`
    ))];
    
    for (const weekId of weekIds) {
        const weekDoc = await db.collection('weeklySchedules').doc(weekId).get();
        if (weekDoc.exists) {
            const weekData = weekDoc.data();
            weekData?.days?.forEach((day: any) => {
                const dayDate = day.date.toDate();
                if (dates.some(d => isSameDay(dayDate, d))) {
                    // Check OR assignments
                    const orAssignments = day.assignments?.or?.filter(
                        (a: any) => a.residentId === request.residentId
                    ) || [];
                    
                    conflicts.push(...orAssignments.map((a: any) => ({
                        type: 'OR',
                        date: day.date,
                        description: a.caseType || 'OR Assignment',
                        severity: 'High'
                    })));
                    
                    // Check clinic assignments
                    const clinicAssignments = day.assignments?.clinic?.filter(
                        (a: any) => a.residentId === request.residentId
                    ) || [];
                    
                    conflicts.push(...clinicAssignments.map((a: any) => ({
                        type: 'Clinic',
                        date: day.date,
                        description: a.clinicType || 'Clinic',
                        severity: 'Medium'
                    })));
                }
            });
        }
    }
    
    return conflicts;
}

/**
 * Analyze coverage impact
 */
async function analyzeCoverageImpact(request: LeaveRequest): Promise<CoverageAnalysis> {
    // Get all residents in the same rotation/team
    const residentsSnapshot = await db.collection('residents')
        .where('onService', '==', true)
        .where('specialty', '==', 'Neurosurgery')
        .get();
    
    const totalResidents = residentsSnapshot.size;
    
    // Check overlapping approved leave
    const overlappingSnapshot = await db.collection('leaveRequests')
        .where('status', '==', 'Approved')
        .where('endDate', '>=', request.startDate)
        .get();
    
    const overlappingLeave = overlappingSnapshot.docs.filter(doc => {
        const leave = doc.data() as LeaveRequest;
        return leave.startDate.toDate() <= request.endDate.toDate() &&
               leave.residentId !== request.residentId;
    });
    
    const overlappingCount = overlappingLeave.length;
    const availableResidents = totalResidents - overlappingCount - 1;
    const coverageRatio = availableResidents / totalResidents;
    
    // Identify critical dates (weekends, holidays)
    const criticalDates: Date[] = [];
    const current = new Date(request.startDate.toDate());
    const end = request.endDate.toDate();
    
    while (current <= end) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) { // Weekend
            criticalDates.push(new Date(current));
        }
        current.setDate(current.getDate() + 1);
    }
    
    // Determine risk level
    let riskLevel: 'Low' | 'Medium' | 'High';
    if (coverageRatio >= 0.8) {
        riskLevel = 'Low';
    } else if (coverageRatio >= 0.6) {
        riskLevel = 'Medium';
    } else {
        riskLevel = 'High';
    }
    
    // Adjust risk based on critical dates
    if (criticalDates.length > 2 && riskLevel === 'Low') {
        riskLevel = 'Medium';
    } else if (criticalDates.length > 4) {
        riskLevel = 'High';
    }
    
    return {
        riskLevel,
        availableResidents,
        totalResidents,
        overlappingLeaveCount: overlappingCount,
        coverageRatio,
        criticalDates
    };
}

/**
 * Calculate fairness score
 */
function calculateFairness(
    request: LeaveRequest,
    historicalLeave: LeaveRequest[],
    resident: Resident,
    peerData: any
): FairnessAnalysis {
    // Calculate recent days off
    const approvedLeave = historicalLeave.filter(l => l.status === 'Approved');
    const recentDaysOff = approvedLeave.reduce((sum, leave) => {
        const days = Math.ceil(
            (leave.endDate.toDate().getTime() - leave.startDate.toDate().getTime()) 
            / (1000 * 60 * 60 * 24)
        ) + 1;
        return sum + days;
    }, 0);
    
    // Historical approval rate for this time period
    const samePeriodRequests = historicalLeave.filter(l => {
        const month = l.startDate.toDate().getMonth();
        return month === request.startDate.toDate().getMonth();
    });
    
    const approvedCount = samePeriodRequests.filter(l => l.status === 'Approved').length;
    const historicalRate = samePeriodRequests.length > 0 
        ? approvedCount / samePeriodRequests.length 
        : 0.5;
    
    // Peer comparison
    const peerAverage = peerData.averageDaysOff || 10;
    const peerComparison = peerAverage > 0 ? recentDaysOff / peerAverage : 1;
    
    // Calculate fairness score (0-100)
    let score = 100;
    
    // Deduct for excessive recent leave
    if (recentDaysOff > 15) score -= 30;
    else if (recentDaysOff > 10) score -= 20;
    else if (recentDaysOff > 5) score -= 10;
    
    // Adjust for peer comparison
    if (peerComparison > 1.5) score -= 20;
    else if (peerComparison > 1.2) score -= 10;
    else if (peerComparison < 0.5) score += 10;
    
    // Bonus for seniority
    score += resident.pgyLevel * 2;
    
    // Ensure score is within bounds
    score = Math.max(0, Math.min(100, score));
    
    // Generate recommendations
    const recommendations: string[] = [];
    if (recentDaysOff > peerAverage) {
        recommendations.push('Consider deferring to allow peers equal opportunity');
    }
    if (historicalRate < 0.3) {
        recommendations.push('This period historically has low approval rates');
    }
    
    return {
        score,
        historicalRate,
        recentDaysOff,
        peerComparison,
        recommendations
    };
}

/**
 * Check policy compliance
 */
function checkPolicyCompliance(
    request: LeaveRequest,
    resident: Resident,
    historicalLeave: LeaveRequest[],
    config: AppConfiguration
): { isCompliant: boolean; violations: string[] } {
    const violations: string[] = [];
    
    // Check minimum notice period
    const daysNotice = Math.ceil(
        (request.startDate.toDate().getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    
    const minNotice = config.leavePolicy?.minNoticeDays || 30;
    if (daysNotice < minNotice && request.type !== 'Compassionate') {
        violations.push(`Less than ${minNotice} days notice provided`);
    }
    
    // Check maximum consecutive days
    const requestDays = Math.ceil(
        (request.endDate.toDate().getTime() - request.startDate.toDate().getTime()) 
        / (1000 * 60 * 60 * 24)
    ) + 1;
    
    const maxConsecutive = config.leavePolicy?.maxConsecutiveDays || 14;
    if (requestDays > maxConsecutive) {
        violations.push(`Exceeds maximum ${maxConsecutive} consecutive days`);
    }
    
    // Check annual limits
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearLeave = historicalLeave.filter(l => 
        l.status === 'Approved' && 
        l.startDate.toDate() >= yearStart
    );
    
    const yearDaysUsed = yearLeave.reduce((sum, leave) => {
        const days = Math.ceil(
            (leave.endDate.toDate().getTime() - leave.startDate.toDate().getTime()) 
            / (1000 * 60 * 60 * 24)
        ) + 1;
        return sum + days;
    }, 0);
    
    const annualLimit = config.leavePolicy?.annualLimit || 21;
    if (yearDaysUsed + requestDays > annualLimit) {
        violations.push(`Would exceed annual limit of ${annualLimit} days`);
    }
    
    return {
        isCompliant: violations.length === 0,
        violations
    };
}

/**
 * Generate recommendation based on all factors
 */
function generateRecommendation(
    fairness: FairnessAnalysis,
    coverage: CoverageAnalysis,
    conflicts: any[],
    policyCompliance: { isCompliant: boolean; violations: string[] }
): { decision: 'Approve' | 'Flagged for Review' | 'Deny'; reason?: string; notes?: string[] } {
    const notes: string[] = [];
    
    // Auto-deny for critical conflicts
    const criticalConflicts = conflicts.filter(c => c.severity === 'High');
    if (criticalConflicts.length > 0) {
        return {
            decision: 'Deny',
            reason: `Conflicts with ${criticalConflicts.length} critical assignments including ${criticalConflicts[0].type} on ${
                criticalConflicts[0].date.toDate().toLocaleDateString()
            }`,
            notes: [`Found ${conflicts.length} total scheduling conflicts`]
        };
    }
    
    // Auto-deny for policy violations
    if (!policyCompliance.isCompliant && policyCompliance.violations.length > 1) {
        return {
            decision: 'Deny',
            reason: `Policy violations: ${policyCompliance.violations.join('; ')}`,
            notes: policyCompliance.violations
        };
    }
    
    // Auto-deny for high coverage risk
    if (coverage.riskLevel === 'High' && coverage.coverageRatio < 0.5) {
        return {
            decision: 'Deny',
            reason: 'Would result in critical understaffing with less than 50% coverage',
            notes: [`Only ${coverage.availableResidents} of ${coverage.totalResidents} residents would be available`]
        };
    }
    
    // Flag for review if multiple concerns
    const concerns = [];
    if (coverage.riskLevel === 'Medium') concerns.push('medium coverage risk');
    if (fairness.score < 40) concerns.push('low fairness score');
    if (conflicts.length > 0) concerns.push('minor conflicts');
    if (!policyCompliance.isCompliant) concerns.push('policy concerns');
    
    if (concerns.length >= 2) {
        return {
            decision: 'Flagged for Review',
            reason: `Multiple concerns: ${concerns.join(', ')}`,
            notes: [
                ...fairness.recommendations,
                ...policyCompliance.violations
            ]
        };
    }
    
    // Single concern - flag for review
    if (concerns.length === 1) {
        return {
            decision: 'Flagged for Review',
            reason: `Requires review due to ${concerns[0]}`,
            notes: [
                ...fairness.recommendations,
                ...policyCompliance.violations
            ]
        };
    }
    
    // All checks passed - approve
    notes.push(`Fairness score: ${fairness.score}/100`);
    notes.push(`Coverage impact: ${coverage.riskLevel}`);
    
    return {
        decision: 'Approve',
        notes
    };
}

/**
 * Find alternative dates with better coverage
 */
async function findAlternativeDates(
    request: LeaveRequest,
    currentCoverage: CoverageAnalysis
): Promise<Date[]> {
    const alternatives: Date[] = [];
    const duration = Math.ceil(
        (request.endDate.toDate().getTime() - request.startDate.toDate().getTime()) 
        / (1000 * 60 * 60 * 24)
    ) + 1;
    
    // Check dates within +/- 2 weeks
    const searchStart = new Date(request.startDate.toDate());
    searchStart.setDate(searchStart.getDate() - 14);
    
    for (let i = 0; i < 28; i++) {
        const testStart = new Date(searchStart);
        testStart.setDate(testStart.getDate() + i);
        
        const testEnd = new Date(testStart);
        testEnd.setDate(testEnd.getDate() + duration - 1);
        
        // Skip if overlaps with original request
        if (testStart <= request.endDate.toDate() && testEnd >= request.startDate.toDate()) {
            continue;
        }
        
        // Check coverage for this alternative period
        const testRequest = {
            ...request,
            startDate: admin.firestore.Timestamp.fromDate(testStart),
            endDate: admin.firestore.Timestamp.fromDate(testEnd)
        };
        
        const testCoverage = await analyzeCoverageImpact(testRequest);
        
        // If better coverage, add as alternative
        if (testCoverage.riskLevel === 'Low' && 
            testCoverage.coverageRatio > currentCoverage.coverageRatio) {
            alternatives.push(testStart);
        }
        
        // Limit to 3 alternatives
        if (alternatives.length >= 3) break;
    }
    
    return alternatives;
}

/**
 * Get peer comparison data
 */
async function getPeerComparisonData(request: LeaveRequest): Promise<any> {
    const resident = await getResident(request.residentId);
    
    // Get peers (same PGY level)
    const peersSnapshot = await db.collection('residents')
        .where('pgyLevel', '==', resident.pgyLevel)
        .where('specialty', '==', resident.specialty)
        .get();
    
    const peerIds = peersSnapshot.docs.map(doc => doc.id);
    
    // Get peer leave data for last 6 months
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const peerLeaveSnapshot = await db.collection('leaveRequests')
        .where('residentId', 'in', peerIds)
        .where('status', '==', 'Approved')
        .where('startDate', '>=', admin.firestore.Timestamp.fromDate(sixMonthsAgo))
        .get();
    
    // Calculate average days off
    const peerDaysOff = new Map<string, number>();
    
    peerLeaveSnapshot.docs.forEach(doc => {
        const leave = doc.data() as LeaveRequest;
        const days = Math.ceil(
            (leave.endDate.toDate().getTime() - leave.startDate.toDate().getTime()) 
            / (1000 * 60 * 60 * 24)
        ) + 1;
        
        const current = peerDaysOff.get(leave.residentId) || 0;
        peerDaysOff.set(leave.residentId, current + days);
    });
    
    const totalDays = Array.from(peerDaysOff.values()).reduce((sum, days) => sum + days, 0);
    const averageDaysOff = peerIds.length > 0 ? totalDays / peerIds.length : 10;
    
    return {
        peerCount: peerIds.length,
        averageDaysOff,
        peerDaysOffMap: peerDaysOff
    };
}

/**
 * Get application configuration
 */
async function getConfiguration(): Promise<AppConfiguration> {
    const doc = await db.collection('configuration').doc('main').get();
    if (!doc.exists) {
        // Return default configuration
        return {
            leavePolicy: {
                minNoticeDays: 30,
                maxConsecutiveDays: 14,
                annualLimit: 21
            }
        } as AppConfiguration;
    }
    return doc.data() as AppConfiguration;
}

/**
 * Create notification for the resident
 */
async function createNotification(
    request: LeaveRequest,
    recommendation: string
): Promise<void> {
    const notificationRef = db.collection('notifications').doc();
    
    let title = '';
    let message = '';
    
    switch (recommendation) {
        case 'Approve':
            title = '✅ Leave Request Analysis Complete';
            message = 'Your leave request has passed initial analysis and is pending final approval.';
            break;
        case 'Flagged for Review':
            title = '⚠️ Leave Request Under Review';
            message = 'Your leave request requires additional review by administration.';
            break;
        case 'Deny':
            title = '❌ Leave Request Denied';
            message = 'Your leave request has been automatically denied due to policy or coverage constraints.';
            break;
    }
    
    await notificationRef.set({
        id: notificationRef.id,
        recipientId: request.residentId,
        title,
        message,
        type: 'LeaveRequest',
        linkTo: `/vacation/${request.id}`,
        isRead: false,
        createdAt: admin.firestore.Timestamp.now()
    });
}

// Helper functions
function isSameDay(d1: Date, d2: Date): boolean {
    return d1.toDateString() === d2.toDateString();
}

function getWeekNumber(d: Date): number {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((date.valueOf() - yearStart.valueOf()) / 86400000 + 1) / 7);
    return weekNo;
}