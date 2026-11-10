import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import {
  zohoIntakeRecord,
  zohoImportSelection,
  zohoImportConfirmation,
  zohoJobApplicants,
  zohoJobApplicantSelection,
} from "./zoho-intake-record";
import { zohoOAuthConfig, zohoOAuthProvider } from "./zoho-oauth-provider";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import {
  PreviewZohoRecruitImportResponse,
  ConfirmZohoRecruitImportResponse,
} from "@workspace/api-zod";
import { zohoReviewedImport } from "./zoho-reviewed-import";
import type { ZohoRow, ZohoStore } from "./zoho-oauth-store";

const id = "100001000000025064";
test("selected record parser minimizes provider payload and refuses identity, opt-out and field drift", () => {
  const candidate = zohoIntakeRecord("candidate", id, {
    data: [
      {
        id,
        First_Name: "Ada",
        Last_Name: "Lovelace",
        Email: "Ada@Example.test",
        Email_Opt_Out: false,
        Social_Security_Number: "not for Lexy",
      },
    ],
  });
  assert.equal(candidate.email, "ada@example.test");
  assert.ok(!JSON.stringify(candidate).includes("Social_Security_Number"));
  const job = zohoIntakeRecord("job", id, {
    data: [
      {
        id,
        Posting_Title: "Engineer",
        Job_Description: "Review APIs",
        City: "Boston",
        Salary: 900000,
      },
    ],
  });
  assert.equal(job.title, "Engineer");
  assert.ok(!JSON.stringify(job).includes("900000"));
  for (const payload of [
    { data: [{ id, Email: "a@b.test", Last_Name: "Name" }] },
    { data: [{ id, Email: "a@b.test", Last_Name: "Name", Email_Opt_Out: true }] },
    { data: [{ id: Number(id), Email: "a@b.test", Last_Name: "Name", Email_Opt_Out: false }] },
    { data: [{ id, Email: "a@b.test", Last_Name: "Name", Email_Opt_Out: false }, { id }] },
  ])
    assert.throws(() => zohoIntakeRecord("candidate", id, payload));
  assert.throws(() => zohoIntakeRecord("job", id, { data: [{ id, Posting_Title: "Name" }] }));
  assert.throws(() =>
    zohoIntakeRecord("job", id, {
      data: [{ id: "200", Posting_Title: "Name", Job_Description: "Text" }],
    }),
  );
});

test("job applicant parser exposes only exact application and candidate identifiers", () => {
  const application = {
    id: "300",
    Job_Opening_Name: { id },
    Candidate_Name: { id: "200" },
    privateNotes: "do not show",
  };
  const verified = zohoJobApplicants(id, 1, { data: [application], info: { more_records: true } });
  assert.deepEqual(verified, {
    jobId: id,
    page: 1,
    moreRecords: true,
    applications: [{ applicationId: "300", candidateId: "200" }],
  });
  for (const invalid of [
    { data: [{ ...application, Job_Opening_Name: { id: "999" } }], info: { more_records: false } },
    { data: [{ ...application, Candidate_Name: null }], info: { more_records: false } },
    { data: [application, application], info: { more_records: false } },
    { data: [application] },
    { data: [{ ...application, id: 300 }], info: { more_records: false } },
  ])
    assert.throws(() => zohoJobApplicants(id, 1, invalid));
  assert.equal(
    zohoJobApplicantSelection.safeParse({
      revision: "11111111-1111-4111-8111-111111111111",
      jobId: id,
      page: 1,
      confirm: false,
    }).success,
    false,
  );
});

