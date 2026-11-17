import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { dbAdmin } from "@workspace/db";
import { zohoStageRules } from "./zoho-stage-rules";
import { zohoStageRuleStore } from "./zoho-stage-rule-store";
import { ruleInput, ruleAction, RULE_TTL } from "./zoho-stage-rule-policy";
import { CalendarError } from "../outlook-calendar-core";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import { registerStageDispatchCases } from "./fixtures/zoho-stage-dispatch.cases";

const evidence = {
  contractReference: "Employer-contract-report-v1",
  isolationReference: "Employer-isolation-report-v1",
  requirementsReference: "Employer-blueprint-report-v1",
  sideEffectsReference: "Employer-effects-report-v1",
  requirements: "no_additional_fields_or_blueprint_actions" as const,
  notifications: "no_automatic_messages_or_cross_application_changes" as const,
};
test("employer rule evidence: private SQL journal, independent review and guarded source", async (t) => {
  const rollback = new Error("rollback-private-rule-fixture");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      const [identity] = (
        await tx.execute(sql`SELECT current_database() AS name,inet_server_addr() AS host`)
      ).rows;
      assert.equal(identity.name, "heliumdb");
      assert.equal(identity.host, null, "local development database only");
      await tx.execute(
        sql`CREATE TEMP TABLE audit_logs (LIKE public.audit_logs INCLUDING ALL) ON COMMIT DROP`,
      );
      await tx.execute(
        sql`CREATE TEMP TABLE users(id text PRIMARY KEY,tenant_id text,role text,status text,account_erased_at timestamptz) ON COMMIT DROP`,
      );
      await tx.execute(sql`SET LOCAL search_path=pg_temp,pg_catalog`);
      async function fixture() {
        const tenantId = randomUUID(),
          a = { id: randomUUID(), tenantId },
          b = { id: randomUUID(), tenantId },
          c = { id: randomUUID(), tenantId };
        const scope = { campaignId: randomUUID(), recipientId: randomUUID() };
        for (const actor of [a, b, c])
          await tx.execute(
            sql`INSERT INTO users VALUES(${actor.id},${tenantId},'tenant_admin','active',NULL)`,
          );
        const h = {
          revision: "b".repeat(64),
          ready: true,
          decision: "advance",
          targetStatus: "In Review",
          applicationId: "993001",
          externalCandidateId: "992001",
          externalJobId: "991001",
          mapping: { revision: randomUUID() },
        };
        const permission = {
          connectionRevision: "current-connection",
          writeConsentSaved: true,
          custodyRevision: "d".repeat(64),
          configFingerprint: "e".repeat(64),
        };
        let at = 10_000,
          reads = 0,
          inside = false,
          sourceAllowed = true,
          visible = true,
          currentStatus = "Associated",
          catalogRevision = "f".repeat(64);
        let afterRead: (() => void) | undefined,
          beforeFence: (() => void) | undefined,
          queue = Promise.resolve();
        const actorAllowed = (actor: typeof a, campaign: string, recipient: string) => {
          if (
            !visible ||
            actor.tenantId !== tenantId ||
            ![a.id, b.id, c.id].includes(actor.id) ||
            campaign !== scope.campaignId ||
            recipient !== scope.recipientId
          )
            throw new CalendarError(404, "not_found", "Not found");
        };
        const wrapped = {
          select: tx.select.bind(tx),
          insert: tx.insert.bind(tx),
          execute: (query: Parameters<typeof tx.execute>[0]) => {
            const text = new PgDialect().sqlToQuery(
              query as Parameters<PgDialect["sqlToQuery"]>[0],
            ).sql;
            if (text.includes("SELECT c.id FROM candidates c"))
              return Promise.resolve({ rows: sourceAllowed ? [{ id: "local-candidate" }] : [] });
            return tx.execute(query);
          },
        };
        const store = zohoStageRuleStore(tx as unknown as typeof dbAdmin);
        const deps = {
          handoff: {
            detail: async (actor: typeof a, campaign: string, recipient: string) => {
              actorAllowed(actor, campaign, recipient);
              return structuredClone(h);
            },
          },
          reviews: {
            noteContext: async () => ({
              tenantId,
              ...scope,
              candidateId: "local-candidate",
              accountRef: "a".repeat(64),
              connectionRevision: "source-connection",
              applicationId: h.applicationId,
              externalCandidateId: h.externalCandidateId,
              externalJobId: h.externalJobId,
              sourceEvidenceHash: h.revision,
              latestReviewId: "current-human-review",
            }),
          },
          permissions: { check: async () => ({ ...permission }) },
          store,
          now: () => at,
          validation: {
            check: async () => {
              assert.equal(inside, false, "bounded remote reads occur before the SQL source fence");
              reads++;
              const m = {
                handoffRevision: h.revision,
                mappingRevision: h.mapping.revision,
                connectionRevision: "source-connection",
                identityVerified: true,
                applicationId: h.applicationId,
                externalCandidateId: h.externalCandidateId,
                externalJobId: h.externalJobId,
                currentApplicationStatus: currentStatus,
                catalogRevision,
                mappings: [
                  { decision: "advance", targetStatus: h.targetStatus, result: "matched" },
                ],
              };
              afterRead?.();
              return m;
            },
          },
          authority: {
            fence: async (
              _a: unknown,
              _c: unknown,
              work: (handle: unknown) => Promise<unknown>,
            ) => {
              const prior = queue;
              let release!: () => void;
              queue = new Promise<void>((resolve) => {
                release = resolve;
              });
              await prior;
              beforeFence?.();
              inside = true;
              try {
                return await work(wrapped);
              } finally {
                inside = false;
                release();
              }
            },
          },
          assertSourceCurrent: async (
            _actor: unknown,
            _campaign: unknown,
            _recipient: unknown,
            hash: string,
            _review: unknown,
            handle: unknown,
          ) => {
            assert.equal(inside, true);
            assert.equal(handle, wrapped);
            if (hash !== h.revision)
              throw new CalendarError(409, "source_changed", "Source changed");
          },
        };
        const service = zohoStageRules(
          deps as unknown as NonNullable<Parameters<typeof zohoStageRules>[0]>,
        );
        const propose = async () => {
          const w = await service.view(a, scope);
          return service.propose(a, scope, {
            expectedRevision: h.revision,
            expectedRuleRevision: w.currentRule?.revision ?? null,
            requestId: randomUUID(),
            evidence,
            confirm: true,
          });
        };
        const verify = async (actor = b) => {
          const w = await service.view(actor, scope);
          return service.act(actor, scope, w.currentRule!.id, {
            expectedRevision: w.currentRule!.revision,
            requestId: randomUUID(),
            action: "verify",
            reviewReference: "Independent-employer-review-v1",
            confirm: true,
          });
        };
        const load = async () => {
          const w = await service.view(c, scope);
          return service.withVerifiedRule(
            c,
            scope,
            w.currentRule!.revision,
            async (value, handle) => {
              assert.equal(inside, true);
              assert.equal(handle, wrapped);
              return value;
            },
          );
        };
        return {
          a,
          b,
          c,
          scope,
          h,
          permission,
          store,
          dependencies: deps,
          get inside() {
            return inside;
          },
          service,
          propose,
          verify,
          load,
          get reads() {
            return reads;
          },
          get at() {
            return at;
          },
          set at(v: number) {
            at = v;
          },
          set currentStatus(v: string) {
            currentStatus = v;
          },
          set catalogRevision(v: string) {
            catalogRevision = v;
          },
          set afterRead(v: (() => void) | undefined) {
            afterRead = v;
          },
          set beforeFence(v: (() => void) | undefined) {
            beforeFence = v;
          },
          set sourceAllowed(v: boolean) {
            sourceAllowed = v;
          },
          set visible(v: boolean) {
            visible = v;
          },
        };
      }
      await t.test(
        "GET is local; proposal is not verified, and replay does not re-read Zoho",
        async () => {
          const f = await fixture();
          assert.equal((await f.service.view(f.a, f.scope)).status, "proposal_required");
          assert.equal(f.reads, 0);
          const input = {
            expectedRevision: f.h.revision,
            expectedRuleRevision: null,
            requestId: randomUUID(),
            evidence,
            confirm: true as const,
          };
          const p = await f.service.propose(f.a, f.scope, input);
          assert.equal(p.status, "pending_review");
          assert.equal(p.canVerify, false);
          await f.service.propose(f.a, f.scope, input);
          assert.equal(f.reads, 1);
          assert.equal((await f.store.list(f.a, f.scope)).length, 1);
          await assert.rejects(f.load());
          await assert.rejects(
            f.service.propose(f.a, f.scope, {
              ...input,
              evidence: { ...evidence, contractReference: "Changed-reference-v2" },
            }),
          );
        },
      );
      await t.test(
        "self-verification is forbidden; a separate admin can verify and a third can load under locks",
        async () => {
          const f = await fixture();
          await f.propose();
          await assert.rejects(f.verify(f.a), { status: 403 });
          const w = await f.verify();
          assert.equal(w.status, "verified");
          assert.equal(w.liveEnabled, false);
          const { proof } = await f.load();
          assert.equal(proof.verifiedBy, f.b.id);
          assert.equal(proof.applicationId, "993001");
          assert.equal(proof.expiresAt - proof.verifiedAt, RULE_TTL);
          assert.equal(JSON.stringify(w).includes("custodyRevision"), false);
          for (const row of (
            await tx.execute(
              sql`SELECT metadata FROM audit_logs WHERE subject_id=${f.scope.recipientId}`,
            )
          ).rows)
            for (const id of ["993001", "992001", "991001"])
              assert.equal(JSON.stringify(row.metadata).includes(id), false);
        },
      );
      await t.test("expiry cannot silently renew or admit a duplicate verification", async () => {
        const f = await fixture();
        await f.propose();
        const verified = await f.verify();
        f.at += RULE_TTL;
        assert.equal((await f.service.view(f.b, f.scope)).status, "expired");
        await assert.rejects(f.load());
        await assert.rejects(f.verify());
        assert.equal(
          (await f.service.view(f.b, f.scope)).currentRule!.expiresAt,
          verified.currentRule!.expiresAt,
        );
      });
      await t.test("revocation and a newer proposal prevent loading older evidence", async () => {
        const f = await fixture();
        await f.propose();
        let w = await f.verify();
        await f.service.act(f.b, f.scope, w.currentRule!.id, {
          expectedRevision: w.currentRule!.revision,
          requestId: randomUUID(),
          action: "revoke",
          confirm: true,
        });
        await assert.rejects(f.load());
        assert.equal((await f.service.view(f.a, f.scope)).status, "revoked");
        await f.propose();
        w = await f.verify();
        await f.propose();
        await assert.rejects(
          f.service.withVerifiedRule(f.c, f.scope, w.currentRule!.revision, async () => true),
        );
      });
      await t.test(
        "remote status/catalogue drift and local source drift are not treated as transition eligibility",
        async () => {
          for (const kind of ["status", "catalogue", "source"]) {
            const f = await fixture();
            await f.propose();
            if (kind === "status") f.currentStatus = "Different status";
            else if (kind === "catalogue") f.catalogRevision = "1".repeat(64);
            else f.h.revision = "2".repeat(64);
            await assert.rejects(f.verify());
            assert.equal((await f.store.list(f.a, f.scope)).length, 1);
          }
        },
      );
      await t.test(
        "source changes during remote reads or while waiting for locks reject without appending",
        async () => {
          for (const kind of ["read", "wait", "privacy"]) {
            const f = await fixture();
            await f.propose();
            if (kind === "read")
              f.afterRead = () => {
                f.h.revision = "3".repeat(64);
              };
            else if (kind === "wait")
              f.beforeFence = () => {
                f.h.revision = "4".repeat(64);
              };
            else f.sourceAllowed = false;
            await assert.rejects(f.verify());
            assert.equal((await f.store.list(f.a, f.scope)).length, 1);
          }
        },
      );
      await t.test(
        "current credential custody, mapping, decision and permission remain bound",
        async () => {
          for (const kind of ["custody", "connection", "mapping", "decision", "grant"]) {
            const f = await fixture();
            await f.propose();
            await f.verify();
            if (kind === "custody") f.permission.custodyRevision = "9".repeat(64);
            if (kind === "connection") f.permission.connectionRevision = "reconnected";
            if (kind === "mapping") f.h.mapping.revision = randomUUID();
            if (kind === "decision") f.h.ready = false;
            if (kind === "grant") f.permission.writeConsentSaved = false;
            await assert.rejects(f.load());
          }
        },
      );
      await t.test(
        "reviewer or submitter revocation invalidates proof under the same SQL transaction",
        async () => {
          for (const role of ["submitter", "reviewer"]) {
            const f = await fixture();
            await f.propose();
            await f.verify();
            await tx.execute(
              sql`UPDATE users SET status='inactive' WHERE id=${role === "submitter" ? f.a.id : f.b.id}`,
            );
            await assert.rejects(f.load());
          }
        },
      );
      await t.test(
        "concurrent reviewers are rechecked after the serialized source fence",
        async () => {
          const f = await fixture();
          await f.propose();
          const results = await Promise.allSettled([f.verify(f.b), f.verify(f.c)]);
          assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
          assert.equal(results.filter((r) => r.status === "rejected").length, 1);
          assert.equal((await f.store.list(f.a, f.scope)).length, 2);
        },
      );
      await t.test(
        "concurrent proposals cannot silently supersede a rule the submitter has not seen",
        async () => {
          const f = await fixture();
          const results = await Promise.allSettled([f.propose(), f.propose()]);
          assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
          assert.equal(results.filter((r) => r.status === "rejected").length, 1);
          assert.equal((await f.store.list(f.a, f.scope)).length, 1);
        },
      );
      await t.test("foreign scope, erasure and corrupted journal history fail closed", async () => {
        const f = await fixture();
        await f.propose();
        await assert.rejects(f.service.view({ ...f.a, tenantId: randomUUID() }, f.scope));
        await assert.rejects(f.service.view(f.a, { ...f.scope, recipientId: randomUUID() }));
        assert.deepEqual(await f.store.list({ ...f.a, tenantId: randomUUID() }, f.scope), []);
        f.visible = false;
        await assert.rejects(f.service.view(f.a, f.scope));
        f.visible = true;
        await tx.execute(
          sql`UPDATE audit_logs SET metadata=jsonb_set(metadata,'{sequence}','5'::jsonb) WHERE subject_id=${f.scope.recipientId}`,
        );
        await assert.rejects(f.service.view(f.a, f.scope));
      });
      await t.test(
        "strict intake rejects browser proof, unsupported requirements, repeated references and signed URLs",
        () => {
          const base = {
            expectedRevision: "a".repeat(64),
            expectedRuleRevision: null,
            requestId: randomUUID(),
            evidence,
            confirm: true,
          };
          for (const extra of [
            { proof: {} },
            { tenantId: randomUUID() },
            { verifiedBy: randomUUID() },
            { applicationId: "993001" },
          ])
            assert.equal(ruleInput.safeParse({ ...base, ...extra }).success, false);
          assert.equal(
            ruleInput.safeParse({
              ...base,
              evidence: { ...evidence, requirements: "mandatory_fields_present" },
            }).success,
            false,
          );
          assert.equal(
            ruleInput.safeParse({
              ...base,
              evidence: { ...evidence, isolationReference: evidence.contractReference },
            }).success,
            false,
          );
          assert.equal(
            ruleInput.safeParse({
              ...base,
              evidence: {
                ...evidence,
                contractReference: "https://example.test/report?token=hidden",
              },
            }).success,
            false,
          );
          assert.equal(
            ruleAction.safeParse({
              expectedRevision: "a".repeat(64),
              requestId: randomUUID(),
              action: "verify",
              confirm: true,
            }).success,
            false,
          );
        },
      );
      await t.test(
        "HTTP routes enforce strict input, no-store reads, current scope and no execution action",
        async () => {
          const f = await fixture(),
            app = express();
          app.use(express.json());
          const deps = { actor: async () => f.a } as unknown as NonNullable<
            Parameters<typeof zohoRecruitAccountRouter>[0]
          >;
          app.use(
            zohoRecruitAccountRouter(
              deps,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              () => f.service,
            ),
          );
          const server = app.listen(0, "127.0.0.1");
          await new Promise<void>((resolve) => server.once("listening", resolve));
          const address = server.address();
          assert.ok(address && typeof address !== "string");
          const url = `http://127.0.0.1:${address.port}/zoho-recruit/campaigns/${f.scope.campaignId}/recipients/${f.scope.recipientId}/stage-rules`;
          try {
            let r = await fetch(url);
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("cache-control"), "no-store");
            assert.equal(f.reads, 0);
            r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                expectedRevision: f.h.revision,
                expectedRuleRevision: null,
                requestId: randomUUID(),
                evidence,
                confirm: true,
                proof: { verified: true },
              }),
            });
            assert.equal(r.status, 400);
            assert.equal(f.reads, 0);
            r = await fetch(`${url}/${randomUUID()}/actions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "execute",
                expectedRevision: "a".repeat(64),
                requestId: randomUUID(),
                confirm: true,
              }),
            });
            assert.equal(r.status, 400);
            f.visible = false;
            r = await fetch(url);
            assert.equal(r.status, 404);
          } finally {
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        },
      );
      await registerStageDispatchCases(t, fixture, tx);
      throw rollback;
    }),
    (error) => error === rollback,
  );
});
