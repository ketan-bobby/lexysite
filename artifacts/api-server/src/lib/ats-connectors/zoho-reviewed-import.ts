import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  jobsTable,
  candidatesTable,
  atsCandidateProfilesTable,
  zohoRecruitAccountsTable,
  zohoImportedJobsTable,
} from "@workspace/db";
import { decryptSecret } from "../crypto-secrets";
import { CalendarError } from "../outlook-calendar-core";
import { applyCandidateHardExclusions, applyCandidatePrivacyFilter } from "../../routes/candidates";
import { fingerprint } from "../recruiting-workflows";
import { openPreviewCursor, sealPreviewCursor } from "./preview";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import { zohoOAuthConfig, zohoOAuthProvider, zohoFailure } from "./zoho-oauth-provider";
import { campaignJobIsOpen, campaignApplicationIsEligible } from "./zoho-campaign-policy";
import { zohoOAuthStore, type ZohoActor } from "./zoho-oauth-store";
import {
  zohoIntakeFailure,
  zohoIntakeRecord,
  zohoJobApplicants,
  type ZohoJobApplicantSelection,
  type ZohoImportKind,
  type ZohoImportSelection,
  type ZohoImportConfirmation,
  type ZohoIntakeFields,
} from "./zoho-intake-record";
import { z } from "zod/v4";
import {
  applicationBinding,
  stageCatalogPage,
  type StageStatus,
} from "./zoho-stage-metadata-policy";

type Row = NonNullable<Awaited<ReturnType<ReturnType<typeof zohoOAuthStore>["get"]>>>;
const same = (a: Row | undefined, b: Row, revision: string, fingerprint: string) =>
  !!a &&
  a.tenantId === b.tenantId &&
  a.userId === b.userId &&
  a.revision === revision &&
  a.fingerprint === fingerprint &&
  a.refreshTokenEnc === b.refreshTokenEnc &&
  a.accountRef === b.accountRef &&
  a.approvedAt?.getTime() === b.approvedAt?.getTime() &&
  !!a.approvedAt;

function scope(actor: ZohoActor, row: Row, kind: ZohoImportKind, recordId: string) {
  return fingerprint({
    action: "zoho-reviewed-import",
    actorId: actor.id,
    tenantId: actor.tenantId,
    ownerId: row.userId,
    revision: row.revision,
    fingerprint: row.fingerprint,
    accountRef: row.accountRef,
    kind,
    recordId,
  });
}
type Handle = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];

