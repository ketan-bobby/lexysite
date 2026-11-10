/**
 * Synthetic identity clearance is a reporting exclusion, NOT a contact gate.
 * Never infer test status from names, domains, work-order age or model advice.
 */
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  candidatesTable,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
const fixtureCandidate = alias(candidatesTable, "synthetic_eligibility_candidate");

/** Canonical marker survives changing work orders and subsequent verification.
 * Existing scoped audit records also exclude earlier cleared fixtures.
 * CASE confines JSON parsing to the server-owned structured identity event.
 */
export function restrictToRealCandidates(candidateId: AnyColumn | SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${candidatesTable} AS "synthetic_eligibility_candidate"
    WHERE ${fixtureCandidate.id} = ${candidateId}
      AND (
        ${fixtureCandidate.verificationResult} #>> '{syntheticFixture,kind}' IN ('staff_inbox','controlled_inbox')
        OR EXISTS (
          SELECT 1 FROM ${workflows} INNER JOIN ${events}
            ON ${events.workflowId} = ${workflows.id}
            AND ${events.tenantId} = ${workflows.tenantId}
            AND ${events.jobId} = ${workflows.jobId}
          WHERE ${workflows.candidateId} = ${fixtureCandidate.id}
            AND CASE WHEN ${events.action} = 'workflow.identity_resolved'
              THEN (${events.note}::jsonb ->> 'decision') = 'internal_test'
                AND (${events.note}::jsonb ->> 'candidateId') = ${fixtureCandidate.id}
              ELSE false END
        )
      )
  )`;
}

/** An agent cannot create, remove or replace the server-owned fixture marker. */
export function preserveSyntheticFixture(result: unknown): SQL {
  return sql`(${JSON.stringify(result ?? {})}::jsonb - 'syntheticFixture')
    || CASE WHEN ${candidatesTable.verificationResult} #>> '{syntheticFixture,kind}' IN ('staff_inbox','controlled_inbox')
      THEN jsonb_build_object('syntheticFixture',
        ${candidatesTable.verificationResult} -> 'syntheticFixture')
      ELSE '{}'::jsonb END`;
}
