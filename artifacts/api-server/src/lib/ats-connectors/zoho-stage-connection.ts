import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod/v4";
import { decryptSecret } from "../crypto-secrets";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import { zohoOAuthStore, type ZohoActor } from "./zoho-oauth-store";
import {
  zohoDigest,
  zohoFailure,
  zohoOAuthConfig,
  zohoOAuthProvider,
  ZOHO_DATA_CENTERS,
} from "./zoho-oauth-provider";
import { zohoStageAuthority, type StageAuthorityContext } from "./zoho-stage-authority";
import { applicationBinding } from "./zoho-stage-metadata-policy";
import { zohoStageWriteHttp } from "./zoho-stage-write-http";
import {
  stageWriteActorSchema,
  stageWriteBindingSchema,
  stageWriteSnapshotSchema,
  type StageWriteProvider,
} from "./zoho-stage-write-core";
import type { CampaignTx } from "./zoho-interview-campaigns";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const contextSchema = z.strictObject({
  accountRef: hash,
  connectionRevision: id,
  externalCandidateId: stageWriteBindingSchema.shape.candidateId,
  externalJobId: stageWriteBindingSchema.shape.jobId,
  applicationId: stageWriteBindingSchema.shape.applicationId,
  candidateId: id,
  campaignId: id,
  recipientId: id,
  tenantId: id,
  sourceEvidenceHash: hash,
  latestReviewId: id.nullable(),
  sourceConnectionRevision: id,
  mappingRevision: id,
  custodyRevision: hash,
  configFingerprint: hash,
});

/**
 * Concrete OAuth custody + application read/write adapter, not activation.
 * Use with the durable stage executor and a verified transition-proof source.
 * All provider I/O after connection requires this adapter's SQL authority fence.
 * It supplies no proof, approval, public route or automatic dispatch.
 */
export function zohoStageConnection({
  mode = "write" as "write" | "read_only",
  store = zohoOAuthStore(),
  config = zohoOAuthConfig(),
  actorLookup = zohoEmployerAdmin,
  unseal = decryptSecret,
  providerFactory = zohoOAuthProvider,
  authority = zohoStageAuthority(),
  request = fetch,
  now = Date.now,
} = {}) {
  const accessMode = z.enum(["write", "read_only"]).parse(mode);
  return {
    async connect(rawActor: ZohoActor, rawContext: StageAuthorityContext) {
      const actor = stageWriteActorSchema.parse(rawActor);
      const c = contextSchema.parse(rawContext);
      if (!config || c.tenantId !== actor.tenantId || c.configFingerprint !== config.fingerprint)
        throw zohoFailure("zoho_connection_changed", 409);
      const region = config.region.location;
      if (
        config.region.organization !== ZOHO_DATA_CENTERS[region].organization ||
        config.region.accounts !== ZOHO_DATA_CENTERS[region].accounts ||
        config.region.api !== ZOHO_DATA_CENTERS[region].api
      )
        throw zohoFailure("zoho_region_mismatch", 409);
      const binding = {
        applicationId: c.applicationId,
        candidateId: c.externalCandidateId,
        jobId: c.externalJobId,
      };
      async function authorization() {
        const requester = await actorLookup(actor.id);
        const row = await store.get(actor);
        if (
          requester.id !== actor.id ||
          requester.tenantId !== actor.tenantId ||
          !row?.approvedAt ||
          !row.refreshTokenEnc ||
          row.tenantId !== actor.tenantId ||
          row.accountRef !== c.accountRef ||
          row.revision !== c.connectionRevision ||
          row.fingerprint !== c.configFingerprint ||
          zohoDigest(row.refreshTokenEnc) !== c.custodyRevision
        )
          throw zohoFailure("zoho_connection_changed", 409);
        const owner = await actorLookup(row.userId);
        if (owner.id !== row.userId || owner.tenantId !== actor.tenantId)
          throw zohoFailure("zoho_authority_changed", 403);
        try {
          const custody = z
            .object({
              purpose: z.literal("zoho-recruit"),
              tenantId: z.literal(actor.tenantId),
              userId: z.literal(row.userId),
              accountRef: z.literal(c.accountRef),
              fingerprint: z.literal(c.configFingerprint),
              token: z.string().min(1).max(16384),
              stageWrites: z.boolean().optional(),
            })
            .parse(JSON.parse(unseal(row.refreshTokenEnc)));
          if (accessMode === "write" && custody.stageWrites !== true)
            throw zohoFailure("zoho_stage_write_consent_required", 409);
          return {
            token: custody.token,
            approvedAt: row.approvedAt.getTime(),
            ownerId: row.userId,
          };
        } catch {
          throw zohoFailure(
            accessMode === "write"
              ? "zoho_stage_write_consent_required"
              : "zoho_connection_changed",
            409,
          );
        }
      }
      const initial = await authorization();
      async function guard() {
        const current = await authorization();
        if (
          current.token !== initial.token ||
          current.ownerId !== initial.ownerId ||
          current.approvedAt !== initial.approvedAt
        )
          throw zohoFailure("zoho_connection_changed", 409);
      }
      const remote = providerFactory(config, request);
      const token = await remote.refresh(initial.token);
      await guard();
      const organization = await remote.organization(token);
      if (organization.accountRef !== c.accountRef) throw zohoFailure("zoho_account_changed", 409);
      await guard();
      const lease = new AsyncLocalStorage<{ active: boolean; invoked: boolean }>();
      function held() {
        const current = lease.getStore();
        if (!current?.active) throw zohoFailure("zoho_stage_authority_fence_required", 409);
        return current;
      }
      function sameBinding(raw: unknown) {
        const actual = stageWriteBindingSchema.parse(raw);
        if (
          actual.applicationId !== binding.applicationId ||
          actual.candidateId !== binding.candidateId ||
          actual.jobId !== binding.jobId
        )
          throw zohoFailure("zoho_stage_application_changed", 409);
      }
      const http = zohoStageWriteHttp({ region, token, request, now });
      const provider: StageWriteProvider = {
        async read(raw) {
          held();
          sameBinding(raw);
          const result = applicationBinding(
            await remote.readApplication(token, binding.applicationId),
            binding.jobId,
            binding.applicationId,
            binding.candidateId,
          );
          held();
          return result;
        },
        async change(raw) {
          const active = held();
          // A recovery connection cannot be upgraded by a snapshot or proof.
          if (accessMode === "read_only") return "rejected";
          const snapshot = stageWriteSnapshotSchema.parse(raw);
          sameBinding(snapshot.binding);
          if (
            snapshot.actor.id !== actor.id ||
            snapshot.actor.tenantId !== actor.tenantId ||
            snapshot.scope.campaignId !== c.campaignId ||
            snapshot.scope.recipientId !== c.recipientId ||
            snapshot.accountRef !== c.accountRef ||
            snapshot.connectionRevision !== c.connectionRevision ||
            active.invoked
          )
            throw zohoFailure("zoho_stage_application_changed", 409);
          // Even a thrown or ambiguous write cannot be repeated in this fence.
          active.invoked = true;
          return http.change(snapshot);
        },
      };
      return {
        provider,
        async fence<T>(work: (tx: CampaignTx) => Promise<T>) {
          if (lease.getStore()?.active) throw zohoFailure("zoho_stage_nested_fence", 409);
          await guard();
          return authority.fence(actor, c, async (tx) => {
            const current = { active: true, invoked: false };
            try {
              // The existing fence locks custody, owner, caller, candidate
              // privacy, mapping and current evidence. No second pool reads here.
              return await lease.run(current, () => work(tx));
            } finally {
              current.active = false;
            }
          });
        },
      };
    },
  };
}
