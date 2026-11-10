import { requireScheduleVersion } from "./schedule-edit";

export interface ScheduleSaveState {
  requestId: string;
  attemptedPayload: string | null;
}

function verifyReceipt(value: unknown, applicationId: unknown): void {
  if (!value || typeof value !== "object")
    throw new Error("The saved schedule receipt could not be verified. Your draft has been kept.");
  const row = value as Record<string, unknown>;
  requireScheduleVersion(row);
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.applicationId !== "string" ||
    !row.applicationId ||
    row.applicationId !== applicationId ||
    typeof row.type !== "string" ||
    !row.type ||
    typeof row.durationMinutes !== "number" ||
    !Number.isInteger(row.durationMinutes) ||
    row.durationMinutes < 5 ||
    row.durationMinutes > 480 ||
    typeof row.scheduledAt !== "string" ||
    !Number.isFinite(Date.parse(row.scheduledAt)) ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    typeof row.replayed !== "boolean" ||
    !["pending", "scheduled", "confirmed", "rescheduled", "cancelled", "completed"].includes(
      String(row.status),
    )
  )
    throw new Error("The saved schedule receipt could not be verified. Your draft has been kept.");
}

// One state object per deliberately opened draft; never silently mint a new key
// after an uncertain response. No draft notes or candidate data in browser storage.
export async function saveScheduleDraft<
  T extends { id: string; status: string; replayed?: boolean },
>(
  state: ScheduleSaveState,
  payload: Record<string, unknown>,
  ports: {
    find: (requestId: string) => Promise<T | null>;
    preflight: () => Promise<void>;
    create: (body: Record<string, unknown>) => Promise<T>;
  },
): Promise<T> {
  const serialized = JSON.stringify(payload);
  if (state.attemptedPayload !== null) {
    // Read before checking free/busy: the previous request might have saved.
    // A now-busy or past slot must not conceal the existing receipt.
    const saved = await ports.find(state.requestId);
    if (saved) {
      verifyReceipt(saved, payload.applicationId);
      if (state.attemptedPayload !== serialized)
        throw new Error(
          "The earlier save already exists. Your new edits were not applied. Refresh the schedule list before changing that interview.",
        );
      return { ...saved, replayed: true };
    }
  }
  await ports.preflight();
  state.attemptedPayload = serialized;
  const saved = await ports.create({ ...payload, requestId: state.requestId });
  verifyReceipt(saved, payload.applicationId);
  return saved;
}
