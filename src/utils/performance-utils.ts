import fs from 'fs';
import { expect } from 'chai';
import type { PerformanceRunMetrics } from '../blockchain/test-library/PerformanceTestBuilder';

export interface PerformanceExpectConfig {
    tokenTransfer: {
        runs?: number;
        threshold: number;
        percentage: number;
    };
}

export type PerformanceResultEntry = PerformanceRunMetrics | null;

function collectMetricValues(
    results: PerformanceResultEntry[],
    selector: (entry: PerformanceRunMetrics) => number
): number[] {
    return results.filter((entry): entry is PerformanceRunMetrics => entry !== null).map(selector);
}

function summarizeMetric(values: number[]): { avg: number; min: number; max: number } {
    if (values.length === 0) {
        return { avg: 0, min: 0, max: 0 };
    }

    return {
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
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
export function analyzePerformanceResults(results: PerformanceResultEntry[], performanceExpectations: any): any {
    // Get threshold for proper categorization
    const threshold = performanceExpectations?.tokenTransfer?.threshold ?? 10000;
    const expectedPercentage = performanceExpectations?.tokenTransfer?.percentage ?? 90;

    // Categorize runs based on threshold
    const successfulRuns = results.filter(
        (entry): entry is PerformanceRunMetrics => entry !== null && entry.endToEndLatencyMs <= threshold
    );
    const failedRuns = results.filter(entry => entry === null || entry.endToEndLatencyMs > threshold);

    const endToEndValues = collectMetricValues(results, entry => entry.endToEndLatencyMs);
    const submissionValues = collectMetricValues(results, entry => entry.submissionLatencyMs);
    const confirmationValues = collectMetricValues(results, entry => entry.confirmationLatencyMs);

    const endToEndStats = summarizeMetric(endToEndValues);
    const submissionStats = summarizeMetric(submissionValues);
    const confirmationStats = summarizeMetric(confirmationValues);

    // Calculate success rate
    const successRate = (successfulRuns.length / results.length) * 100;

    return {
        threshold,
        expectedPercentage,
        successfulRuns,
        failedRuns,
        avgTime: endToEndStats.avg,
        minTime: endToEndStats.min,
        maxTime: endToEndStats.max,
        metrics: {
            endToEnd: endToEndStats,
            submission: submissionStats,
            confirmation: confirmationStats,
        },
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
export function assertPerformanceResults(results: PerformanceResultEntry[], performanceExpectations: any): any {
    const analysis = analyzePerformanceResults(results, performanceExpectations);

    console.log(`\n📊 Performance Test Results (${analysis.totalRuns} runs):`);
    console.log(
        `   ✅ Successful runs (≤${analysis.threshold}ms): ${analysis.successfulRuns.length}/${analysis.totalRuns}`
    );
    console.log(
        `   ❌ Failed runs (>${analysis.threshold}ms or error): ${analysis.failedRuns.length}/${analysis.totalRuns}`
    );
    console.log(`   📈 End-to-end average: ${analysis.metrics.endToEnd.avg.toFixed(2)}ms`);
    console.log(`   🏃 End-to-end min: ${analysis.metrics.endToEnd.min}ms`);
    console.log(`   🐌 End-to-end max: ${analysis.metrics.endToEnd.max}ms`);
    console.log(
        `   📤 Submission latency: avg=${analysis.metrics.submission.avg.toFixed(2)}ms, ` +
            `min=${analysis.metrics.submission.min}ms, max=${analysis.metrics.submission.max}ms`
    );
    console.log(
        `   ⛓️ Confirmation latency: avg=${analysis.metrics.confirmation.avg.toFixed(2)}ms, ` +
            `min=${analysis.metrics.confirmation.min}ms, max=${analysis.metrics.confirmation.max}ms`
    );
    console.log(
        `   📋 End-to-end times: [` +
            `${results.map(entry => (entry === null ? 'FAILED' : entry.endToEndLatencyMs)).join(', ')}]`
    );
    console.log(
        `   📋 Submission times: [` +
            `${results.map(entry => (entry === null ? 'FAILED' : entry.submissionLatencyMs)).join(', ')}]`
    );
    console.log(
        `   📋 Confirmation times: [` +
            `${results.map(entry => (entry === null ? 'FAILED' : entry.confirmationLatencyMs)).join(', ')}]`
    );

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
    results: PerformanceResultEntry[],
    analysis: any,
    outputPath: string = 'tests/performanceResult.json'
): any {
    const detailedResult = {
        summary: {
            totalRuns: analysis.totalRuns,
            successfulRuns: analysis.successfulRuns.length,
            failedRuns: analysis.failedRuns.length,
            endToEnd: analysis.metrics.endToEnd,
            submission: analysis.metrics.submission,
            confirmation: analysis.metrics.confirmation,
            threshold: analysis.threshold,
        },
        individualRuns: results.map((entry, index) => ({
            run: index + 1,
            endToEndLatencyMs: entry === null ? 'FAILED' : entry.endToEndLatencyMs,
            submissionLatencyMs: entry === null ? 'FAILED' : entry.submissionLatencyMs,
            confirmationLatencyMs: entry === null ? 'FAILED' : entry.confirmationLatencyMs,
            transactionHash: entry === null ? undefined : entry.transactionHash,
            blockNumber: entry === null ? undefined : entry.blockNumber,
            status: entry === null ? 'FAILED' : entry.endToEndLatencyMs <= analysis.threshold ? 'SUCCESS' : 'TIMEOUT',
        })),
    };

    console.log(`Detailed performance result: ${JSON.stringify(detailedResult, null, 2)}`);
    fs.writeFileSync(outputPath, JSON.stringify(detailedResult, null, 2));
    console.log(`Detailed performance result written to ${outputPath}`);

    return detailedResult;
}
