/** Isolated UI fixture. No interviews, model calls, provider calls or email sends. */
import { createHash, randomUUID } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { hasControlledOffer } from "../src/lib/controlled-offers";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
} from "@workspace/db";
import { issueToken } from "../src/lib/auth-token";
import { journeySteps, readBrief } from "../src/lib/recruiting-workflows";

async function main() {
  if (
    process.argv.includes("--stage-recovery") ||
    process.argv.includes("--verify-recovery") ||
    process.argv.includes("--stage-delivery")
  ) {
    const f = JSON.parse(await readFile("/tmp/offer-routing-browser.json", "utf8"));
    assert.ok(String(f.jobId).startsWith("offer_ui_"));
    const [row] = await dbAdmin
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, f.nativeWorkflowId),
          eq(workflows.tenantId, f.employer),
          eq(workflows.jobId, f.jobId),
        ),
      );
    assert.ok(row?.steps.at(-1)?.humanDecision?.testOnly);
    const api = async (
      tail: string,
      actor: keyof typeof f.actors,
      data?: Record<string, unknown>,
    ) => {
      const r = await fetch(
        `https://${process.env.REPLIT_DEV_DOMAIN}/api/jobs/${f.jobId}/candidate-workflows/${f.nativeWorkflowId}/${tail}`,
        {
          method: data ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${f.actors[actor].sessionToken}`,
          },
          ...(data ? { body: JSON.stringify(data) } : {}),
        },
      );
      assert.equal(r.status, 200, `Synthetic ${tail} request failed (${r.status}).`);
      return r.json();
    };
    if (process.argv.includes("--stage-recovery") || process.argv.includes("--stage-delivery")) {
      assert.equal(row.steps.at(-1)?.controlledOffer, undefined);
      for (const [action, actor] of [
        ["save_draft", "owner"],
        ["submit_review", "owner"],
        ["approve", "approver"],
      ] as const) {
        const st = await api("offer", actor);
        await api("offer", actor, {
          action,
          expectedRevision: st.workflowRevision,
          idempotencyKey: randomUUID(),
          reason:
            "TEST ONLY exact-version preparation for unavailable-staff recovery; no candidate delivery.",
          ...(action === "save_draft"
            ? {
                terms: {
                  employerName: "Fictional Recovery Employer",
                  roleTitle: "TEST ONLY Role",
                  amount: 1,
                  currency: "USD",
                  frequency: "annual",
                  location: "Remote synthetic test",
                  startDate: "2030-01-01",
                  expiresAt: "2030-02-01T00:00:00.000Z",
                  letter:
                    "TEST ONLY. This is fictional, not an employment offer, and must not be sent.",
                },
              }
            : {}),
        });
      }
      if (process.argv.includes("--stage-delivery")) {
        const [current] = await dbAdmin
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.id, row.id),
              eq(workflows.tenantId, f.employer),
              eq(workflows.jobId, f.jobId),
            ),
          );
        assert.equal(current.steps.at(-1)?.controlledOffer?.status, "approved");
        assert.equal(current.steps.at(-1)?.controlledOffer?.testOnly, true);
        await dbAdmin
          .update(workflows)
          .set({
            revision: current.revision + 1,
            steps: current.steps.map((s) =>
              s.controlledOffer
                ? {
                    ...s,
                    controlledOffer: {
                      ...s.controlledOffer,
                      status: "send_uncertain" as const,
                      deliveryAttemptId: randomUUID(),
                      deliveryStartedAt: new Date(Date.now() - 600000).toISOString(),
                      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
                    },
                  }
                : s,
            ),
          })
          .where(
            and(
              eq(workflows.id, current.id),
              eq(workflows.tenantId, f.employer),
              eq(workflows.jobId, f.jobId),
            ),
          );
        const state = await api("offer", "owner");
        assert.equal(state.offer.status, "send_uncertain");
        assert.equal(state.canReconcile, true);
        console.log(
          "Prepared synthetic uncertainty without a send or provider receipt. No email/provider call.",
        );
        return;
      }
      assert.ok(
        String(f.actors.approver.id).startsWith(String(f.jobId).replace(/_job$/, "") + "_"),
      );
      await dbAdmin
        .update(usersTable)
        .set({ status: "suspended" })
        .where(and(eq(usersTable.id, f.actors.approver.id), eq(usersTable.tenantId, f.employer)));
      const routing = await api("offer-routing", "admin");
      assert.equal(routing.recovery?.canRecover, true);
      assert.deepEqual(routing.recovery?.unavailableRoles, ["approver"]);
      console.log(
        "Prepared synthetic unsent approval with one unavailable fixture approver. No emails, interviews or provider calls.",
      );
    } else {
      const step = row.steps.at(-1)!;
      assert.equal(step.controlledOffer?.status, "draft");
      assert.equal(step.controlledOffer.approvedBy, undefined);
      assert.equal(step.controlledOffer.approvedAt, undefined);
      assert.equal(step.controlledOffer.sentAt, undefined);
      assert.equal(step.controlledOffer.version, 1);
      assert.equal(step.offerRouting?.ownerUserId, f.actors.owner.id);
      assert.equal(step.offerRouting?.senderUserId, f.actors.sender.id);
      assert.equal(step.offerRouting?.approverUserId, f.actors.owner.id);
      assert.equal(step.offerRoutingHistory?.at(-1)?.approverUserId, f.actors.approver.id);
      const old = step.controlledOfferHistory?.at(-1);
      assert.equal(old?.status, "approved");
      assert.equal(old?.approvedBy, f.actors.approver.name);
      assert.deepEqual(old?.terms, step.controlledOffer.terms);
      assert.equal((await api("offer-routing", "admin")).recovery, null);
      assert.equal(row.status, "completed");
      assert.deepEqual(
        row.steps.slice(0, 5),
        journeySteps("human")
          .slice(0, 5)
          .map((s) => ({
            ...s,
            status: "completed",
            evidence:
              "SYNTHETIC WORKFLOW ONLY: no real screening, identity clearance or candidate qualification.",
          })),
      );
      const effects = await pool.query(
        `SELECT (SELECT COUNT(*) FROM candidate_outcomes WHERE tenant_id=$1)::int AS outcomes,
        (SELECT COUNT(*) FROM fee_line_items WHERE tenant_id=$1)::int AS fees`,
        [f.employer],
      );
      assert.equal(effects.rows[0].outcomes, 0);
      assert.equal(effects.rows[0].fees, 0);
      const ownerOffer = await api("offer", "owner");
      assert.equal(ownerOffer.canSend, false);
      const apps = await dbAdmin
        .select()
        .from(applicationsTable)
        .where(
          and(eq(applicationsTable.jobId, f.jobId), eq(applicationsTable.tenantId, f.employer)),
        );
      assert.ok(apps.every((a) => a.stage === "applied"));
      console.log(
        "PASS: unavailable approver replaced only, approval reset once, original terms/evidence/history preserved, no delivery/employment/outcomes/fees.",
      );
    }
    return;
  }
  if (process.argv.includes("--setup-inbox")) {
    const f = JSON.parse(await readFile("/tmp/offer-routing-browser.json", "utf8"));
    assert.ok(String(f.jobId).startsWith("offer_ui_"));
    for (const mode of ["native", "external"]) {
      const workflowId = mode === "native" ? f.nativeWorkflowId : f.externalWorkflowId;
      const [row] = await dbAdmin
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.tenantId, f.employer),
            eq(workflows.jobId, f.jobId),
          ),
        );
      assert.ok(row.steps.find((s) => s.key === "hiring_decision")?.humanDecision?.testOnly);
      const r = await fetch(
        `https://${process.env.REPLIT_DEV_DOMAIN}/api/jobs/${f.jobId}/candidate-workflows/${workflowId}/offer-routing`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${f.actors.admin.sessionToken}`,
          },
          body: JSON.stringify({
            mode,
            ownerUserId: f.actors.owner.id,
            ...(mode === "native"
              ? { approverUserId: f.actors.approver.id, senderUserId: f.actors.sender.id }
              : {
                  externalSystem: "Greenhouse",
                  externalApplicationUrl: "https://app.greenhouse.io/fixtures/inbox",
                }),
            expectedRevision: row.revision,
            idempotencyKey: randomUUID(),
            reason:
              "Isolated offer-inbox UI verification; no provider requests or candidate delivery.",
          }),
        },
      );
      assert.equal(r.status, 200, `Synthetic ${mode} inbox configuration failed (${r.status}).`);
    }
    console.log(
      "Configured only synthetic inbox assignments. No offers, candidate emails, interviews or provider calls.",
    );
    return;
  }
  if (process.argv.includes("--retire")) {
    const f = JSON.parse(await readFile("/tmp/offer-routing-browser.json", "utf8"));
    const prefix = String(f.jobId).replace(/_job$/, "");
    assert.ok(prefix.startsWith("offer_ui_"));
    const ids = Object.values(f.actors).map((actor) => (actor as { id: string }).id);
    assert.ok(ids.every((id) => id.startsWith(`${prefix}_`)));
    assert.equal(f.employer, `${prefix}_employer`);
    assert.equal(f.agency, `${prefix}_agency`);
    await dbAdmin
      .update(usersTable)
      .set({ status: "suspended" })
      .where(
        and(inArray(usersTable.id, ids), inArray(usersTable.tenantId, [f.employer, f.agency])),
      );
    await unlink("/tmp/offer-routing-browser.json");
    process.stdout.write(
      "Retired only isolated UI actors and removed their temporary session fixture. No real users or offers changed.\n",
    );
    return;
  }
  if (process.argv.includes("--verify")) {
    const f = JSON.parse(await readFile("/tmp/offer-routing-browser.json", "utf8"));
    for (const [mode, id] of [
      ["native", f.nativeWorkflowId],
      ["external", f.externalWorkflowId],
    ]) {
      const [row] = await dbAdmin
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, id), eq(workflows.tenantId, f.employer)));
      assert.ok(row);
      const step = row.steps.at(-1)!;
      assert.equal(step.offerRouting?.mode, mode);
      assert.equal(step.humanDecision?.testOnly, true);
      const earlier = journeySteps("human")
        .slice(0, 5)
        .map((s) => ({
          ...s,
          status: "completed",
          evidence:
            "SYNTHETIC WORKFLOW ONLY: no real screening, identity clearance or candidate qualification.",
        }));
      assert.deepEqual(row.steps.slice(0, 5), earlier);
      if (mode === "native") {
        assert.ok(step.controlledOffer);
        assert.equal(step.controlledOffer?.status, "approved");
        assert.equal(step.offerRouting?.approverUserId, f.actors.approver.id);
        assert.equal(step.controlledOffer.approvedBy, f.actors.approver.name);
        assert.equal(step.controlledOffer.sentAt, undefined);
      } else {
        assert.equal(step.controlledOffer, undefined);
        assert.ok(
          step.offerRouting?.ownerUserId === null ||
            step.offerRouting?.ownerUserId === f.actors.owner.id,
          "An external contact is not native offer authority.",
        );
        assert.equal(step.offerRouting?.approverUserId, null);
        assert.equal(step.offerRouting?.senderUserId, null);
      }
      assert.equal(
        await hasControlledOffer(f.jobId, row.candidateId),
        true,
        "Legacy offer/fee paths must be blocked for both managed modes.",
      );
    }
    const apps = await dbAdmin
      .select()
      .from(applicationsTable)
      .where(and(eq(applicationsTable.jobId, f.jobId), eq(applicationsTable.tenantId, f.employer)));
    assert.equal(apps.length, 2);
    assert.ok(apps.every((app) => app.stage === "applied"));
    for (const table of ["candidate_outcomes", "fee_line_items"]) {
      const result = await pool.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1`,
        [f.employer],
      );
      assert.equal(result.rows[0].count, 0);
    }
    const path = `https://${process.env.REPLIT_DEV_DOMAIN}/api/jobs/${f.jobId}/candidate-workflows/${f.nativeWorkflowId}`;
    for (const key of ["agency", "admin", "sender"]) {
      const response = await fetch(`${path}/offer`, {
        headers: { Authorization: `Bearer ${f.actors[key].sessionToken}` },
      });
      assert.equal(response.status, 200);
      const state = (await response.json()) as {
        canApprove: boolean;
        canSend: boolean;
        canEdit: boolean;
      };
      assert.equal(state.canApprove, false);
      assert.equal(state.canSend, key === "sender");
      assert.equal(state.canEdit, false);
      if (key === "agency") {
        const r = await fetch(`${path}/offer-routing`, {
          headers: { Authorization: `Bearer ${f.actors[key].sessionToken}` },
        });
        assert.equal(r.status, 200);
        assert.equal(((await r.json()) as { canConfigure: boolean }).canConfigure, false);
      }
    }
    process.stdout.write(
      "PASS: approved but unsent native offer; manual external ownership; original evidence unchanged; agency/admin role alone denied; sender explicitly authorised; both legacy bypasses blocked; no employment/outcomes/fees.\n",
    );
    return;
  }
  if (!process.argv.includes("--prepare")) throw new Error("Explicit --prepare required.");
  const prefix = `offer_ui_${randomUUID()}`;
  const agency = `${prefix}_agency`,
    employer = `${prefix}_employer`,
    jobId = `${prefix}_job`;
  const ids = Object.fromEntries(
    ["admin", "owner", "approver", "sender", "agency"].map((key) => [key, `${prefix}_${key}`]),
  );
  const labels = {
    admin: "Employer Offer Administrator",
    owner: "Employer Offer Owner",
    approver: "Employer Offer Approver",
    sender: "Employer Offer Sender",
    agency: "Agency Administrator",
  };
  await dbAdmin.transaction(async (tx) => {
    await tx.insert(tenantsTable).values([
      { id: agency, slug: agency, name: "ISOLATED OFFER UI agency" },
      { id: employer, slug: employer, name: "ISOLATED OFFER UI employer", parentId: agency },
    ]);
    await tx.insert(usersTable).values(
      Object.entries(ids).map(([key, id]) => ({
        id,
        tenantId: key === "agency" ? agency : employer,
        role: "tenant_admin" as const,
        status: "active" as const,
        name: labels[key as keyof typeof labels],
        email: `${id}@example.invalid`,
        passwordHash: "unused-isolated-fixture",
      })),
    );
    await tx.insert(jobsTable).values({
      id: jobId,
      tenantId: employer,
      title: "ISOLATED TEST — Employer offer ownership",
      description: "Synthetic permission and manual handoff fixture; not a real vacancy.",
      status: "active",
      interviewPath: "human",
    });
    const scope = { jobId, tenantId: employer, actorId: ids.admin, canApprove: true };
    const brief = await readBrief(tx, scope);
    for (const mode of ["native", "external"]) {
      const candidateId = `${prefix}_${mode}_candidate`,
        workflowId = `${prefix}_${mode}_workflow`;
      await tx.insert(candidatesTable).values({
        id: candidateId,
        tenantId: employer,
        firstName: mode === "native" ? "Native" : "External",
        lastName: "Offer UI Fixture",
        email: `${candidateId}@example.invalid`,
        pool: "tenant",
        verificationStatus: "pending",
        verificationResult: { syntheticFixture: { kind: "controlled_inbox", workflowId } },
      });
      await tx
        .insert(applicationsTable)
        .values({ tenantId: employer, jobId, candidateId, stage: "applied" });
      const steps = journeySteps("human").map((step) => ({
        ...step,
        status: "completed" as const,
        evidence:
          "SYNTHETIC WORKFLOW ONLY: no real screening, identity clearance or candidate qualification.",
        ...(step.key === "hiring_decision"
          ? {
              humanDecision: {
                outcome: "hire" as const,
                actorId: ids.admin,
                actorName: labels.admin,
                decidedAt: new Date().toISOString(),
                reason:
                  "INTERNAL UI FIXTURE ONLY — exercise employer permissions; not a real hiring decision.",
                testOnly: true,
              },
            }
          : {}),
      }));
      const journeyId = `${prefix}_${mode}_journey`;
      await tx.insert(journeys).values({
        id: journeyId,
        tenantId: employer,
        jobId,
        version: mode === "native" ? 1 : 2,
        status: "approved",
        briefHash: brief.hash,
        brief: brief.brief,
        interviewPath: "human",
        steps,
        createdById: ids.admin,
        approvedById: ids.admin,
        approvedAt: new Date(),
      });
      await tx.insert(workflows).values({
        id: workflowId,
        tenantId: employer,
        jobId,
        candidateId,
        journeyId,
        journeyVersion: mode === "native" ? 1 : 2,
        status: "completed",
        interviewPath: "human",
        steps,
        createdById: ids.admin,
      });
    }
  });
  await writeFile(
    "/tmp/offer-routing-browser.json",
    JSON.stringify({
      jobId,
      employer,
      agency,
      staffPath: `/jobs/${jobId}`,
      nativeWorkflowId: `${prefix}_native_workflow`,
      externalWorkflowId: `${prefix}_external_workflow`,
      actors: Object.fromEntries(
        Object.entries(ids).map(([key, id]) => [
          key,
          {
            id,
            name: labels[key as keyof typeof labels],
            sessionToken: issueToken({
              userId: id,
              tenantId: key === "agency" ? agency : employer,
              role: "tenant_admin",
            }),
          },
        ]),
      ),
    }),
    { mode: 0o600, flag: "wx" },
  );
  process.stdout.write(
    "Prepared isolated employer/agency contexts and two distinct synthetic applications. No interviews or emails created.\n",
  );
}
try {
  await main();
} finally {
  await pool.end();
}
