import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  jobsTable,
  candidatesTable as candidates,
  atsImportedApplicationsTable as imports,
  atsCandidateProfilesTable as profiles,
  recruitingWorkflowsTable as workflows,
} from "@workspace/db";
import type {
  AtsCandidateProfileInput,
  AtsCandidateProfileState,
  AtsCandidateProfileResult,
} from "@workspace/api-zod";
import { WorkflowConflict, fingerprint, type WorkflowScope } from "./recruiting-workflows";
import { currentAtsImportAuthority, lock } from "./ats-imports";
import { applyCandidateHardExclusions, applyCandidatePrivacyFilter } from "../routes/candidates";
import {
  openPreviewCursor,
  sealPreviewCursor,
  previewApplications,
  previewJob,
} from "./ats-connectors/preview";
import { candidateProfile, type CandidateProfile } from "./ats-connectors/profile";
import {
  boundedAtsRead,
  greenhouseGateway,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";

type Handle = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0] | typeof dbAdmin;
type Visible = Parameters<typeof currentAtsImportAuthority>[3];
const unavailable = () =>
  new WorkflowConflict("This profile requires an identity or privacy review before import.");

// Intake is not job enrollment: do not require an application just to read
// the newly imported profile. Preserve the canonical employer privacy seal.
async function profileAllowed(person: typeof candidates.$inferSelect, s: WorkflowScope) {
  return (
    (await applyCandidatePrivacyFilter(applyCandidateHardExclusions([person]), s.tenantId))
      .length === 1
  );
}

async function context(
  h: Handle,
  s: WorkflowScope,
  workflowId: string,
  recordId: string,
  visible: Visible,
) {
  const a = await currentAtsImportAuthority(h, s, workflowId, visible);
  const [actor] = await h.select().from(usersTable).where(eq(usersTable.id, s.actorId));
  const [w] = await h
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.tenantId, s.tenantId),
        eq(workflows.jobId, s.jobId),
      ),
    );
  const [r] = await h
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.id, recordId),
        eq(imports.tenantId, s.tenantId),
        eq(imports.jobId, s.jobId),
        eq(imports.accountRef, a.binding.accountRef),
        eq(imports.externalJobId, a.mapping.externalJobId),
      ),
    );
  if (!r || !w) throw new WorkflowConflict("Imported record not found.", 404);
  const snapshot = r.currentSnapshot ?? r.snapshot;
  const identity = {
    tenantId: s.tenantId,
    system: a.mapping.system.toLowerCase(),
    accountRef: a.binding.accountRef,
    externalCandidateId: snapshot.application.candidateId,
  };
  const erased = await h.execute(sql`SELECT EXISTS(
    SELECT 1 FROM candidate_erasure_tombstones
    WHERE subject_id='ats-profile:' || md5(jsonb_build_array(
      ${identity.tenantId}::text,${identity.system}::text,
      ${identity.accountRef}::text,${identity.externalCandidateId}::text)::text)
  ) AS blocked`);
  if (erased.rows[0]?.blocked !== false) throw unavailable();
  const [link] = await h
    .select()
    .from(profiles)
    .where(
      and(
        eq(profiles.tenantId, identity.tenantId),
        eq(profiles.system, identity.system),
        eq(profiles.accountRef, identity.accountRef),
        eq(profiles.externalCandidateId, identity.externalCandidateId),
      ),
    );
  if (link) {
    const [target] = await h
      .select()
      .from(candidates)
      .where(and(eq(candidates.id, link.candidateId), eq(candidates.tenantId, s.tenantId)));
    if (!target || !(await profileAllowed(target, s))) throw unavailable();
  }
  const [job] = await h
    .select({ status: jobsTable.status })
    .from(jobsTable)
    .where(and(eq(jobsTable.id, s.jobId), eq(jobsTable.tenantId, s.tenantId)));
  const canImport =
    actor?.status === "active" &&
    actor.role === "tenant_admin" &&
    actor.tenantId === s.tenantId &&
    s.canEdit !== false &&
    job?.status === "active" &&
    w.status !== "cancelled" &&
    // Initial metadata is "unchecked"; explicit preview performs fresh job,
    // application and person reads. A known failed refresh must be resolved.
    r.availability !== "unavailable";
  return { a, w, r, snapshot, identity, link, canImport };
}
type Context = Awaited<ReturnType<typeof context>>;
const state = (c: Context): AtsCandidateProfileState => ({
  workflowRevision: c.w.revision,
  bindingRevision: c.a.binding.revision,
  importRevision: c.r.refreshRevision,
  canImport: c.canImport,
  candidateId: c.link?.candidateId ?? null,
  importedAt: c.link?.importedAt ?? null,
});
function versions(c: Context, i: AtsCandidateProfileInput) {
  if (!c.canImport)
    throw new WorkflowConflict(
      "An active employer administrator must approve profile intake.",
      403,
    );
  if (i.acknowledge !== true)
    throw new WorkflowConflict("Explicit profile-read/import confirmation is required.", 400);
  if (
    c.w.revision !== i.expectedWorkflowRevision ||
    c.a.binding.revision !== i.expectedBindingRevision ||
    c.r.refreshRevision !== i.expectedImportRevision
  )
    throw new WorkflowConflict("The ATS context changed. Review a fresh profile preview.");
}
const tokenScope = (c: Context, s: WorkflowScope, workflowId: string, professional: boolean) =>
  fingerprint({
    actorId: s.actorId,
    ...c.identity,
    jobId: s.jobId,
    workflowId,
    recordId: c.r.id,
    workflowRevision: c.w.revision,
    bindingRevision: c.a.binding.revision,
    importRevision: c.r.refreshRevision,
    snapshot: c.snapshot,
    professional,
  });

