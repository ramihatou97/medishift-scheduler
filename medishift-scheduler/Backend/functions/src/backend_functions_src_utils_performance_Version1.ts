import * as functions from 'firebase-functions';

export class PerformanceMonitor {
    private startTime: number;
    private checkpoints: Map<string, number>;
    
    constructor(private operationName: string) {
        this.startTime = Date.now();
        this.checkpoints = new Map();
        console.log(`⏱️ Starting ${operationName}`);
    }
    
    checkpoint(name: string) {
        const elapsed = Date.now() - this.startTime;
        this.checkpoints.set(name, elapsed);
        console.log(`📍 ${this.operationName} - ${name}: ${elapsed}ms`);
    }
    
    end() {
        const totalTime = Date.now() - this.startTime;
        console.log(`✅ ${this.operationName} completed in ${totalTime}ms`);
        
        // Log to Firebase Analytics if needed
        if (totalTime > 5000) {
            console.warn(`⚠️ Slow operation detected: ${this.operationName} took ${totalTime}ms`);
        }
        
        return {
            operation: this.operationName,
            totalTime,
            checkpoints: Object.fromEntries(this.checkpoints)
        };
    }
}

// Usage decorator
export function monitored(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args: any[]) {
        const monitor = new PerformanceMonitor(`${target.constructor.name}.${propertyKey}`);
        try {
            const result = await originalMethod.apply(this, args);
            monitor.end();
            return result;
        } catch (error) {
            monitor.end();
            throw error;
        }
    };
    
    return descriptor;
}