/**
 * Monthly Call Scheduler for MediShift
 * Version: 4.0 - Full Implementation
 * Author: MediShift Team
 * Date: January 2025
 * 
 * Features:
 * - PARO compliance with hard caps
 * - PGY-based call ratios
 * - Normal vs Shortage staffing modes
 * - Weekend/Holiday handling
 * - Post-call assignments
 * - Fairness distribution
 * - Leave conflict checking
 * - Team balancing
 */

import { 
    Resident, 
    CallAssignment, 
    AppConfiguration, 
    AcademicYear,
    LeaveRequest,
    RotationBlock
} from '../../../shared/types';
import { Timestamp } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';

// ===================================================================
// INTERFACES
// ===================================================================

interface CallStats {
    totalCalls: number;
    weekendCalls: number;
    holidayCalls: number;
    nightCalls: number;
    lastCallDate?: Date;
    consecutiveDays: number;
    callDates: Date[];
    points: number;
}

interface SchedulingScore {
    resident: Resident;
    score: number;
    reasons: string[];
    eligibility: {
        canTakeCall: boolean;
        maxCallsReached: boolean;
        maxWeekendsReached: boolean;
        onLeave: boolean;
        postCall: boolean;
        offService: boolean;
    };
}

interface ScheduleMetrics {
    totalCalls: number;
    totalWeekendCalls: number;
    totalNightCalls: number;
    totalHolidayCalls: number;
    coverageRate: number;
    fairnessIndex: number;
    violations: string[];
    residentDistribution: Map<string, number>;
}

interface DayRequirements {
    date: Date;
    dayOfWeek: number;
    isWeekend: boolean;
    isHoliday: boolean;
    callType: 'Night' | 'Weekend' | 'Holiday' | 'None';
    requiredCoverage: number;
    priority: number;
}

// ===================================================================
// MAIN SCHEDULER CLASS
// ===================================================================

export class MonthlyCallScheduler {
    private residents: Resident[];
    private config: AppConfiguration;
    private academicYear: AcademicYear;
    private approvedLeave: LeaveRequest[];
    private month: number;
    private year: number;
    private callStats: Map<string, CallStats>;
    private existingAssignments: CallAssignment[];
    private holidays: Date[];
    private debugMode: boolean;

    constructor(
        residents: Resident[], 
        config: AppConfiguration, 
        academicYear: AcademicYear,
        approvedLeave: LeaveRequest[],
        month: number,
        year: number,
        existingAssignments: CallAssignment[] = [],
        debugMode: boolean = false
    ) {
        this.residents = residents;
        this.config = config;
        this.academicYear = academicYear;
        this.approvedLeave = approvedLeave;
        this.month = month;
        this.year = year;
        this.existingAssignments = existingAssignments;
        this.debugMode = debugMode;
        this.callStats = new Map();
        this.holidays = this.loadHolidays();
        
        // Initialize call stats for each resident
        this.initializeCallStats();
    }

    /**
     * Initialize call statistics for all residents
     */
    private initializeCallStats(): void {
        this.residents.forEach(resident => {
            // Count existing calls from previous schedules if any
            const existingCalls = this.existingAssignments.filter(
                a => a.residentId === resident.id && a.type !== 'PostCall'
            );
            
            this.callStats.set(resident.id, {
                totalCalls: existingCalls.length,
                weekendCalls: existingCalls.filter(a => a.type === 'Weekend').length,
                holidayCalls: existingCalls.filter(a => a.type === 'Holiday').length,
                nightCalls: existingCalls.filter(a => a.type === 'Night').length,
                lastCallDate: this.getLastCallDate(existingCalls),
                consecutiveDays: 0,
                callDates: existingCalls.map(a => a.date.toDate()),
                points: existingCalls.reduce((sum, a) => sum + (a.points || 0), 0)
            });
        });
    }

