import type { InterviewCaptureDiagnosticInput } from "@workspace/api-client-react";

type EventInput = Omit<InterviewCaptureDiagnosticInput, "eventId">;

export function createCaptureDiagnosticAttempt(
  turnNumber: number,
): Omit<EventInput, "event"> | null {
  try {
    return {
      attemptId: crypto.randomUUID(),
      turnNumber: Math.max(1, Math.min(100, turnNumber)),
      reason: "no_text",
    };
  } catch {
    // Unsupported diagnostic APIs must never prevent microphone startup.
    return null;
  }
}

/** A bounded, best-effort queue: diagnostic failures never reject an answer. */
export class InterviewCaptureDiagnosticsReporter {
  private pending: Promise<void> = Promise.resolve();
  private seen = new Set<string>();
  private count = 0;

  constructor(
    private send: (event: InterviewCaptureDiagnosticInput) => Promise<unknown>,
    private onFailure: () => void,
  ) {}

  private fail() {
    try {
      this.onFailure();
    } catch {
      /* Diagnostics cannot break the interview. */
    }
  }

  record(input: EventInput) {
    try {
      const key = `${input.attemptId}:${input.event}`;
      if (this.seen.has(key) || this.count >= 500) return;
      this.seen.add(key);
      this.count += 1;
      const event = { ...input, eventId: crypto.randomUUID() };
      this.pending = this.pending
        .then(async () => {
          try {
            await this.send(event);
          } catch {
            try {
              // Retry with the SAME id; the server's primary key prevents duplicates.
              await this.send(event);
            } catch {
              this.fail();
            }
          }
        })
        .catch(() => {
          this.fail();
        });
    } catch {
      this.fail();
    }
  }

  async flush() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pending,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1500);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}
