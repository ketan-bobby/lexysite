import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { inboxReplyOperationId, type RecordedCommunication } from "./recorded-communication";

function load(file: string, name: string, bindings: Record<string, unknown>, route?: string) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let source: string | undefined;
  function visit(n: ts.Node) {
    if (!route && ts.isFunctionDeclaration(n) && n.name?.text === name)
      source = n.getText(tree).replace(/^export /, "");
    if (
      route &&
      ts.isCallExpression(n) &&
      n.expression.getText(tree) === "router.post" &&
      ts.isStringLiteral(n.arguments[0]!) &&
      n.arguments[0].text === route
    )
      source = `const ${name}=${n.arguments.at(-1)!.getText(tree)};`;
    ts.forEachChild(n, visit);
  }
  visit(tree);
  assert.ok(source);
  // Replace only the runtime dependency import; execute the current function,
  // not a rewritten copy of its business logic. No real LLM/provider/database.
  source = source.replace('await import("../workflow-contact-gates")', "workflowGates");
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${code};return ${name};`)(
    ...Object.values(bindings),
  );
}
test("the current inbox route passes stable scoped reply intent and surfaces review errors without marking read", async () => {
  for (const reviewRequired of [false, true]) {
    const inbox = {},
      candidates = {};
    let reads = 0,
      marked = 0,
      calls = 0;
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              reads++;
              return table === inbox
                ? [
                    {
                      id: "inbox",
                      tenantId: "tenant",
                      candidateId: "candidate",
                      subject: "Original",
                    },
                  ]
                : [
                    {
                      id: "candidate",
                      email: "fixture@example.invalid",
                      firstName: "Synthetic",
                      lastName: "Only",
                    },
                  ];
            },
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            marked++;
          },
        }),
      }),
    };
    const handler = load(
      "../routes/outreach.ts",
      "handler",
      {
        db,
        recruiterInboxTable: inbox,
        candidatesTable: candidates,
        eq: () => null,
        canAccessTenant: async () => true,
        getAuthUserId: () => "staff",
        inboxReplyOperationId,
        sendRecordedCommunication: async (input: RecordedCommunication) => {
          calls++;
          assert.equal(input.tenantId, "tenant");
          assert.equal(input.candidateId, "candidate");
          assert.equal(input.senderUserId, "staff");
          assert.equal(input.type, "follow_up");
          assert.equal(
            input.id,
            inboxReplyOperationId({
              tenantId: "tenant",
              inboxId: "inbox",
              senderId: "staff",
              subject: "Re: Original",
              body: "Synthetic reply",
            }),
          );
          return reviewRequired
            ? { ok: false, reviewRequired: true, error: "Review original attempt" }
            : { ok: true, acceptance: "accepted" };
        },
        logger: { error() {}, warn() {} },
        recordAudit: () => {},
      },
      "/outreach/inbox/:id/reply",
    );
    let status = 200,
      payload: Record<string, unknown> = {};
    const res = {
      status: (s: number) => {
        status = s;
        return res;
      },
      json: (p: Record<string, unknown>) => {
        payload = p;
      },
    };
    await handler(
      { params: { id: "inbox" }, body: { body: "Synthetic reply" }, resolvedUser: { id: "staff" } },
      res,
    );
    assert.equal(status, reviewRequired ? 500 : 200);
    assert.equal(payload.ok, !reviewRequired);
    assert.equal(marked, reviewRequired ? 0 : 1);
    assert.equal(reads, 2);
    assert.equal(calls, 1);
  }
});
test("the current interview reminder retains its session claim on uncertainty and cannot draft/send a second reminder", async () => {
  const sessions = { name: "sessions" },
    plans = { name: "plans" },
    candidates = { name: "candidates" },
    jobs = { name: "jobs" };
  let claimed = false,
    drafts = 0,
    sends = 0;
  const session = {
    id: "session",
    applicationId: "native",
    planId: "plan",
    candidateId: "candidate",
    tenantId: "tenant",
    language: "en",
  };
  const rows = new Map<unknown, unknown[]>([
    [sessions, [session]],
    [plans, [{ id: "plan", jobId: "job", tenantId: "tenant" }]],
    [candidates, [{ id: "candidate", email: "fixture@example.invalid" }]],
    [jobs, [{ id: "job", title: "Fixture role", tenantId: "tenant" }]],
  ]);
  const db = {
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ limit: async () => rows.get(table) ?? [] }) }),
    }),
    update: (table: unknown) => ({
      set: (changes: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            assert.equal(table, sessions);
            if (claimed) return [];
            assert.ok(changes.reEngagementSentAt instanceof Date);
            claimed = true;
            return [{ ...session, ...changes }];
          },
        }),
      }),
    }),
  };
  const handler = load("./agents/interview-reply.ts", "sendReEngagement", {
    db,
    interviewSessionsTable: sessions,
    interviewPlansTable: plans,
    candidatesTable: candidates,
    jobsTable: jobs,
    workflowGates: {
      hasBoundInvitationWorkflow: async () => false,
      unownedWorkflowContactCondition: () => null,
    },
    eq: () => null,
    and: () => null,
    isNull: () => null,
    newToken: () => "synthetic-token",
    INVITE_TTL_MS: 86400000,
    candidateDisplayName: () => "Synthetic",
    isJobApprovedForInterview: () => true,
    publicBaseUrl: () => "https://example.invalid",
    inviteEmailHtml: () => "<p>Synthetic</p>",
    aiDraft: async () => {
      drafts++;
      return { subject: "Synthetic reminder", body: "Synthetic body" };
    },
    sendRecordedCommunication: async (input: RecordedCommunication) => {
      assert.ok(claimed);
      sends++;
      assert.equal(input.id, "interview-reengagement:session");
      assert.equal(input.applicationId, "session");
      assert.equal(input.tenantId, "tenant");
      assert.equal(input.type, "re_engagement");
      assert.equal(input.senderUserId, undefined);
      return { ok: false, reviewRequired: true, error: "Review required" };
    },
  });
  assert.equal((await handler("session")).ok, false);
  assert.ok(claimed);
  assert.equal((await handler("session")).ok, false);
  assert.equal(drafts, 1);
  assert.equal(sends, 1);
});