test("intake transport pins product host, fields, fixed module and never exposes token in URL", async () => {
  const config = zohoOAuthConfig({
    ZOHO_CLIENT_ID: "1000.synthetic",
    ZOHO_CLIENT_SECRET: "synthetic",
    ZOHO_REDIRECT_URI: "https://app.test/api/zoho-recruit/callback",
    ZOHO_SETTINGS_URL: "https://app.test/settings/ats",
    ZOHO_DATA_CENTER: "us",
    SESSION_SECRET: "synthetic",
  })!;
  const calls: { url: URL; init: RequestInit }[] = [];
  const provider = zohoOAuthProvider(config, async (url, init) => {
    calls.push({ url: new URL(url.toString()), init: init! });
    return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
  });
  await provider.readIntakeRecord("synthetic-access", "job", id);
  await provider.readIntakeRecord("synthetic-access", "candidate", id);
  await provider.searchJobApplications("synthetic-access", id, 1);
  await provider.readApplication("synthetic-access", id);
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    [
      `/recruit/v2/Job_Openings/${id}`,
      `/recruit/v2/Candidates/${id}`,
      "/recruit/v2/Applications/search",
      `/recruit/v2/Applications/${id}`,
    ],
  );
  assert.ok(
    calls.every(
      (c) =>
        c.url.origin === "https://recruit.zoho.com" &&
        c.init.redirect === "error" &&
        c.init.method === "GET" &&
        !c.url.href.includes("synthetic-access"),
    ),
  );
  assert.equal(
    calls[1].url.searchParams.get("fields"),
    "id,First_Name,Last_Name,Email,Email_Opt_Out",
  );
  assert.equal(calls[2].url.searchParams.get("criteria"), `($Job_Opening_Id:equals:${id})`);
  assert.equal(calls[2].url.searchParams.get("approved"), "both");
  assert.equal(calls[2].url.searchParams.get("converted"), "both");
  await assert.rejects(provider.readIntakeRecord("synthetic", "job", "../Applications"), {
    code: "zoho_module_request_failed",
  });
  await assert.rejects(provider.searchJobApplications("synthetic", id, 101), {
    code: "zoho_module_request_failed",
  });
  assert.equal(
    calls[3].url.searchParams.get("fields"),
    "id,$Job_Opening_Id,$Candidate_Id,Job_Opening_Name,Candidate_Name,Application_Status",
  );
  await assert.rejects(provider.readApplication("synthetic", "../Candidates"), {
    code: "zoho_module_request_failed",
  });
  assert.equal(calls.length, 4);
});