async function visibleCandidate(person: typeof candidatesTable.$inferSelect, tenantId: string) {
  return (
    (await applyCandidatePrivacyFilter(applyCandidateHardExclusions([person]), tenantId)).length ===
    1
  );
}
async function localState(
  tx: Handle | typeof dbAdmin,
  actor: ZohoActor,
  row: Row,
  kind: ZohoImportKind,
  id: string,
  fields: ZohoIntakeFields,
  lock = false,
) {
  if (kind === "job") {
    const [mapped] = await tx
      .select()
      .from(zohoImportedJobsTable)
      .where(
        and(
          eq(zohoImportedJobsTable.tenantId, actor.tenantId),
          eq(zohoImportedJobsTable.accountRef, row.accountRef!),
          eq(zohoImportedJobsTable.externalJobId, id),
        ),
      );
    if (!mapped) return { disposition: "create" as const, existingId: null };
    const [job] = await tx
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.tenantId, actor.tenantId), eq(jobsTable.id, mapped.jobId)));
    if (!job) throw zohoIntakeFailure();
    return { disposition: "already_imported" as const, existingId: job.id };
  }
  const identity = {
    tenantId: actor.tenantId,
    system: "zoho_recruit",
    accountRef: row.accountRef!,
    externalCandidateId: id,
  };
  const [erasure] = (
    await tx.execute(sql`SELECT EXISTS(
    SELECT 1 FROM candidate_erasure_tombstones
    WHERE subject_id='ats-profile:' || md5(jsonb_build_array(
      ${identity.tenantId}::text,${identity.system}::text,
      ${identity.accountRef}::text,${identity.externalCandidateId}::text)::text)
  ) AS blocked`)
  ).rows;
  if (erasure?.blocked !== false) throw zohoIntakeFailure();
  const email = fields.email!;
  const [blocked] = (
    await tx.execute(sql`SELECT public.lexy_erasure_job_blocked(
    ${JSON.stringify({ email, candidateEmail: email })}::jsonb,NULL::text) AS blocked`)
  ).rows;
  if (blocked?.blocked !== false) throw zohoIntakeFailure();
  const [mapped] = await tx
    .select()
    .from(atsCandidateProfilesTable)
    .where(
      and(
        eq(atsCandidateProfilesTable.tenantId, actor.tenantId),
        eq(atsCandidateProfilesTable.system, "zoho_recruit"),
        eq(atsCandidateProfilesTable.accountRef, row.accountRef!),
        eq(atsCandidateProfilesTable.externalCandidateId, id),
      ),
    );
  const matches = await tx
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.tenantId, actor.tenantId),
        eq(sql<string>`lower(btrim(${candidatesTable.email}))`, email),
      ),
    );
  const ids = new Set([...matches.map((p) => p.id), ...(mapped ? [mapped.candidateId] : [])]);
  if (ids.size > 1) throw zohoIntakeFailure();
  if (!ids.size) return { disposition: "create" as const, existingId: null };
  const candidateId = [...ids][0];
  const [person] = await tx
    .select()
    .from(candidatesTable)
    .where(and(eq(candidatesTable.tenantId, actor.tenantId), eq(candidatesTable.id, candidateId)));
  if (
    !person ||
    person.pool !== "tenant" ||
    person.doNotContact ||
    person.dataErasedAt ||
    !(await visibleCandidate(person, actor.tenantId))
  )
    throw zohoIntakeFailure();
  if (lock) {
    const [locked] = await tx
      .select()
      .from(candidatesTable)
      .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, actor.tenantId)))
      .for("update");
    // Recheck after waiting on any concurrent erasure/profile mutation.
    if (
      !locked ||
      locked.pool !== "tenant" ||
      locked.doNotContact ||
      locked.dataErasedAt ||
      !(await visibleCandidate(locked, actor.tenantId))
    )
      throw zohoIntakeFailure();
  }
  return {
    disposition: mapped ? ("already_imported" as const) : ("link" as const),
    existingId: candidateId,
  };
}

