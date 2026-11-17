/** Test-only worker. No application bootstrap, scheduler or real delivery. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { eq, and, sql } from "drizzle-orm";
import { dbAdmin, pool, zohoInterviewCampaignsTable as campaigns } from "@workspace/db";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".html"))
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`,
      };
    return nextLoad(url, context);
  },
});

const { zohoCampaignDispatcher } = await import("../zoho-campaign-dispatch");
const { zohoReviewedImport } = await import("../zoho-reviewed-import");
type Input = {
  tenantId: string;
  campaignId: string;
  actorId: string;
  phase: "prepare" | "send" | "complete";
};
let closing: Promise<void> | undefined;
const close = () => (closing ??= pool.end());
const checkpoint = async (phase: string) => {
  await new Promise<void>((resolve, reject) => {
    process.send?.({ kind: "checkpoint", phase }, (error) => (error ? reject(error) : resolve()));
  });
  await new Promise(() => {}); // Parent deliberately kills this owned child.
};
process.once("message", (input: Input) => {
  void (async () => {
    try {
      const [identity] = (
        await dbAdmin.execute(sql`SELECT current_database() AS name, inet_server_addr() AS host`)
      ).rows;
      assert.equal(identity?.name, "heliumdb");
      assert.equal(identity?.host, null, "Only the verified local development database is allowed");
      assert.match(input.tenantId, /^zc_[a-f0-9-]{36}$/);
      assert(["prepare", "send", "complete"].includes(input.phase));
      const [campaign] = await dbAdmin
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.tenantId, input.tenantId)));
      assert(campaign);
      assert.equal(campaign.dispatchLane, "isolated_test");
      assert.equal(campaign.approvedBy, input.actorId);
      const actor = { id: input.actorId, tenantId: input.tenantId };
      let sends = 0;
      const dispatcher = zohoCampaignDispatcher({
        tenantId: input.tenantId,
        dispatchLane: "isolated_test",
        actorLookup: async () => actor,
        source: () => ({
          ...zohoReviewedImport(),
          campaignSource: async () => ({
            accountRef: campaign.accountRef,
            assertCurrent: async () => undefined,
            lockCurrent: async () => undefined,
            snapshot: async () => {
              throw Error("Unexpected snapshot access");
            },
            candidate: async (_job: string, _application: string, candidateId: string) => {
              if (input.phase === "prepare") await checkpoint("prepare");
              return {
                title: null,
                description: null,
                location: null,
                firstName: "Process",
                lastName: "Fixture",
                email: `${input.tenantId}.${candidateId}@example.test`,
              };
            },
          }),
        }),
        context: async () => ({
          companyName: "Synthetic employer",
          aiMessagingEnabled: true,
          brandBrief: "",
          roleContextBrief: "",
          docsBrief: "",
          contextSummary: "Process recovery fixture",
          sourceContext: {
            brandProfile: false,
            tenantDocs: 0,
            workorderContext: false,
            workorderDocs: 0,
          },
        }),
        send: async () => {
          sends++;
          if (input.phase === "send") await checkpoint("send");
          return { ok: true, messageId: "synthetic-process-acceptance" };
        },
      });
      const processed = await dispatcher.tick();
      process.send?.({ kind: "result", processed, sends });
      await close();
      process.disconnect?.();
    } catch {
      process.send?.({ kind: "error" });
      await close();
      process.exitCode = 1;
      process.disconnect?.();
    }
  })();
});
process.once("disconnect", () => {
  void close();
});
