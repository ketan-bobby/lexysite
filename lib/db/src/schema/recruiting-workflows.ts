import { pgTable, text, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export type WorkflowHumanDecision = {
  outcome: "hire" | "hold" | "decline";
  actorId: string;
  actorName: string;
  decidedAt: string;
  reason: string;
  testOnly: boolean;
  correctionReason?: string;
  supersedesDecidedAt?: string;
  offerEffect?: "none" | "approval_reset" | "sent_retained";
};

export type WorkflowStep = {
  key: string;
  label: string;
  authority: "human_review";
  status: "pending" | "completed" | "review_required" | "failed" | "cancelled";
  evidence: string | null;
  humanDecision?: WorkflowHumanDecision;
  humanDecisionHistory?: WorkflowHumanDecision[];
  controlledOffer?: ControlledOfferRecord;
  controlledOfferHistory?: ControlledOfferRecord[];
  offerRouting?: OfferRoutingConfiguration;
  offerRoutingHistory?: OfferRoutingConfiguration[];
  atsHandoff?: AtsHandoffRecord;
  atsHandoffHistory?: AtsHandoffRecord[];
  atsStageOwnership?: AtsStageOwnership;
  atsStageOwnershipHistory?: AtsStageOwnership[];
  /** Future native-offer actions opt in; never backfill historical hiring data. */
  offerNotificationsTracked?: boolean;
};

export type AtsStageOwnership = {
  status: "external" | "released";
  revision: number;
  mapping: AtsRecordMapping;
  bindingRevision: number;
  declaredBy: string;
  declaredAt: string;
  reason: string;
};

export type AtsRecordMapping = {
  system: string;
  accountRef: string;
  externalJobId: string;
  externalCandidateId: string;
  externalApplicationId: string;
  mappedBy: string;
  mappedAt: string;
};
export type AtsHandoffContent = {
  schemaVersion: 1;
  connectionState: "not_connected";
  offerOwner: "external_employer";
  workflowId: string;
  journeyVersion: number;
  briefHash: string;
  job: { id: string; title: string };
  candidate: { id: string; name: string };
  mapping: AtsRecordMapping;
  decision: WorkflowHumanDecision;
  steps: { key: string; label: string; status: string }[];
  assessments: {
    stepKey: string;
    sourceType: string;
    sourceId: string;
    occurredAt: string;
    summary: string;
    attentionRequired: boolean;
    scope: string;
  }[];
  cautions: string[];
};
export type AtsHandoffRecord = {
  mapping: AtsRecordMapping;
  packet?: {
    id: string;
    snapshotHash: string;
    content: AtsHandoffContent;
    preparedBy: string;
    preparedAt: string;
    approvedBy?: string;
    approvedAt?: string;
    exportedBy?: string;
    exportedAt?: string;
    handoffReceipt?: {
      recordedBy: string;
      recordedAt: string;
      evidenceReference: string;
      verification: "human_reported_only";
    };
  };
};

/** Per-application employer authority. Missing configuration grants no offer rights. */
export type OfferRoutingConfiguration = {
  mode: "native" | "external";
  ownerUserId: string | null;
  approverUserId: string | null;
  senderUserId: string | null;
  externalSystem: string | null;
  externalApplicationUrl: string | null;
  configuredBy: string;
  configuredAt: string;
};

export type ControlledOfferTerms = {
  employerName: string;
  roleTitle: string;
  amount: number;
  currency: string;
  frequency: "hourly" | "monthly" | "annual";
  location: string;
  startDate: string;
  expiresAt: string;
  letter: string;
};

/** Staff-owned metadata, not file bytes. Never serialize tokenHash to clients. */
export type ControlledOfferRecord = {
  id: string;
  version: number;
  status:
    | "draft"
    | "review_required"
    | "approved"
    | "sending"
    | "sent"
    | "accepted"
    | "declined"
    | "expired"
    | "withdrawn"
    | "send_uncertain";
  terms: ControlledOfferTerms;
  recipientEmail: string;
  testOnly: boolean;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  sentAt?: string;
  deliveryStartedAt?: string;
  deliveryReceiptId?: string;
  deliveryAttemptId?: string;
  providerDelivery?: {
    provider: "ses";
    messageId: string;
    deliveryAttemptId: string;
    status: "accepted" | "delivered" | "delayed" | "bounced" | "rejected" | "complained";
    occurredAt: string;
    receivedAt: string;
    events: {
      id: string;
      status: "accepted" | "delivered" | "delayed" | "bounced" | "rejected" | "complained";
      occurredAt: string;
    }[];
  };
  deliveryReconciliation?: {
    outcome: "provider_accepted" | "confirmed_not_sent" | "uncertain";
    checkedAt: string;
    checkedBy: string;
    reason: string;
    evidenceReference?: string;
  };
  respondedAt?: string;
  responseReason?: string;
  tokenHash?: string;
};

export const recruitingJourneysTable = pgTable(
  "recruiting_journeys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").$type<"draft" | "approved">().notNull().default("draft"),
    briefHash: text("brief_hash").notNull(),
    brief: jsonb("brief").$type<Record<string, unknown>>().notNull(),
    interviewPath: text("interview_path").notNull(),
    steps: jsonb("steps").$type<WorkflowStep[]>().notNull(),
    createdById: text("created_by_id").notNull(),
    approvedById: text("approved_by_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("recruiting_journey_job_version").on(t.jobId, t.version)],
);

export const recruitingWorkflowsTable = pgTable("recruiting_workflows", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  journeyId: text("journey_id").notNull(),
  journeyVersion: integer("journey_version").notNull(),
  interviewPath: text("interview_path").notNull(),
  status: text("status")
    .$type<"ready" | "paused" | "cancelled" | "completed">()
    .notNull()
    .default("ready"),
  revision: integer("revision").notNull().default(1),
  steps: jsonb("steps").$type<WorkflowStep[]>().notNull(),
  createdById: text("created_by_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recruitingWorkflowEventsTable = pgTable("recruiting_workflow_events", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id").notNull(),
  workflowId: text("workflow_id"),
  journeyId: text("journey_id"),
  action: text("action").notNull(),
  actorId: text("actor_id").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recruitingWorkflowReceiptsTable = pgTable(
  "recruiting_workflow_receipts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    resultId: text("result_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("recruiting_workflow_receipt_key").on(t.tenantId, t.jobId, t.key)],
);
