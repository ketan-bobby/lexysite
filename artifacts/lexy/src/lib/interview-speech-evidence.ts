/**
 * Level continuity is not speech recognition or a confidence score.
 * A brief spike alone must not authorize automatic scoring. The 200ms boundary
 * routes weak evidence to candidate review; it never rejects an answer.
 */
export class InterviewSpeechEvidence {
  private previous: number | null = null;
  private runStart: number | null = null;
  private longestRunMs = 0;
  private sampleCount = 0;
  private aboveThresholdSamples = 0;

  observe(aboveNoiseFloor: boolean, now: number): void {
    this.sampleCount += 1;
    if (aboveNoiseFloor) this.aboveThresholdSamples += 1;
    if (!aboveNoiseFloor || !Number.isFinite(now)) {
      this.previous = null;
      this.runStart = null;
      return;
    }
    if (this.previous === null || now < this.previous || now - this.previous > 100) {
      this.runStart = now;
    }
    this.previous = now;
    this.longestRunMs = Math.max(this.longestRunMs, now - (this.runStart ?? now));
  }

  get needsReview(): boolean {
    return this.longestRunMs < 200;
  }

  get diagnostic() {
    return {
      longestRunMs: Math.min(3600000, Math.max(0, Math.floor(this.longestRunMs))),
      thresholdMs: 200 as const,
      sampleCount: Math.min(1000000, this.sampleCount),
      aboveThresholdSamples: Math.min(1000000, this.aboveThresholdSamples),
    };
  }
}