/** Employer-admin, exact-ID intake. Remote data is never treated as authority to enroll or send. */
export function zohoReviewedImport({
  store = zohoOAuthStore(),
  config = zohoOAuthConfig(),
  actorLookup = zohoEmployerAdmin,
  providerFactory = zohoOAuthProvider,
  unseal = decryptSecret,
} = {}) {
  async function initial(actor: ZohoActor, revision: string) {
    if (!config) throw zohoFailure("zoho_setup_required");
    const row = await store.get(actor);
    if (
      !row?.approvedAt ||
      !row.refreshTokenEnc ||
      !row.accountRef ||
      row.revision !== revision ||
      row.fingerprint !== config.fingerprint ||
      row.tenantId !== actor.tenantId
    )
      throw zohoIntakeFailure("Confirm the current Zoho employer account before importing.");
    return row;
  }
  async function guard(actor: ZohoActor, row: Row, revision: string) {
    if (!config) throw zohoFailure("zoho_setup_required");
    const requester = await actorLookup(actor.id);
    const owner = await actorLookup(row.userId);
    const current = await store.get(actor);
    if (
      requester.id !== actor.id ||
      requester.tenantId !== actor.tenantId ||
      owner.id !== row.userId ||
      owner.tenantId !== actor.tenantId ||
      !same(current, row, revision, config.fingerprint)
    )
      throw zohoIntakeFailure("Zoho account or administrator authority changed. Review again.");
  }
  async function authorizedProvider(actor: ZohoActor, row: Row, revision: string) {
    if (!config) throw zohoFailure("zoho_setup_required");
    await guard(actor, row, revision);
    let token: string;
    try {
      token = z
        .object({
          purpose: z.literal("zoho-recruit"),
          tenantId: z.literal(actor.tenantId),
          userId: z.literal(row.userId),
          accountRef: z.literal(row.accountRef),
          fingerprint: z.literal(config.fingerprint),
          token: z.string().min(1).max(16384),
        })
        .parse(JSON.parse(unseal(row.refreshTokenEnc!))).token;
    } catch {
      throw zohoIntakeFailure(
        "Stored Zoho authorization is unavailable. Reconnect and review again.",
      );
    }
    const provider = providerFactory(config);
    const accessToken = await provider.refresh(token);
    await guard(actor, row, revision);
    const org = await provider.organization(accessToken);
    await guard(actor, row, revision);
    if (org.accountRef !== row.accountRef)
      throw zohoIntakeFailure("Zoho employer account changed. Reconnect and review.");
    return { provider, accessToken };
  }
  async function read(actor: ZohoActor, row: Row, input: ZohoImportSelection) {
    const { provider, accessToken } = await authorizedProvider(actor, row, input.revision);
    const body = await provider.readIntakeRecord(accessToken, input.kind, input.recordId);
    await guard(actor, row, input.revision);
    return zohoIntakeRecord(input.kind, input.recordId, body);
  }
  return {
    /** Internal read-only metadata capability; never returns tokens or raw remote records. */
    async stageMetadata(
      actor: ZohoActor,
      revision: string,
      jobId: string,
      applicationId: string,
      candidateId: string,
    ) {
      const row = await initial(actor, revision);
      const { provider, accessToken } = await authorizedProvider(actor, row, revision);
      const current = () => guard(actor, row, revision);
      await current();
      const jobPayload = await provider.readIntakeRecord(accessToken, "job", jobId);
      await current();
      zohoIntakeRecord("job", jobId, jobPayload);
      if (!campaignJobIsOpen(jobPayload))
        throw zohoIntakeFailure("Zoho job is no longer open. Review its current state.");
      const binding = applicationBinding(
        await provider.readApplication(accessToken, applicationId),
        jobId,
        applicationId,
        candidateId,
      );
      await current();
      const statuses: StageStatus[] = [];
      const seenStages = new Set<string>(),
        seenStatuses = new Set<string>();
      for (let page = 1; page <= 10; page++) {
        await current();
        const raw = await provider.readStageCatalog(accessToken, page);
        await current();
        const result = stageCatalogPage(raw, page);
        for (const id of result.stages) {
          if (seenStages.has(id))
            throw zohoIntakeFailure("Zoho repeated stage metadata. Review again.");
          seenStages.add(id);
        }
        for (const status of result.statuses) {
          if (seenStatuses.has(status.id))
            throw zohoIntakeFailure("Zoho repeated status metadata. Review again.");
          seenStatuses.add(status.id);
          statuses.push(status);
        }
        if (!result.moreRecords)
          return { accountRef: row.accountRef!, binding, statuses, assertCurrent: current };
      }
      throw zohoIntakeFailure(
        "Zoho stage metadata exceeds the bounded read limit. No partial validation was accepted.",
      );
    },
    /** Internal-only capability. Never serialize custody or provider access to a route. */
    async campaignSource(actor: ZohoActor, revision: string) {
      const row = await initial(actor, revision);
      const { provider, accessToken } = await authorizedProvider(actor, row, revision);
      const current = () => guard(actor, row, revision);
      return {
        accountRef: row.accountRef!,
        assertCurrent: current,
        async lockCurrent(tx: Handle) {
          const [locked] = await tx
            .select()
            .from(zohoRecruitAccountsTable)
            .where(eq(zohoRecruitAccountsTable.tenantId, actor.tenantId))
            .for("update");
          if (!config || !same(locked, row, revision, config.fingerprint))
            throw zohoIntakeFailure();
          for (const id of new Set([actor.id, row.userId])) {
            const [user] = await tx
              .select()
              .from(usersTable)
              .where(eq(usersTable.id, id))
              .for("share");
            if (
              !user ||
              user.status !== "active" ||
              user.role !== "tenant_admin" ||
              user.tenantId !== actor.tenantId
            )
              throw zohoIntakeFailure();
          }
        },
        async snapshot(jobId: string) {
          await current();
          const jobPayload = await provider.readIntakeRecord(accessToken, "job", jobId);
          if (!campaignJobIsOpen(jobPayload))
            throw zohoIntakeFailure("Zoho job is not in a recognized open state.");
          const job = zohoIntakeRecord("job", jobId, jobPayload);
          await current();
          const applications: { applicationId: string; candidateId: string }[] = [];
          for (let page = 1; page <= 100; page++) {
            const result = zohoJobApplicants(
              jobId,
              page,
              await provider.searchJobApplications(accessToken, jobId, page),
            );
            await current();
            applications.push(...result.applications);
            if (new Set(applications.map((a) => a.applicationId)).size !== applications.length)
              throw zohoIntakeFailure(
                "Zoho returned repeated applications across pages. Review the job again.",
              );
            if (!result.moreRecords) return { job, applications };
          }
          throw zohoIntakeFailure(
            "The applicant snapshot exceeds 2,500 records and is incomplete. No campaign was created.",
          );
        },
        async candidate(jobId: string, applicationId: string, candidateId: string) {
          await current();
          const jobPayload = await provider.readIntakeRecord(accessToken, "job", jobId);
          if (!campaignJobIsOpen(jobPayload))
            throw zohoIntakeFailure("Zoho job is not in a recognized open state.");
          zohoIntakeRecord("job", jobId, jobPayload);
          await current();
          const payload = z
            .object({ data: z.array(z.unknown()).length(1) })
            .parse(await provider.readApplication(accessToken, applicationId));
          // Customized or unknown states need employer review, not guessed eligibility.
          if (!campaignApplicationIsEligible(payload.data[0]))
            throw zohoIntakeFailure("Application status requires employer review.");
          const verified = zohoJobApplicants(jobId, 1, {
            data: payload.data,
            info: { more_records: false },
          });
          if (
            verified.applications[0]?.applicationId !== applicationId ||
            verified.applications[0]?.candidateId !== candidateId
          )
            throw zohoIntakeFailure();
          await current();
          const fields = zohoIntakeRecord(
            "candidate",
            candidateId,
            await provider.readIntakeRecord(accessToken, "candidate", candidateId),
          );
          await current();
          return fields;
        },
      };
    },
    async applicants(actor: ZohoActor, input: ZohoJobApplicantSelection) {
      const row = await initial(actor, input.revision);
      const { provider, accessToken } = await authorizedProvider(actor, row, input.revision);
      const job = zohoIntakeRecord(
        "job",
        input.jobId,
        await provider.readIntakeRecord(accessToken, "job", input.jobId),
      );
      await guard(actor, row, input.revision);
      const page = zohoJobApplicants(
        input.jobId,
        input.page,
        await provider.searchJobApplications(accessToken, input.jobId, input.page),
      );
      await guard(actor, row, input.revision);
      return { ...page, jobTitle: job.title! };
    },
    async preview(actor: ZohoActor, input: ZohoImportSelection) {
      const row = await initial(actor, input.revision);
      const fields = await read(actor, row, input);
      const current = await localState(dbAdmin, actor, row, input.kind, input.recordId, fields);
      await guard(actor, row, input.revision);
      const token = sealPreviewCursor(
        JSON.stringify({
          hash: fingerprint(fields),
          disposition: current.disposition,
          existingId: current.existingId,
        }),
        scope(actor, row, input.kind, input.recordId),
      );
      return {
        ...input,
        fields,
        disposition: current.disposition,
        existingId: current.existingId,
        previewToken: token,
        expiresAt: new Date(Date.now() + 600_000),
      };
    },
    async confirm(actor: ZohoActor, input: ZohoImportConfirmation) {
      const row = await initial(actor, input.revision);
      let proof: { hash: string; disposition: string; existingId: string | null };
      try {
        proof = z
          .object({
            hash: z.string(),
            disposition: z.enum(["create", "link", "already_imported"]),
            existingId: z.string().nullable(),
          })
          .parse(
            JSON.parse(
              openPreviewCursor(input.previewToken, scope(actor, row, input.kind, input.recordId)),
            ),
          );
      } catch {
        throw zohoIntakeFailure("Preview expired. Review the Zoho record again.");
      }
      if (input.existingId !== proof.existingId)
        throw zohoIntakeFailure("The selected local identity changed. Review again.");
      const fields = await read(actor, row, input);
      if (fingerprint(fields) !== proof.hash)
        throw zohoIntakeFailure("Zoho record changed since preview. Review again.");
      await guard(actor, row, input.revision);
      return dbAdmin
        .transaction(async (tx) => {
          // Serialize account replacement/disconnect and concurrent imports with this row lock.
          const [current] = await tx
            .select()
            .from(zohoRecruitAccountsTable)
            .where(eq(zohoRecruitAccountsTable.tenantId, actor.tenantId))
            .for("update");
          if (!config || !same(current, row, input.revision, config.fingerprint))
            throw zohoIntakeFailure("Zoho authorization changed. Review again.");
          for (const id of new Set([actor.id, row.userId])) {
            const [user] = await tx
              .select()
              .from(usersTable)
              .where(eq(usersTable.id, id))
              .for("share");
            if (
              !user ||
              user.status !== "active" ||
              user.role !== "tenant_admin" ||
              user.tenantId !== actor.tenantId
            )
              throw zohoIntakeFailure("Employer administrator authority changed.");
          }
          // Tenant-wide lock shared with employer ATS mapping and candidate intake.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-employer:${actor.tenantId}`},0))`,
          );
          const state = await localState(tx, actor, row, input.kind, input.recordId, fields, true);
          if (state.disposition !== proof.disposition || state.existingId !== proof.existingId)
            throw zohoIntakeFailure("The local record changed since preview. Review again.");
          if (state.disposition === "already_imported")
            return {
              kind: input.kind,
              localId: state.existingId!,
              outcome: "already_imported" as const,
            };
          if (input.kind === "job") {
            const id = randomUUID();
            await tx.insert(jobsTable).values({
              id,
              tenantId: actor.tenantId,
              createdById: actor.id,
              title: fields.title!,
              description: fields.description!,
              location: fields.location,
              status: "draft",
              recruitingMode: "human_assisted",
            });
            await tx.insert(zohoImportedJobsTable).values({
              id: randomUUID(),
              tenantId: actor.tenantId,
              accountRef: row.accountRef!,
              externalJobId: input.recordId,
              jobId: id,
              importedBy: actor.id,
            });
            return { kind: input.kind, localId: id, outcome: "created" as const };
          }
          let id = state.existingId;
          if (!id) {
            id = randomUUID();
            await tx.insert(candidatesTable).values({
              id,
              tenantId: actor.tenantId,
              firstName: fields.firstName!,
              lastName: fields.lastName!,
              email: fields.email!,
              source: "ats:zoho_recruit",
              pool: "tenant",
              createdById: actor.id,
              userId: null,
            });
          }
          await tx.insert(atsCandidateProfilesTable).values({
            id: randomUUID(),
            tenantId: actor.tenantId,
            system: "zoho_recruit",
            accountRef: row.accountRef!,
            externalCandidateId: input.recordId,
            candidateId: id,
            importedBy: actor.id,
            fields: state.existingId ? [] : ["name", "email"],
            idempotencyKey: `zoho:${row.accountRef}:${input.recordId}`,
            requestHash: fingerprint({
              accountRef: row.accountRef,
              recordId: input.recordId,
              candidateId: id,
            }),
          });
          return {
            kind: input.kind,
            localId: id,
            outcome: state.existingId ? ("linked" as const) : ("created" as const),
          };
        })
        .catch((error: unknown) => {
          if (error instanceof CalendarError) throw error;
          // Unique/FK races never turn into a second profile; require fresh review.
          if (["23505", "23503", "23514"].includes((error as { code?: string })?.code ?? ""))
            throw zohoIntakeFailure("Identity changed during import. Review again.");
          throw error;
        });
    },
  };
}