    /**
     * MAIN SCHEDULING METHOD - COMPLETE IMPLEMENTATION
     */
    public generateSchedule(staffingLevel: 'Normal' | 'Shortage' = 'Normal'): CallAssignment[] {
        console.log('════════════════════════════════════════════════════════════════');
        console.log(`🚀 MONTHLY CALL SCHEDULER v4.0 - STARTING`);
        console.log(`📅 Period: ${this.getMonthName(this.month)} ${this.year}`);
        console.log(`👥 Residents: ${this.residents.length}`);
        console.log(`⚡ Mode: ${staffingLevel}`);
        console.log('════════════════════════════════════════════════════════════════');
        
        const assignments: CallAssignment[] = [];
        const daysInMonth = new Date(this.year, this.month + 1, 0).getDate();
        
        // Pre-calculate all day requirements
        const dayRequirements = this.calculateDayRequirements(daysInMonth);
        
        // Sort days by priority (holidays > weekends > regular nights)
        dayRequirements.sort((a, b) => b.priority - a.priority);
        
        // Process each day
        for (const dayReq of dayRequirements) {
            if (dayReq.callType === 'None') continue;
            
            this.log(`\n📆 Processing ${dayReq.date.toDateString()} - ${dayReq.callType} Call`);
            
            // Find best resident(s) for this day
            const requiredResidents = this.getRequiredResidentCount(dayReq.callType);
            const selectedResidents: Resident[] = [];
            
            for (let i = 0; i < requiredResidents; i++) {
                const bestResident = this.selectBestResident(
                    dayReq.date, 
                    dayReq.callType, 
                    staffingLevel,
                    selectedResidents.map(r => r.id)
                );
                
                if (!bestResident) {
                    console.error(`⚠️ WARNING: Cannot fill position ${i + 1}/${requiredResidents} for ${dayReq.date.toDateString()}`);
                    continue;
                }
                
                selectedResidents.push(bestResident);
                
                // Create assignment
                const assignment = this.createCallAssignment(
                    bestResident,
                    dayReq.date,
                    dayReq.callType,
                    dayReq.isHoliday
                );
                
                assignments.push(assignment);
                
                // Update stats
                this.updateResidentStats(bestResident.id, dayReq);
                
                // Add post-call if needed
                const postCallAssignments = this.createPostCallAssignments(
                    assignment,
                    dayReq.callType
                );
                assignments.push(...postCallAssignments);
                
                this.log(`✅ Assigned to ${bestResident.name} (PGY-${bestResident.pgyLevel})`);
            }
        }
        
        // Final validation and metrics
        const metrics = this.calculateScheduleMetrics(assignments);
        this.displayScheduleSummary(assignments, metrics, staffingLevel);
        
        return assignments;
    }

    /**
     * SELECT BEST RESIDENT FOR CALL
     * Core algorithm that uses getMaxCalls
     */
    private selectBestResident(
        date: Date, 
        callType: string,
        staffingLevel: 'Normal' | 'Shortage',
        excludeIds: string[] = []
    ): Resident | null {
        // Get all eligible residents
        const eligibleResidents = this.residents.filter(resident => 
            !excludeIds.includes(resident.id) &&
            this.isEligibleForCall(resident, date, staffingLevel)
        );
        
        if (eligibleResidents.length === 0) {
            this.log(`❌ No eligible residents for ${date.toDateString()}`);
            return null;
        }
        
        // Score each resident
        const scoredResidents = eligibleResidents.map(resident => 
            this.scoreResident(resident, date, callType)
        );
        
        // Sort by score (higher is better)
        scoredResidents.sort((a, b) => b.score - a.score);
        
        // Log top candidates if in debug mode
        if (this.debugMode) {
            this.log('Top 3 Candidates:');
            scoredResidents.slice(0, 3).forEach((s, i) => {
                this.log(`  ${i + 1}. ${s.resident.name}: ${s.score} points`);
                s.reasons.forEach(r => this.log(`     - ${r}`));
            });
        }
        
        return scoredResidents[0].resident;
    }

