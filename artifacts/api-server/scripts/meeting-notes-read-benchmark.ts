import { performance } from "node:perf_hooks";

/** Local fixture diagnostic. Callbacks must pass the signal to their HTTP reads. */
export async function benchmarkScopedReads(options: {
  scenario: string;
  samples: number;
  concurrency: number;
  timeoutMs?: number;
  readAndVerify: (signal: AbortSignal) => Promise<void>;
}) {
  const { scenario, samples, concurrency, readAndVerify, timeoutMs = 5000 } = options;
  if (
    !/^[a-z][a-z0-9-]{0,60}$/.test(scenario) ||
    scenario.trim() !== scenario ||
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > 500 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Invalid bounded development benchmark options");
  }
  const latencies: number[] = [];
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  let next = 0;
  let failures = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, samples) }, async () => {
      while (next < samples && failures === 0) {
        next++;
        const before = performance.now();
        const signal = AbortSignal.timeout(timeoutMs);
        try {
          await readAndVerify(signal);
          signal.throwIfAborted();
          latencies.push(performance.now() - before);
        } catch {
          // Do not copy private response bodies, actor IDs or tokens into reports.
          failures++;
        } finally {
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }
      }
    }),
  );
  if (failures > 0) {
    throw new Error(`${scenario}: ${failures} read verification(s) failed; no success report`);
  }
  latencies.sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    Math.round(latencies[Math.ceil(fraction * latencies.length) - 1]! * 100) / 100;
  return {
    scope: "isolated-development-fixture" as const,
    scenario,
    samples: latencies.length,
    concurrency: Math.min(concurrency, samples),
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: percentile(1),
    sampledPeakRssBytes: peakRss,
    sampledRssIncreaseBytes: Math.max(0, peakRss - initialRss),
  };
}