/** Fence all incoming aliases as well as the chosen canonical email. */
async function matches(h: Handle, s: WorkflowScope, c: Context, p: CandidateProfile) {
  for (const email of p.emails) {
    const result = await h.execute(
      sql`SELECT public.lexy_erasure_job_blocked(${JSON.stringify({ email, candidateEmail: email })}::jsonb,NULL::text) AS blocked`,
    );
    if (result.rows[0]?.blocked !== false) throw unavailable();
  }
  const people = await h
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.tenantId, s.tenantId),
        inArray(sql<string>`lower(btrim(${candidates.email}))`, p.emails),
      ),
    );
  const mapped = await h
    .select({ id: workflows.candidateId })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, s.tenantId),
        sql`EXISTS(SELECT 1 FROM jsonb_array_elements(${workflows.steps}) step WHERE lower(step #>> '{atsHandoff,mapping,system}')=${c.identity.system} AND step #>> '{atsHandoff,mapping,accountRef}'=${c.identity.accountRef} AND step #>> '{atsHandoff,mapping,externalCandidateId}'=${c.identity.externalCandidateId})`,
      ),
    );
  const ids = [
    ...new Set([
      ...people.map((x) => x.id),
      ...mapped.map((x) => x.id),
      ...(c.link ? [c.link.candidateId] : []),
    ]),
  ];
  if (ids.length > 1) throw unavailable();
  if (!ids.length) return [];
  const [person] = await h
    .select()
    .from(candidates)
    .where(and(eq(candidates.id, ids[0]), eq(candidates.tenantId, s.tenantId)));
  if (
    !person ||
    person.pool !== "tenant" ||
    person.doNotContact ||
    person.dataErasedAt ||
    !(await profileAllowed(person, s))
  )
    throw unavailable();
  return p.emails.map((email) => ({
    email,
    candidateId: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
  }));
}