    /**
     * CHECK RESIDENT ELIGIBILITY
     * This is where getMaxCalls is used!
     */
    private isEligibleForCall(
        resident: Resident, 
        date: Date,
        staffingLevel: 'Normal' | 'Shortage'
    ): boolean {
        const stats = this.callStats.get(resident.id)!;
        
        // 1. Check if on core neurosurgery rotation
        const block = this.getCurrentBlock(date);
        if (!block) {
            this.log(`   ❌ ${resident.name}: No block found for date`);
            return false;
        }
        
        const rotation = block.assignments.find(a => a.residentId === resident.id);
        if (!rotation) {
            this.log(`   ❌ ${resident.name}: No rotation assignment`);
            return false;
        }
        
        if (rotation.rotationType !== 'CORE_NSX') {
            this.log(`   ❌ ${resident.name}: Off-service (${rotation.rotationType})`);
            return false;
        }
        
        // 2. Check if on approved leave
        const onLeave = this.isOnLeave(resident.id, date);
        if (onLeave) {
            this.log(`   ❌ ${resident.name}: On leave`);
            return false;
        }
        
        // 3. Check post-call status (no consecutive calls)
        if (this.isPostCall(resident.id, date)) {
            this.log(`   ❌ ${resident.name}: Post-call`);
            return false;
        }
        
        // 4. CHECK MAX CALLS USING getMaxCalls!
        const workingDays = this.getWorkingDaysForBlock(block);
        const maxCalls = this.getMaxCalls(resident, workingDays, staffingLevel);
        
        if (stats.totalCalls >= maxCalls) {
            this.log(`   ❌ ${resident.name}: Max calls reached (${stats.totalCalls}/${maxCalls})`);
            return false;
        }
        
        // 5. Check weekend limits
        if (this.isWeekend(date)) {
            const maxWeekends = this.config.monthlySchedulerConfig.maxWeekendsPerRotation || 2;
            if (stats.weekendCalls >= maxWeekends) {
                this.log(`   ❌ ${resident.name}: Max weekends reached (${stats.weekendCalls}/${maxWeekends})`);
                return false;
            }
        }
        
        // 6. Check PARO 24-hour rule compliance
        if (!this.checkPAROCompliance(resident.id, date)) {
            this.log(`   ❌ ${resident.name}: Would violate PARO 24-hour rule`);
            return false;
        }
        
        this.log(`   ✅ ${resident.name}: Eligible`);
        return true;
    }

    /**
     * GET MAX CALLS - TWO-TIERED LOGIC
     * Critical method that implements PARO and PGY rules
     */
    private getMaxCalls(
        resident: Resident, 
        workingDays: number, 
        staffingLevel: 'Normal' | 'Shortage'
    ): number {
        // Chiefs who are call-exempt don't take calls
        if (resident.isChief && resident.callExempt) {
            return 0;
        }

        // Find applicable PARO hard cap
        const paroRule = this.config.monthlySchedulerConfig.paroHardCaps.find(
            rule => workingDays >= rule.minDays && workingDays <= rule.maxDays
        );
        
        const paroHardCap = paroRule ? paroRule.calls : 8;

        // Get PGY-specific call ratio
        const callRatio = this.config.monthlySchedulerConfig.callRatios[resident.pgyLevel];
        
        if (!callRatio) {
            console.warn(`⚠️ No call ratio for PGY-${resident.pgyLevel}, using PARO cap`);
            return paroHardCap;
        }

        // Calculate PGY target
        const pgyTarget = Math.floor(workingDays / callRatio);

        // TWO-TIERED LOGIC:
        // Normal: Use minimum of PARO and PGY target
        // Shortage: Relax to PARO cap only
        const maxCalls = staffingLevel === 'Normal' 
            ? Math.min(paroHardCap, pgyTarget) 
            : paroHardCap;

        if (this.debugMode) {
            console.log(`📊 Max calls for ${resident.name} (PGY-${resident.pgyLevel}):`);
            console.log(`   Working days: ${workingDays}`);
            console.log(`   PARO cap: ${paroHardCap}`);
            console.log(`   PGY target (1:${callRatio}): ${pgyTarget}`);
            console.log(`   Final max (${staffingLevel}): ${maxCalls}`);
        }

        return maxCalls;
    }

