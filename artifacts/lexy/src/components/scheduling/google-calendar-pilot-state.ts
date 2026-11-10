export interface GooglePilotReceipt {
  status: "verified" | "not_connected" | "selection_required";
  checkedAt: string;
  calendarReadVerified: boolean;
  availabilityReadVerified: boolean;
  meetSupported: boolean | null;
  accountBinding: "not_configured";
  invitationsEnabled: false;
}

/** Reject inconsistent receipts; metadata capability is never invitation approval. */
export function googlePilotReceipt(value: unknown): GooglePilotReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = [
    "status",
    "checkedAt",
    "calendarReadVerified",
    "availabilityReadVerified",
    "meetSupported",
    "accountBinding",
    "invitationsEnabled",
  ];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) return null;
  if (
    !["verified", "not_connected", "selection_required"].includes(String(row.status)) ||
    typeof row.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(row.checkedAt)) ||
    row.accountBinding !== "not_configured" ||
    row.invitationsEnabled !== false ||
    typeof row.calendarReadVerified !== "boolean" ||
    typeof row.availabilityReadVerified !== "boolean" ||
    (row.meetSupported !== null && typeof row.meetSupported !== "boolean")
  )
    return null;
  if (row.status === "verified") {
    if (!row.calendarReadVerified || !row.availabilityReadVerified) return null;
  } else if (
    row.calendarReadVerified ||
    row.availabilityReadVerified ||
    row.meetSupported !== null
  ) {
    return null;
  }
  return row as unknown as GooglePilotReceipt;
}
