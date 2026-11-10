import { test } from "node:test";
import assert from "node:assert/strict";
import { guardedOutreachMail, isUncertainMailReason, heldMailError } from "./outreach-mail-attempt";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { SendEmailResult } from "./email";

test("the actual first-touch boundary preserves held history before invalid-email validation", async () => {
  const source = ts.createSourceFile(
    "outreach-dispatch.ts",
    readFileSync(new URL("./outreach-dispatch.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = source.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "sendFirstTouch",
  );
  assert.ok(fn);
  const code = ts.transpileModule(fn.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const failedReason of [
    "provider_outcome_uncertain:old-claim",
    "Outlook outcome uncertain. Review.",
  ]) {
    let reads = 0,
      writes = 0,
      validations = 0;
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => {
        reads++;
        return [
          {
            jobId: "job",
            candidateId: "candidate",
            tenantId: "tenant",
            status: "failed",
            failedReason,
          },
        ];
      },
    };
    const db = {
      select: () => chain,
      update: () => {
        writes++;
        throw Error("must not overwrite a held row");
      },
    };
    const invoke = new Function(
      "db",
      "outreachMessagesTable",
      "eq",
      "isUncertainMailReason",
      "heldMailError",
      "isRealEmail",
      `${code};return sendFirstTouch;`,
    )(
      db,
      {},
      () => null,
      isUncertainMailReason,
      heldMailError,
      () => {
        validations++;
        return false;
      },
    );
    const result = await invoke("message", "body", "subject", undefined);
    assert.equal(result.ok, false);
    assert.equal(result.error, heldMailError);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    assert.equal(validations, 0);
  }
});
function fixture() {
  let marker: string | null = null,
    sends = 0;
  return {
    get marker() {
      return marker;
    },
    get sends() {
      return sends;
    },
    claim: async (value: string) => {
      if (marker) return false;
      marker = value;
      return true;
    },
    invoke: async () => {
      sends++;
      return { ok: true } as SendEmailResult;
    },
    finish: async (_result: SendEmailResult, value: string, held: boolean) => {
      if (marker !== value) return false;
      if (!held) marker = null;
      return true;
    },
  };
}
test("only one concurrent caller can dispatch through the persisted claim", async () => {
  const f = fixture();
  let complete: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const invoke = async () => {
    await wait;
    return f.invoke();
  };
  const first = guardedOutreachMail({ ...f, invoke });
  await Promise.resolve();
  const second = await guardedOutreachMail({ ...f, invoke });
  assert.equal(second.reviewRequired, true);
  assert.equal(f.sends, 0);
  complete();
  assert.equal((await first).ok, true);
  assert.equal(f.sends, 1);
});
test("unknown results retain a hold and cannot be claimed again", async () => {
  const f = fixture();
  const result = await guardedOutreachMail({
    ...f,
    invoke: async () => ({ ok: false, reviewRequired: true, error: "private provider text" }),
  });
  assert.equal(result.reviewRequired, true);
  assert.ok(isUncertainMailReason(f.marker));
  assert.ok(!result.error?.includes("private"));
  assert.equal((await guardedOutreachMail(f)).reviewRequired, true);
  assert.equal(f.sends, 0);
});
test("throw after acceptance or bookkeeping failure retains the original claim", async () => {
  for (const invoke of [
    async (): Promise<SendEmailResult> => {
      throw Error("post-send bookkeeping failed");
    },
    async (): Promise<SendEmailResult> => ({ ok: true, acceptance: "accepted" }),
  ]) {
    const f = fixture();
    const result = await guardedOutreachMail({
      ...f,
      invoke,
      finish: async () => {
        throw Error("write failed");
      },
    });
    assert.equal(result.reviewRequired, true);
    assert.ok(isUncertainMailReason(f.marker));
    assert.equal((await guardedOutreachMail(f)).reviewRequired, true);
    assert.equal(f.sends, 0);
  }
});
test("claim write failure or lost claim never calls the provider", async () => {
  for (const claim of [
    async () => false,
    async (): Promise<boolean> => {
      throw Error("claim unavailable");
    },
  ]) {
    const f = fixture();
    assert.equal((await guardedOutreachMail({ ...f, claim })).reviewRequired, true);
    assert.equal(f.sends, 0);
  }
});
test("known rejection and non-attempt remain eligible for the ordinary retry policy", async () => {
  for (const acceptance of ["rejected", "not_attempted"] as const) {
    const f = fixture();
    const result = await guardedOutreachMail({
      ...f,
      invoke: async () => ({ ok: false, acceptance, error: "known rejection" }),
    });
    assert.equal(result.error, "known rejection");
    assert.equal(f.marker, null);
    assert.equal((await guardedOutreachMail(f)).ok, true);
    assert.equal(f.sends, 1);
  }
});
test("legacy uncertain Outlook text is held, ordinary errors and null are not invented holds", () => {
  for (const value of ["provider_outcome_uncertain:old", "Outlook outcome uncertain. Review it."])
    assert.equal(isUncertainMailReason(value), true);
  for (const value of [null, undefined, "known rejection"])
    assert.equal(isUncertainMailReason(value), false);
});
test("ambiguous unclassified failures remain held, even without the new review flag", async () => {
  const f = fixture();
  assert.equal(
    (
      await guardedOutreachMail({
        ...f,
        invoke: async () => ({ ok: false, error: "legacy failure" }),
      })
    ).reviewRequired,
    true,
  );
  assert.ok(f.marker);
});