    /**
     * Score resident for selection
     */
    private scoreResident(
        resident: Resident, 
        date: Date, 
        callType: string
    ): SchedulingScore {
        const stats = this.callStats.get(resident.id)!;
        const reasons: string[] = [];
        let score = 100;
        
        // 1. Fairness - distribute calls evenly
        const avgCalls = this.getAverageCallCount();
        const callDifference = stats.totalCalls - avgCalls;
        const fairnessScore = Math.max(0, 30 - (callDifference * 10));
        score += fairnessScore;
        reasons.push(`Fairness: +${fairnessScore} (${stats.totalCalls} calls vs avg ${avgCalls.toFixed(1)})`);
        
        // 2. Days since last call
        if (stats.lastCallDate) {
            const daysSince = this.getDaysBetween(stats.lastCallDate, date);
            const restScore = Math.min(daysSince * 3, 30);
            score += restScore;
            reasons.push(`Rest: +${restScore} (${daysSince} days since last call)`);
        } else {
            score += 30;
            reasons.push(`Rest: +30 (no previous calls)`);
        }
        
        // 3. Seniority preference for complex calls
        if (callType === 'Weekend' || callType === 'Holiday') {
            const seniorityScore = resident.pgyLevel * 2;
            score += seniorityScore;
            reasons.push(`Seniority: +${seniorityScore} (PGY-${resident.pgyLevel} for ${callType})`);
        }
        
        // 4. Point balance (holidays worth more)
        const avgPoints = this.getAveragePoints();
        const pointDiff = stats.points - avgPoints;
        const pointScore = Math.max(0, 20 - pointDiff);
        score += pointScore;
        reasons.push(`Points: +${pointScore} (${stats.points} vs avg ${avgPoints.toFixed(1)})`);
        
        // 5. Team balance
        const block = this.getCurrentBlock(date);
        const rotation = block?.assignments.find(a => a.residentId === resident.id);
        if (rotation?.team) {
            const teamBalance = this.getTeamCallBalance(rotation.team);
            score += teamBalance;
            if (teamBalance !== 0) {
                reasons.push(`Team: ${teamBalance > 0 ? '+' : ''}${teamBalance} (${rotation.team} team)`);
            }
        }
        
        // 6. Preference penalties
        if (this.hasRequestedTimeOff(resident.id, date)) {
            score -= 50;
            reasons.push(`Preference: -50 (requested time off)`);
        }
        
        return {
            resident,
            score: Math.max(0, score),
            reasons,
            eligibility: {
                canTakeCall: true,
                maxCallsReached: false,
                maxWeekendsReached: false,
                onLeave: false,
                postCall: false,
                offService: false
            }
        };
    }

    /**
     * Create call assignment object
     */
    private createCallAssignment(
        resident: Resident,
        date: Date,
        callType: string,
        isHoliday: boolean
    ): CallAssignment {
        return {
            id: `call-${this.year}-${(this.month + 1).toString().padStart(2, '0')}-${date.getDate()}-${resident.id}`,
            residentId: resident.id,
            residentName: resident.name,
            date: Timestamp.fromDate(date),
            type: callType as any,
            points: this.calculateCallPoints(callType),
            isHoliday,
            team: this.getResidentTeam(resident.id, date),
            createdAt: Timestamp.now(),
            createdBy: 'system',
            status: 'Scheduled'
        };
    }

    /**
     * Create post-call assignments
     */
    private createPostCallAssignments(
        callAssignment: CallAssignment,
        callType: string
    ): CallAssignment[] {
        if (!this.requiresPostCall(callType)) {
            return [];
        }
        
        const postCallDate = new Date(callAssignment.date.toDate());
        postCallDate.setDate(postCallDate.getDate() + 1);
        
        // Don't create post-call for next month
        if (postCallDate.getMonth() !== this.month) {
            return [];
        }
        
        return [{
            ...callAssignment,
            id: `postcall-${callAssignment.id}`,
            date: Timestamp.fromDate(postCallDate),
            type: 'PostCall',
            points: 0,
            status: 'PostCall'
        }];
    }