test("import routes strictly validate consent and actor before calling import service; response is minimized", async () => {
  const app = express();
  app.use(express.json());
  const calls: string[] = [];
  let authorized = true;
  const revision = "11111111-1111-4111-8111-111111111111";
  app.use(
    "/api",
    zohoRecruitAccountRouter(
      {
        actor: async () => {
          if (!authorized) throw { status: 403, code: "unauthorized" };
          return { id: "synthetic-admin", tenantId: "synthetic-employer" };
        },
        service: () => {
          throw Error("not used");
        },
        config: () => null,
      },
      () => {
        throw Error("not used");
      },
      () => ({
        async applicants() {
          calls.push("applicants");
          return {
            jobId: id,
            jobTitle: "Engineer",
            page: 1,
            moreRecords: false,
            applications: [{ applicationId: "999", candidateId: "888" }],
          };
        },
        async preview() {
          calls.push("preview");
          return {
            revision,
            kind: "job" as const,
            recordId: id,
            confirm: true as const,
            previewToken: "opaque",
            expiresAt: new Date(),
            fields: {
              title: "Engineer",
              description: "Text",
              location: null,
              firstName: null,
              lastName: null,
              email: null,
            },
            existingId: null,
            disposition: "create" as const,
          };
        },
        async confirm() {
          calls.push("confirm");
          return {
            kind: "job" as const,
            localId:
              "11111111-1111-4111-8111-111111111112" as `${string}-${string}-${string}-${string}-${string}`,
            outcome: "created" as const,
          };
        },
      }),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing address");
    const base = `http://127.0.0.1:${address.port}/api/zoho-recruit/imports`;
    const post = (route: string, data: unknown) =>
      fetch(`${base}/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    const input = { revision, kind: "job", recordId: id, confirm: true };
    for (const bad of [
      { ...input, confirm: false },
      { ...input, tenantId: "foreign" },
      { ...input, recordId: "01" },
      { ...input, kind: "Applications" },
    ]) {
      assert.equal((await post("preview", bad)).status, 400);
    }
    assert.deepEqual(calls, []);
    authorized = false;
    assert.equal((await post("preview", input)).status, 503);
    assert.deepEqual(calls, []);
    authorized = true;
    const preview = await post("preview", input);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("cache-control"), "no-store");
    PreviewZohoRecruitImportResponse.parse({
      ...((await preview.json()) as object),
      expiresAt: new Date(),
    });
    assert.equal((await post("confirm", { ...input, existingId: null })).status, 400);
    const confirmed = await post("confirm", { ...input, previewToken: "opaque", existingId: null });
    assert.equal(confirmed.status, 200);
    ConfirmZohoRecruitImportResponse.parse(await confirmed.json());
    assert.deepEqual(calls, ["preview", "confirm"]);
    const applicantsBase = base.replace("/imports", "");
    const bad = await fetch(`${applicantsBase}/applicants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, jobId: id, page: 1, confirm: false }),
    });
    assert.equal(bad.status, 400);
    const good = await fetch(`${applicantsBase}/applicants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, jobId: id, page: 1, confirm: true }),
    });
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), {
      jobId: id,
      jobTitle: "Engineer",
      page: 1,
      moreRecords: false,
      applications: [{ applicationId: "999", candidateId: "888" }],
    });
    assert.deepEqual(calls, ["preview", "confirm", "applicants"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("confirmation payload requires exact selection and explicit decision", () => {
  assert.equal(
    zohoImportSelection.safeParse({ revision: "bad", kind: "job", recordId: id, confirm: true })
      .success,
    false,
  );
  assert.equal(
    zohoImportConfirmation.safeParse({
      revision: "11111111-1111-4111-8111-111111111111",
      kind: "candidate",
      recordId: id,
      confirm: true,
      previewToken: "opaque",
      existingId: null,
      email: "untrusted@example.test",
    }).success,
    false,
  );
});

test("no provider reads without current employer approval; disconnect or suspension after refresh stops before record read", async () => {
  const config = zohoOAuthConfig({
    ZOHO_CLIENT_ID: "1000.synthetic",
    ZOHO_CLIENT_SECRET: "synthetic",
    ZOHO_REDIRECT_URI: "https://app.test/api/zoho-recruit/callback",
    ZOHO_SETTINGS_URL: "https://app.test/settings/ats",
    ZOHO_DATA_CENTER: "us",
    SESSION_SECRET: "synthetic",
  })!;
  const actor = { id: "owner", tenantId: "synthetic" };
  const revision = "11111111-1111-4111-8111-111111111111";
  let row: ZohoRow = {
    tenantId: actor.tenantId,
    userId: actor.id,
    revision,
    fingerprint: config.fingerprint,
    accountRef: "account",
    companyName: "Example",
    refreshTokenEnc: "sealed",
    approvedAt: new Date(),
    updatedAt: new Date(),
    flowHash: null,
    browserHash: null,
    flowExpiresAt: null,
  };
  let active = true;
  let disconnectDuringRefresh = false;
  const calls: string[] = [];
  const store: ZohoStore = {
    get: async () => row,
    begin: async () => {
      throw Error("unreachable");
    },
    consume: async () => {
      throw Error("unreachable");
    },
    save: async () => {
      throw Error("unreachable");
    },
    approve: async () => {
      throw Error("unreachable");
    },
    disconnect: async () => {
      throw Error("unreachable");
    },
  };
  const service = zohoReviewedImport({
    store,
    config,
    unseal: () =>
      JSON.stringify({
        purpose: "zoho-recruit",
        tenantId: actor.tenantId,
        userId: actor.id,
        accountRef: row.accountRef,
        fingerprint: config.fingerprint,
        token: "synthetic-refresh",
      }),
    actorLookup: async () => {
      if (!active) throw Error("suspended");
      return actor;
    },
    providerFactory: () => ({
      readStageCatalog: async () => {
        throw Error("unexpected metadata request");
      },
      organization: async () => {
        calls.push("organization");
        return { accountRef: "account", companyName: "Example" };
      },
      refresh: async () => {
        calls.push("refresh");
        if (disconnectDuringRefresh)
          row = { ...row, revision: "22222222-2222-4222-8222-222222222222", approvedAt: null };
        return "synthetic-access";
      },
      readIntakeRecord: async () => {
        calls.push("record");
        throw Error("must not read");
      },
      searchJobApplications: async () => {
        calls.push("search");
        throw Error("must not search");
      },
      readApplication: async () => {
        throw Error("unreachable");
      },
      authorize: async () => {
        throw Error("unreachable");
      },
      probeModule: async () => {
        throw Error("unreachable");
      },
    }),
  });
  const input = { revision, kind: "job" as const, recordId: id, confirm: true as const };
  row = { ...row, approvedAt: null };
  await assert.rejects(service.preview(actor, input));
  await assert.rejects(service.applicants(actor, { revision, jobId: id, page: 1, confirm: true }));
  assert.deepEqual(calls, []);
  row = { ...row, approvedAt: new Date() };
  active = false;
  await assert.rejects(service.preview(actor, input));
  assert.deepEqual(calls, []);
  active = true;
  disconnectDuringRefresh = true;
  await assert.rejects(service.applicants(actor, { revision, jobId: id, page: 1, confirm: true }));
  await assert.rejects(service.preview(actor, input), { code: "zoho_import_review_required" });
  assert.deepEqual(calls, ["refresh"]);
});
