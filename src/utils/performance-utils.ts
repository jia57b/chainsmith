import fs from 'fs';
import { expect } from 'chai';

export interface PerformanceExpectConfig {
    tokenTransfer: {
        runs?: number;
        threshold: number;
        percentage: number;
    };
}

/**
 * Get configured performance run count.
 *
 * Falls back to 10 for backward compatibility when older config files
 * do not yet define tokenTransfer.runs.
 */
export function getPerformanceRunCount(performanceExpectations: PerformanceExpectConfig): number {
    return performanceExpectations?.tokenTransfer?.runs ?? 10;
}

/**
 * Log performance expectation configuration
 *
 * @param expectData - Performance expectation configuration object
 */
export function logPerformanceExpect(expectData: PerformanceExpectConfig): void {
    console.log(`📋 Loaded performance expectations`);
    console.log(`   Threshold: ${expectData.tokenTransfer.threshold}ms`);
    console.log(`   Expected success rate: ${expectData.tokenTransfer.percentage}%`);
}

/**
 * Analyze performance results and return analysis data
 *
 * @param results - Array of time measurements from multiple runs
 * @param performanceExpectations - Performance expectations configuration
 * @returns Analysis data including statistics and success rate
 */
export function analyzePerformanceResults(results: number[], performanceExpectations: any): any {
    // Get threshold for proper categorization
    const threshold = performanceExpectations?.tokenTransfer?.threshold ?? 10000;
    const expectedPercentage = performanceExpectations?.tokenTransfer?.percentage ?? 90;

    // Categorize runs based on threshold
    const successfulRuns = results.filter(r => r > 0 && r <= threshold);
    const failedRuns = results.filter(r => r === -1 || r > threshold);

    // Calculate statistics from all valid results (excluding -1 for failed runs)
    const validResults = results.filter(r => r > 0);
    const avgTime = validResults.length > 0 ? validResults.reduce((a, b) => a + b, 0) / validResults.length : 0;
    const minTime = validResults.length > 0 ? Math.min(...validResults) : 0;
    const maxTime = validResults.length > 0 ? Math.max(...validResults) : 0;

    // Calculate success rate
    const successRate = (successfulRuns.length / results.length) * 100;

    return {
        threshold,
        expectedPercentage,
        successfulRuns,
        failedRuns,
        avgTime,
        minTime,
        maxTime,
        successRate,
        totalRuns: results.length,
    };
}

/**
 * Assert performance results from multiple runs
 *
 * @param results - Array of time measurements from multiple runs
 * @param performanceExpectations - Performance expectations configuration
 * @returns Analysis data for further use
 */
export function assertPerformanceResults(results: number[], performanceExpectations: any): any {
    const analysis = analyzePerformanceResults(results, performanceExpectations);

    console.log(`\n📊 Performance Test Results (${analysis.totalRuns} runs):`);
    console.log(
        `   ✅ Successful runs (≤${analysis.threshold}ms): ${analysis.successfulRuns.length}/${analysis.totalRuns}`
    );
    console.log(
        `   ❌ Failed runs (>${analysis.threshold}ms or error): ${analysis.failedRuns.length}/${analysis.totalRuns}`
    );
    console.log(`   📈 Average time: ${analysis.avgTime.toFixed(2)}ms`);
    console.log(`   🏃 Min time: ${analysis.minTime}ms`);
    console.log(`   🐌 Max time: ${analysis.maxTime}ms`);
    console.log(`   📋 All times: [${results.map(r => (r === -1 ? 'FAILED' : r)).join(', ')}]`);

    console.log(`\n📈 Success Rate Analysis:`);
    console.log(`   Target: ${analysis.expectedPercentage}% of runs should complete within ${analysis.threshold}ms`);
    console.log(
        `   Actual: ${analysis.successRate.toFixed(1)}% (${analysis.successfulRuns.length}/${analysis.totalRuns} runs)`
    );

    // Assert that at least the configured percentage of runs completed within threshold
    expect(analysis.successRate).to.be.greaterThanOrEqual(
        analysis.expectedPercentage,
        `Success rate ${analysis.successRate.toFixed(1)}% is below configured threshold ${analysis.expectedPercentage}%`
    );

    return analysis;
}

/**
 * Record performance results to file using analysis data
 *
 * @param results - Array of time measurements from multiple runs
 * @param analysis - Analysis data from assertPerformanceResults
 * @param outputPath - Path to write the performance results
 * @returns The detailed performance result object
 */
export function recordPerformanceResults(
    results: number[],
    analysis: any,
    outputPath: string = 'tests/performanceResult.json'
): any {
    const detailedResult = {
        summary: {
            totalRuns: analysis.totalRuns,
            successfulRuns: analysis.successfulRuns.length,
            failedRuns: analysis.failedRuns.length,
            averageTime: analysis.avgTime,
            minTime: analysis.minTime,
            maxTime: analysis.maxTime,
            threshold: analysis.threshold,
        },
        individualRuns: results.map((time, index) => ({
            run: index + 1,
            time: time === -1 ? 'FAILED' : time,
            status: time === -1 ? 'FAILED' : time <= analysis.threshold ? 'SUCCESS' : 'TIMEOUT',
        })),
    };

    console.log(`Detailed performance result: ${JSON.stringify(detailedResult, null, 2)}`);
    fs.writeFileSync(outputPath, JSON.stringify(detailedResult, null, 2));
    console.log(`Detailed performance result written to ${outputPath}`);

    return detailedResult;
}
