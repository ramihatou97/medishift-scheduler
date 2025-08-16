import { 
    Resident, 
    AcademicYear, 
    RotationBlock, 
    RotationAssignment, 
    AppConfiguration, 
    ExternalRotator 
} from '../../../shared/types';
import { Timestamp } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';

const BLOCKS_PER_YEAR = 13;
const DAYS_PER_BLOCK = 28;

export class YearlyScheduleEngine {
    private residents: Resident[];
    private externalRotators: ExternalRotator[];
    private config: AppConfiguration;
    private academicYearId: string;
    private schedule: (RotationAssignment | null)[][];
    private blockDates: { start: Date; end: Date }[];

    constructor(
        residents: Resident[], 
        externalRotators: ExternalRotator[], 
        config: AppConfiguration, 
        academicYearId: string
    ) {
        this.residents = residents;
        this.externalRotators = externalRotators;
        this.config = config;
        this.academicYearId = academicYearId;
        this.schedule = Array(BLOCKS_PER_YEAR).fill(null).map(() => 
            Array(this.residents.length).fill(null)
        );
        this.blockDates = this.generateBlockDates();
    }

    private generateBlockDates(): { start: Date; end: Date }[] {
        const dates: { start: Date; end: Date }[] = [];
        const [startYear] = this.academicYearId.split('-').map(Number);
        let currentDate = new Date(startYear, 6, 1); // July 1st
        
        for (let i = 0; i < BLOCKS_PER_YEAR; i++) {
            const start = new Date(currentDate);
            const end = new Date(currentDate);
            end.setDate(end.getDate() + DAYS_PER_BLOCK - 1);
            
            dates.push({ start, end });
            currentDate.setDate(currentDate.getDate() + DAYS_PER_BLOCK);
        }
        
        return dates;
    }

    public async generateSchedule(): Promise<AcademicYear> {
        console.log(`🚀 Starting Full Yearly Schedule Generation for ${this.academicYearId}`);
        
        try {
            this.phase0_PlaceExternalRotators();
            this.phase1_AssignMandatoryRotations();
            this.phase2_AssignExamBlocks();
            this.phase3_AssignHolidayBlocks();
            this.phase4_AssignCoreNeurosurgeryRotations();
            this.phase5_AssignFlexibleOffServiceRotations();
            this.phase6_BalanceTeams();
            this.phase7_ValidateAndFinalize();
            
            console.log("✅ Yearly Schedule Generation Complete.");
            return this.formatScheduleForFirestore();
            
        } catch (error) {
            console.error('❌ Schedule generation failed:', error);
            throw error;
        }
    }

    private phase0_PlaceExternalRotators(): void {
        console.log("Phase 0: Placing External Rotators...");
        // External rotators are factored into coverage calculations
        // but don't occupy slots in the main schedule grid
    }

    private phase1_AssignMandatoryRotations(): void {
        console.log("Phase 1: Assigning Mandatory Off-Service Rotations...");
        const rules = this.config.yearlySchedulerConfig?.mandatoryRotations || [];
        
        rules.forEach(rule => {
            this.residents.forEach((resident, resIndex) => {
                if (rule.pgyLevels.includes(resident.pgyLevel)) {
                    this.assign(rule.blockNumber - 1, resIndex, {
                        rotationName: rule.rotationName,
                        rotationType: 'MANDATORY_OFF_SERVICE',
                        required: true
                    });
                }
            });
        });
    }

    private phase2_AssignExamBlocks(): void {
        console.log("Phase 2: Assigning Mandatory Exam Leave Blocks...");
        const rules = this.config.yearlySchedulerConfig?.examLeave || [];
        
        rules.forEach(rule => {
            this.residents.forEach((resident, resIndex) => {
                if (rule.pgyLevels.includes(resident.pgyLevel)) {
                    this.assign(rule.blockNumber - 1, resIndex, {
                        rotationName: rule.rotationName,
                        rotationType: 'EXAM_LEAVE',
                        required: true
                    });
                }
            });
        });
    }
    
    private phase3_AssignHolidayBlocks(): void {
        console.log("Phase 3: Assigning Competitive Holiday Blocks...");
        
        // Sort seniors by seniority for fair holiday distribution
        const seniors = this.residents
            .map((r, idx) => ({ resident: r, index: idx }))
            .filter(r => r.resident.pgyLevel >= 4)
            .sort((a, b) => b.resident.pgyLevel - a.resident.pgyLevel);
        
        seniors.forEach((senior, idx) => {
            const blockToAssign = idx % 2 === 0 ? 6 : 7; // Christmas vs New Year
            
            if (this.isSlotEmpty(blockToAssign - 1, senior.index)) {
                this.assign(blockToAssign - 1, senior.index, {
                    rotationName: 'Holiday Leave',
                    rotationType: 'HOLIDAY_LEAVE',
                    holidayType: blockToAssign === 6 ? 'Christmas' : 'NewYear'
                });
            }
        });
    }