export async function readAtsCandidateProfile(
  s: WorkflowScope,
  workflowId: string,
  recordId: string,
  visible: Visible,
) {
  return state(await context(dbAdmin, s, workflowId, recordId, visible));
}
export async function controlAtsCandidateProfile(
  s: WorkflowScope,
  workflowId: string,
  recordId: string,
  i: AtsCandidateProfileInput,
  visible: Visible,
  gateway: GreenhouseGateway = greenhouseGateway(),
): Promise<AtsCandidateProfileResult> {
  const before = await context(dbAdmin, s, workflowId, recordId, visible);
  versions(before, i);
  const requestHash = fingerprint({ s, workflowId, recordId, i });
  if (i.action === "preview") {
    if (i.previewToken || i.email || i.existingCandidateId)
      throw new WorkflowConflict("Preview does not accept profile values.", 400);
    if (before.link) return { state: state(before), outcome: "already_imported" };
    let p: CandidateProfile;
    try {
      const connectionId = before.a.binding.connectionId;
      if (!(await boundedAtsRead(gateway.connections())).some((c) => c.id === connectionId))
        throw new Error("Connection unavailable");
      const [job, application, candidate] = await boundedAtsRead(
        Promise.all([
          gateway.read(connectionId, `/v3/jobs?ids=${before.r.externalJobId}`),
          gateway.read(connectionId, `/v3/applications?ids=${before.r.externalApplicationId}`),
          gateway.read(connectionId, `/v3/candidates?ids=${before.identity.externalCandidateId}`),
        ]),
      );
      previewJob(job, before.r.externalJobId);
      const apps = previewApplications(application, before.r.externalJobId);
      if (
        apps.length !== 1 ||
        apps[0].id !== before.r.externalApplicationId ||
        apps[0].candidateId !== before.identity.externalCandidateId
      )
        throw new Error("Identity changed");
      p = candidateProfile(candidate, before.identity.externalCandidateId, i.includeProfessional);
    } catch {
      throw new WorkflowConflict(
        "The selected public ATS profile is unavailable or cannot be imported. No profile was saved.",
        503,
      );
    }
    // Remote I/O cannot retain prior role, connection, mapping or privacy authority.
    const now = await context(dbAdmin, s, workflowId, recordId, visible);
    versions(now, i);
    if (
      tokenScope(before, s, workflowId, i.includeProfessional) !==
      tokenScope(now, s, workflowId, i.includeProfessional)
    )
      throw new WorkflowConflict("ATS identity changed. Review again.");
    const existing = await matches(dbAdmin, s, now, p);
    return {
      state: state(now),
      preview: {
        ...p,
        matches: existing,
        token: sealPreviewCursor(
          JSON.stringify(p),
          tokenScope(now, s, workflowId, i.includeProfessional),
        ),
        expiresAt: new Date(Date.now() + 600_000),
      },
    };
  }
  if (!i.previewToken || !i.email)
    throw new WorkflowConflict(
      "Review a profile preview and select its email before importing.",
      400,
    );
  const previewToken = i.previewToken;
  const email = i.email.trim().toLowerCase();
  return dbAdmin
    .transaction<AtsCandidateProfileResult>(async (tx) => {
      // Same employer lock as binding/import/mapping edits; serialize aliases across jobs.
      await lock(tx, s, workflowId);
      const c = await context(tx, s, workflowId, recordId, visible);
      versions(c, i);
      const [prior] = await tx
        .select()
        .from(profiles)
        .where(
          and(eq(profiles.tenantId, s.tenantId), eq(profiles.idempotencyKey, i.idempotencyKey)),
        );
      if (prior && prior.requestHash !== requestHash)
        throw new WorkflowConflict("Idempotency key belongs to another profile request.");
      if (c.link) return { state: state(c), outcome: "already_imported" };
      let p: CandidateProfile;
      try {
        p = JSON.parse(
          openPreviewCursor(previewToken, tokenScope(c, s, workflowId, i.includeProfessional)),
        ) as CandidateProfile;
      } catch {
        throw new WorkflowConflict(
          "The profile preview expired or its scope changed. Preview again.",
        );
      }
      if (!p.emails.includes(email))
        throw new WorkflowConflict("Select an email from the reviewed profile.", 400);
      const existing = await matches(tx, s, c, p);
      let candidateId: string;
      let outcome: "created" | "linked";
      if (existing.length) {
        if (i.existingCandidateId !== existing[0].candidateId)
          throw new WorkflowConflict(
            "An existing local profile must be explicitly linked; no profile was overwritten.",
          );
        candidateId = existing[0].candidateId;
        await tx
          .select({ id: candidates.id })
          .from(candidates)
          .where(and(eq(candidates.id, candidateId), eq(candidates.tenantId, s.tenantId)))
          .for("update");
        // Recheck privacy after obtaining the candidate lock (including concurrent erasure).
        await matches(tx, s, c, p);
        outcome = "linked";
      } else {
        if (i.existingCandidateId)
          throw new WorkflowConflict("The matching profile changed. Preview again.");
        candidateId = randomUUID();
        await tx.insert(candidates).values({
          id: candidateId,
          tenantId: s.tenantId,
          firstName: p.firstName,
          lastName: p.lastName,
          email,
          currentTitle: p.currentTitle,
          currentCompany: p.currentCompany,
          source: "ats:greenhouse",
          pool: "tenant",
          createdById: s.actorId,
          userId: null,
          isCurrentEmployee: false,
        });
        outcome = "created";
      }
      await tx.insert(profiles).values({
        id: randomUUID(),
        ...c.identity,
        candidateId,
        importedBy: s.actorId,
        fields:
          outcome === "linked"
            ? []
            : [
                "name",
                "email",
                ...(i.includeProfessional ? ["currentTitle", "currentCompany"] : []),
              ],
        idempotencyKey: i.idempotencyKey,
        requestHash,
      });
      const latest = await context(tx, s, workflowId, recordId, visible);
      return { state: state(latest), outcome };
    })
    .catch((e: unknown) => {
      if (e instanceof WorkflowConflict) throw e;
      const code =
        (e as { code?: string; cause?: { code?: string } })?.code ??
        (e as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505" || code === "23503" || code === "23514")
        throw new WorkflowConflict(
          "Identity or privacy changed during import. Review a fresh preview.",
        );
      throw e;
    });
}