    /**
     * Update resident statistics after assignment
     */
    private updateResidentStats(residentId: string, dayReq: DayRequirements): void {
        const stats = this.callStats.get(residentId)!;
        stats.totalCalls++;
        stats.lastCallDate = dayReq.date;
        stats.callDates.push(dayReq.date);
        
        if (dayReq.isWeekend) stats.weekendCalls++;
        if (dayReq.isHoliday) stats.holidayCalls++;
        if (dayReq.callType === 'Night') stats.nightCalls++;
        
        stats.points += this.calculateCallPoints(dayReq.callType);
    }

    /**
     * Calculate required coverage for each day
     */
    private calculateDayRequirements(daysInMonth: number): DayRequirements[] {
        const requirements: DayRequirements[] = [];
        
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(this.year, this.month, day);
            const dayOfWeek = date.getDay();
            const isWeekend = this.isWeekend(date);
            const isHoliday = this.isHoliday(date);
            
            let callType: 'Night' | 'Weekend' | 'Holiday' | 'None';
            let priority = 0;
            
            if (isHoliday) {
                callType = 'Holiday';
                priority = 3;
            } else if (isWeekend) {
                callType = 'Weekend';
                priority = 2;
            } else if (dayOfWeek >= 1 && dayOfWeek <= 4) {
                callType = 'Night';
                priority = 1;
            } else {
                callType = 'None';
                priority = 0;
            }
            
            requirements.push({
                date,
                dayOfWeek,
                isWeekend,
                isHoliday,
                callType,
                requiredCoverage: this.getRequiredResidentCount(callType),
                priority
            });
        }
        