    private phase4_AssignCoreNeurosurgeryRotations(): void {
        console.log("Phase 4: Assigning Core Neurosurgery Rotations...");
        
        for (let block = 0; block < BLOCKS_PER_YEAR; block++) {
            for (let resIndex = 0; resIndex < this.residents.length; resIndex++) {
                if (this.isSlotEmpty(block, resIndex)) {
                    this.assign(block, resIndex, {
                        rotationName: 'Neurosurgery - Core',
                        rotationType: 'CORE_NSX'
                    });
                }
            }
        }
    }

    private phase5_AssignFlexibleOffServiceRotations(): void {
        console.log("Phase 5: Placing Flexible/Elective Rotations...");
        
        // This would integrate with resident preferences
        // For now, we'll leave core rotations in place
    }
    
    private phase6_BalanceTeams(): void {
        console.log("Phase 6: Balancing Red/Blue Teams...");
        
        for (let block = 0; block < BLOCKS_PER_YEAR; block++) {
            let redTeamCount = 0;
            let blueTeamCount = 0;
            
            // First pass: count existing team assignments
            this.schedule[block].forEach(assignment => {
                if (assignment?.rotationType === 'CORE_NSX') {
                    if (assignment.team === 'Red') redTeamCount++;
                    else if (assignment.team === 'Blue') blueTeamCount++;
                }
            });
            
            // Second pass: assign teams to unassigned core rotations
            this.schedule[block].forEach((assignment, resIndex) => {
                if (assignment && assignment.rotationType === 'CORE_NSX' && !assignment.team) {
                    if (redTeamCount <= blueTeamCount) {
                        assignment.team = 'Red';
                        redTeamCount++;
                    } else {
                        assignment.team = 'Blue';
                        blueTeamCount++;
                    }
                }
            });
        }
    }

    private phase7_ValidateAndFinalize(): void {
        console.log("Phase 7: Validating Final Schedule...");
        
        let hasErrors = false;
        
        for (let block = 0; block < BLOCKS_PER_YEAR; block++) {
            const assignmentsInBlock = this.schedule[block]
                .filter(a => a !== null) as RotationAssignment[];
            
            if (!this.validateBlockCoverage(assignmentsInBlock, block)) {
                console.error(`⚠️ Coverage violation in Block ${block + 1}. Manual adjustment required.`);
                hasErrors = true;
            }
        }
        
        if (hasErrors) {
            console.warn('Schedule has coverage violations that need manual review');
        }
    }

    private assign(
        block: number, 
        resIndex: number, 
        rotation: Omit<RotationAssignment, 'residentId'>
    ): void {
        if (this.isSlotEmpty(block, resIndex)) {
            this.schedule[block][resIndex] = {
                residentId: this.residents[resIndex].id,
                ...rotation
            } as RotationAssignment;
        }
    }

    private isSlotEmpty(block: number, resIndex: number): boolean {
        return this.schedule[block][resIndex] === null;
    }

    private validateBlockCoverage(
        assignmentsInBlock: RotationAssignment[], 
        blockNumber: number
    ): boolean {
        const rules = this.config.coverageRules?.rotationBlock?.filter(
            rule => rule.isEnabled
        ) || [];
        
        for (const rule of rules) {
            const relevantResidents = this.filterResidentsForRule(assignmentsInBlock, rule);
            const externalCount = this.getExternalRotatorsForBlock(blockNumber);
            const totalCoverage = relevantResidents.length + externalCount;
            
            if (totalCoverage < rule.minCount) {
                return false;
            }
        }
        
        return true;
    }

    private filterResidentsForRule(
        assignments: RotationAssignment[], 
        rule: any
    ): Resident[] {
        const residentIds = assignments
            .filter(a => a.rotationType === 'CORE_NSX')
            .map(a => a.residentId);
        
        let filteredResidents = this.residents.filter(r => 
            residentIds.includes(r.id)
        );

        if (rule.appliesTo === 'SPECIALTY') {
            filteredResidents = filteredResidents.filter(r => 
                r.specialty === rule.specialty
            );
        } else if (rule.appliesTo === 'SPECIALTY_PGY_MIN') {
            filteredResidents = filteredResidents.filter(r => 
                r.specialty === rule.specialty && 
                r.pgyLevel >= rule.minPgyLevel
            );
        }
        
        return filteredResidents;
    }

    private getExternalRotatorsForBlock(blockNumber: number): number {
        // Count external rotators scheduled for this block
        return this.externalRotators.filter(rotator => {
            const blockDates = this.blockDates[blockNumber];
            return rotator.startDate <= blockDates.end && 
                   rotator.endDate >= blockDates.start;
        }).length;
    }

    private formatScheduleForFirestore(): AcademicYear {
        const blocks: RotationBlock[] = [];
        
        for (let blockNum = 0; blockNum < BLOCKS_PER_YEAR; blockNum++) {
            const assignments = this.schedule[blockNum]
                .filter(a => a !== null) as RotationAssignment[];
            
            blocks.push({
                blockNumber: blockNum + 1,
                startDate: Timestamp.fromDate(this.blockDates[blockNum].start),
                endDate: Timestamp.fromDate(this.blockDates[blockNum].end),
                assignments
            });
        }
        
        return {
            id: this.academicYearId,
            blocks,
            metadata: {
                generatedAt: Timestamp.now(),
                totalResidents: this.residents.length,
                totalExternalRotators: this.externalRotators.length,
                version: '1.0.0'
            }
        };
    }
}