        return requirements;
    }

    /**
     * Get working days in block (excluding holidays)
     */
    private getWorkingDaysForBlock(block?: RotationBlock): number {
        if (!block) return 28;
        
        const start = block.startDate.toDate();
        const end = block.endDate.toDate();
        let workingDays = 0;
        
        const current = new Date(start);
        while (current <= end) {
            if (!this.isHoliday(current)) {
                workingDays++;
            }
            current.setDate(current.getDate() + 1);
        }
        
        return workingDays;
    }

    /**
     * Check PARO 24-hour compliance
     */
    private checkPAROCompliance(residentId: string, date: Date): boolean {
        const stats = this.callStats.get(residentId)!;
        
        // Check no more than 1 in 4 days averaged over last 28 days
        const lookback = 28;
        const lookbackDate = new Date(date);
        lookbackDate.setDate(lookbackDate.getDate() - lookback);
        
        const recentCalls = stats.callDates.filter(d => 
            d >= lookbackDate && d < date
        ).length;
        
        // Would adding this call violate 1-in-4?
        return (recentCalls + 1) <= (lookback / 4);
    }

    /**
     * Calculate schedule metrics for validation
     */
    private calculateScheduleMetrics(assignments: CallAssignment[]): ScheduleMetrics {
        const violations: string[] = [];
        const residentDistribution = new Map<string, number>();
        
        // Count calls per resident
        assignments.forEach(a => {
            if (a.type !== 'PostCall') {
                const count = residentDistribution.get(a.residentId) || 0;
                residentDistribution.set(a.residentId, count + 1);
            }
        });
        
        // Check for violations
        this.residents.forEach(resident => {
            const calls = residentDistribution.get(resident.id) || 0;
            const block = this.getCurrentBlock(new Date(this.year, this.month, 15));
            const workingDays = this.getWorkingDaysForBlock(block);
            const maxCalls = this.getMaxCalls(resident, workingDays, 'Normal');
            
            if (calls > maxCalls) {
                violations.push(`${resident.name}: ${calls} calls exceeds max ${maxCalls}`);
            }
        });
        
        // Calculate fairness (Gini coefficient)
        const fairnessIndex = this.calculateGiniCoefficient(
            Array.from(residentDistribution.values())
        );
        
        return {
            totalCalls: assignments.filter(a => a.type !== 'PostCall').length,
            totalWeekendCalls: assignments.filter(a => a.type === 'Weekend').length,
            totalNightCalls: assignments.filter(a => a.type === 'Night').length,
            totalHolidayCalls: assignments.filter(a => a.type === 'Holiday').length,
            coverageRate: this.calculateCoverageRate(assignments),
            fairnessIndex,
            violations,
            residentDistribution
        };
    }

    /**
     * Display schedule summary
     */
    private displayScheduleSummary(
        assignments: CallAssignment[],
        metrics: ScheduleMetrics,
        staffingLevel: string
    ): void {
        console.log('\n════════════════════════════════════════════════════════════════');
        console.log('📊 SCHEDULE GENERATION COMPLETE');
        console.log('════════════════════════════════════════════════════════════════');
        console.log(`Total Assignments: ${assignments.length}`);
        console.log(`Call Assignments: ${metrics.totalCalls}`);
        console.log(`  - Night Calls: ${metrics.totalNightCalls}`);
        console.log(`  - Weekend Calls: ${metrics.totalWeekendCalls}`);
        console.log(`  - Holiday Calls: ${metrics.totalHolidayCalls}`);
        console.log(`Coverage Rate: ${(metrics.coverageRate * 100).toFixed(1)}%`);
        console.log(`Fairness Index: ${metrics.fairnessIndex.toFixed(3)} (0=perfect equality)`);
        
        console.log('\n📈 Distribution by Resident:');
        const sorted = Array.from(metrics.residentDistribution.entries())
            .sort((a, b) => b[1] - a[1]);
        
        sorted.forEach(([residentId, calls]) => {
            const resident = this.residents.find(r => r.id === residentId);
            if (resident) {
                const stats = this.callStats.get(residentId)!;
                console.log(`  ${resident.name} (PGY-${resident.pgyLevel}): ${calls} calls, ${stats.points} points`);
            }
        });
        
        if (metrics.violations.length > 0) {
            console.log('\n⚠️ VIOLATIONS:');
            metrics.violations.forEach(v => console.log(`  - ${v}`));
        } else {
            console.log('\n✅ All constraints satisfied!');
        }
        
        console.log('════════════════════════════════════════════════════════════════\n');
    }

    // ===================================================================
    // HELPER METHODS
    // ===================================================================

    private getCurrentBlock(date: Date): RotationBlock | undefined {
        return this.academicYear.blocks.find(b => 
            date >= b.startDate.toDate() && 
            date <= b.endDate.toDate()
        );
    }

    private isWeekend(date: Date): boolean {
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
        const weekendDays = this.config.monthlySchedulerConfig.weekendDefinition || 
                           ['Friday', 'Saturday', 'Sunday'];
        return weekendDays.map(d => d.toLowerCase())
                         .includes(dayName.toLowerCase());
    }

    private isHoliday(date: Date): boolean {
        return this.holidays.some(h => 
            h.toDateString() === date.toDateString()
        );
    }

    private loadHolidays(): Date[] {
        const holidays: Date[] = [];
        
        // Add configured holidays
        if (this.config.holidays) {
            this.config.holidays.forEach(h => {
                holidays.push(new Date(h));
            });
        }
        
        // Add standard holidays for the year
        holidays.push(
            new Date(this.year, 0, 1),    // New Year's Day
            new Date(this.year, 6, 4),    // Independence Day
            new Date(this.year, 11, 25),  // Christmas
        );
        
        return holidays;
    }

    private isOnLeave(residentId: string, date: Date): boolean {
        return this.approvedLeave.some(leave => 
            leave.residentId === residentId &&
            leave.status === 'Approved' &&
            date >= leave.startDate.toDate() &&
            date <= leave.endDate.toDate()
        );
    }

    private isPostCall(residentId: string, date: Date): boolean {
        const stats = this.callStats.get(residentId)!;
        if (!stats.lastCallDate) return false;
        
        const daysSince = this.getDaysBetween(stats.lastCallDate, date);
        return daysSince < 2; // Must have at least 1 day between calls
    }

    private hasRequestedTimeOff(residentId: string, date: Date): boolean {
        // Check if resident has a pending/denied leave request for this date
        return this.approvedLeave.some(leave => 
            leave.residentId === residentId &&
            leave.status === 'Pending Approval' &&
            date >= leave.startDate.toDate() &&
            date <= leave.endDate.toDate()
        );
    }

    private getResidentTeam(residentId: string, date: Date): string | undefined {
        const block = this.getCurrentBlock(date);
        const rotation = block?.assignments.find(a => a.residentId === residentId);
        return rotation?.team;
    }

    private getRequiredResidentCount(callType: string): number {
        // Can be configured based on call type and hospital needs
        switch (callType) {
            case 'Holiday': return 2; // Double coverage for holidays
            case 'Weekend': return 1;
            case 'Night': return 1;
            default: return 0;
        }
    }

    private requiresPostCall(callType: string): boolean {
        return ['Night', 'Weekend', 'Holiday'].includes(callType);
    }

    private calculateCallPoints(callType: string): number {
        const points: Record<string, number> = {
            'Night': 1,
            'Weekend': 2,
            'Holiday': 3,
            'PostCall': 0
        };
        return points[callType] || 0;
    }

    private getAverageCallCount(): number {
        if (this.residents.length === 0) return 0;
        let total = 0;
        this.callStats.forEach(stats => {
            total += stats.totalCalls;
        });
        return total / this.residents.length;
    }

    private getAveragePoints(): number {
        if (this.residents.length === 0) return 0;
        let total = 0;
        this.callStats.forEach(stats => {
            total += stats.points;
        });
        return total / this.residents.length;
    }

    private getTeamCallBalance(team: string): number {
        // Calculate if this team has more or fewer calls than average
        let teamCalls = 0;
        let teamMembers = 0;
        
        this.residents.forEach(resident => {
            const block = this.getCurrentBlock(new Date(this.year, this.month, 15));
            const rotation = block?.assignments.find(a => a.residentId === resident.id);
            if (rotation?.team === team) {
                const stats = this.callStats.get(resident.id)!;
                teamCalls += stats.totalCalls;
                teamMembers++;
            }
        });
        
        if (teamMembers === 0) return 0;
        
        const teamAverage = teamCalls / teamMembers;
        const overallAverage = this.getAverageCallCount();
        
        // Return positive score if team has fewer calls (needs more)
        // Return negative if team has more calls (needs fewer)
        return Math.round((overallAverage - teamAverage) * 5);
    }

    private getDaysBetween(date1: Date, date2: Date): number {
        const diffTime = Math.abs(date2.getTime() - date1.getTime());
        return Math.floor(diffTime / (1000 * 60 * 60 * 24));
    }

    private getLastCallDate(assignments: CallAssignment[]): Date | undefined {
        if (assignments.length === 0) return undefined;
        
        const sorted = assignments.sort((a, b) => 
            b.date.toDate().getTime() - a.date.toDate().getTime()
        );
        
        return sorted[0].date.toDate();
    }

    private calculateCoverageRate(assignments: CallAssignment[]): number {
        const daysInMonth = new Date(this.year, this.month + 1, 0).getDate();
        let coveredDays = 0;
        
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(this.year, this.month, day);
            const hasCall = assignments.some(a => 
                a.type !== 'PostCall' &&
                a.date.toDate().toDateString() === date.toDateString()
            );
            if (hasCall) coveredDays++;
        }
        
        return coveredDays / daysInMonth;
    }

    private calculateGiniCoefficient(values: number[]): number {
        if (values.length === 0) return 0;
        
        const sorted = values.sort((a, b) => a - b);
        const n = sorted.length;
        const cumSum = sorted.reduce((acc, val, i) => {
            acc.push((acc[i - 1] || 0) + val);
            return acc;
        }, [] as number[]);
        
        const totalSum = cumSum[n - 1];
        if (totalSum === 0) return 0;
        
        const fairShare = totalSum / n;
        const lorenzCurve = cumSum.map(s => s / totalSum);
        
        let giniSum = 0;
        for (let i = 0; i < n; i++) {
            giniSum += (i + 1) / n - lorenzCurve[i];
        }
        
        return giniSum / n;
    }

    private getMonthName(month: number): string {
        const months = [
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'
        ];
        return months[month];
    }

    private log(message: string): void {
        if (this.debugMode) {
            console.log(message);
        }
    }
}

// ===================================================================
// EXPORT FOR USE IN CLOUD FUNCTIONS
// ===================================================================

export default MonthlyCallScheduler;