import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  offerDigest,
  offerRevision,
  offerSnapshotSchema,
  offerTermsHash,
  type OfferSnapshot,
} from "./greenhouse-offer-policy";
import {
  greenhouseOfferControls,
  offerAttemptSchema,
  type OfferControlSource,
  type OfferControlStore,
  type OfferControlProvider,
} from "./greenhouse-offer-controls";
import {
  greenhouseOfferAuthoritySchema,
  greenhouseOfferCapabilities,
  greenhouseApprovalState,
} from "./greenhouse-offer-evidence";
import { greenhouseOfferHttp, GreenhouseOfferHttpError } from "./greenhouse-offer-http";
import {
  greenhouseOfferChain,
  greenhouseOfferDraftBody,
  matchesGreenhouseOfferDraft,
} from "./greenhouse-offer-wire";
import {
  checkedGreenhouseEmployerReview,
  checkedGreenhouseOfferConfiguration,
} from "./greenhouse-offer-review";

const custody = z.strictObject({
  token: z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/),
  authority: greenhouseOfferAuthoritySchema,
});

/**
 * Complete internal assembly, with no default credentials, network, routes or scheduler.
 * Both readers MUST resolve authoritative server custody/review records, never request JSON.
 * The source MUST hold current staff, HR, privacy, allocation and intent authority in fence().
 */
export function greenhouseControlledOfferAssembly({
  readCustody,
  readEmployerReview,
  fetcher,
  now = Date.now,
  timeoutMs = 10000,
}: {
  readCustody(s: OfferSnapshot, signal: AbortSignal): Promise<z.infer<typeof custody>>;
  readEmployerReview(s: OfferSnapshot, signal: AbortSignal): Promise<unknown>;
  fetcher: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new GreenhouseOfferHttpError();
  return function controls(source: OfferControlSource, store: OfferControlStore) {
    async function review(s: OfferSnapshot, readOnly = false, parent?: AbortSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      parent?.addEventListener("abort", abort, { once: true });
      if (parent?.aborted) abort();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        const fail = () => reject(new GreenhouseOfferHttpError());
        controller.signal.addEventListener("abort", fail, { once: true });
        if (controller.signal.aborted) fail();
        timer = setTimeout(() => {
          abort();
          fail();
        }, timeoutMs);
      });
      try {
        const value = await Promise.race([
          readEmployerReview(structuredClone(s), controller.signal),
          deadline,
        ]);
        controller.signal.throwIfAborted();
        return checkedGreenhouseEmployerReview(s, value, now(), readOnly);
      } catch {
        throw new GreenhouseOfferHttpError();
      } finally {
        clearTimeout(timer!);
        parent?.removeEventListener("abort", abort);
        abort();
      }
    }
    async function claimed(s: OfferSnapshot, state: "claimed" | "draft_created") {
      const row = offerAttemptSchema.parse(await store.latest(s.actor, s.scope));
      if (
        row.state !== state ||
        row.revision !== offerRevision(s) ||
        row.tenantId !== s.actor.tenantId ||
        row.scope.workflowId !== s.scope.workflowId ||
        row.accountRef !== s.accountRef ||
        row.connectionRevision !== s.connectionRevision ||
        row.bindingHash !== offerDigest(s.binding) ||
        row.termsHash !== offerTermsHash(s) ||
        row.preparedBy !== s.termsOwnerId ||
        row.approvedBy !== s.approverId ||
        s.actor.id !== s.submitterId ||
        !row.executionRequestId
      )
        throw new GreenhouseOfferHttpError();
      return row;
    }
    const http = greenhouseOfferHttp({
      fetcher,
      now,
      timeoutMs,
      authorize: async (s, operation, signal, target) => {
        const c = custody.parse(await readCustody(structuredClone(s), signal));
        signal.throwIfAborted();
        const cap = greenhouseOfferCapabilities(s, c.authority, now());
        const write = operation === "create" || operation === "approval-request";
        if (
          write &&
          !c.authority.grantedScopes.includes("harvest:approval_flows:request_approvals")
        )
          throw new GreenhouseOfferHttpError();
        const r = write ? await review(s, false, signal) : null;
        const claim = write
          ? await claimed(s, operation === "create" ? "claimed" : "draft_created")
          : null;
        signal.throwIfAborted();
        if (
          operation === "approval-request" &&
          (!target || claim!.receiptHash !== offerDigest(greenhouseOfferChain(target.offer)))
        )
          throw new GreenhouseOfferHttpError();
        return {
          tenantId: s.actor.tenantId,
          accountRef: s.accountRef,
          connectionRevision: s.connectionRevision,
          expectedRevision: offerRevision(s),
          expiresAt: c.authority.expiresAt,
          privateOfferReadVerified: true,
          authority: c.authority,
          approvalReadVerified: cap.approvalReadVerified,
          offerCreateVerified: cap.offerCreateVerified,
          claimedAttemptId: claim?.id ?? null,
          reviewedBodyHash: r ? offerDigest(greenhouseOfferDraftBody(s, r.currencyDigits)) : null,
          approvalTargetHash: operation === "approval-request" ? offerDigest(target) : null,
          currencyDigits: r?.currencyDigits ?? {},
          token: c.token,
        };
      },
    });
    async function remote(s: OfferSnapshot) {
      const row = await http.readCurrent(s);
      if (!row)
        return {
          row,
          observation: {
            accountRef: s.accountRef,
            binding: s.binding,
            chain: null,
            termsHash: null,
            approvalState: "none" as const,
          },
        };
      const job = await http.readApprovalFlow(s, "job");
      const flow = await http.readApprovalFlow(s, "offer", row);
      const after = await http.readCurrent(s);
      if (!after || offerDigest(row) !== offerDigest(after)) throw new GreenhouseOfferHttpError();
      const r = await review(s, true);
      const jobState = greenhouseApprovalState(job),
        state = greenhouseApprovalState(flow);
      const jobApproved = jobState === "approved" || (!job && r.jobApprovalNotRequiredVerified);
      if (!jobApproved || state === "unverified") throw new GreenhouseOfferHttpError();
      const exact =
        row.status === "Created" &&
        row.sent_on === null &&
        row.resolved_at === null &&
        matchesGreenhouseOfferDraft(row, greenhouseOfferDraftBody(s, r.currencyDigits));
      return {
        row,
        observation: {
          accountRef: s.accountRef,
          binding: s.binding,
          chain: greenhouseOfferChain(row),
          termsHash: exact ? offerTermsHash(s) : null,
          approvalState: state,
        },
      };
    }
    const provider: OfferControlProvider = {
      read: async (s) => (await remote(s)).observation,
      submitForApproval: async (s) => {
        const before = await remote(s);
        if (
          offerDigest(before.observation.chain) !== offerDigest(s.existingChain) ||
          before.observation.approvalState !== s.existingApprovalState ||
          (before.row &&
            (before.row.status !== "Created" ||
              before.row.sent_on !== null ||
              before.row.resolved_at !== null))
        )
          return { status: "rejected" };
        const attempt = await claimed(s, "claimed");
        const result = await http.createOfferDraft(s);
        if (result.status !== "created") return { status: "uncertain" };
        // Commit the created-draft receipt BEFORE an approval-request side effect.
        await store.record(
          s.actor,
          attempt,
          "draft_created",
          offerDigest(greenhouseOfferChain(result.offer)),
        );
        const current = await http.readCurrent(s);
        if (!current || offerDigest(current) !== offerDigest(result.offer))
          return { status: "uncertain" };
        const job = await http.readApprovalFlow(s, "job");
        const r = await review(s);
        if (
          greenhouseApprovalState(job) !== "approved" &&
          !(!job && r.jobApprovalNotRequiredVerified)
        )
          return { status: "uncertain" };
        const flow = await http.readApprovalFlow(s, "offer", current);
        const state = greenhouseApprovalState(flow);
        if (state === "not_requested" && flow) {
          const outcome = await http.requestApprovals(s, { offer: current, flow });
          if (outcome.status !== "accepted") return { status: "uncertain" };
        } else if (state !== "pending" && state !== "approved") return { status: "uncertain" };
        const after = await remote(s);
        if (
          !after.row ||
          after.row.id !== current.id ||
          after.row.version !== current.version ||
          after.observation.termsHash !== offerTermsHash(s) ||
          !["pending", "approved"].includes(after.observation.approvalState)
        )
          return { status: "uncertain" };
        return { status: "accepted", chain: greenhouseOfferChain(after.row) };
      },
    };
    const guarded: OfferControlSource = {
      current: (actor, scope) => source.current(actor, scope),
      fence: (actor, scope, work) =>
        source.fence(actor, scope, async (raw) => {
          const s = offerSnapshotSchema.parse(raw);
          const r = await review(s);
          checkedGreenhouseOfferConfiguration(s, r, await http.readEmployerConfiguration(s));
          return work(s);
        }),
    };
    const core = greenhouseOfferControls({
      source: guarded,
      store,
      provider,
      now,
      newId: randomUUID,
    });
    const recovery = greenhouseOfferControls({ source, store, provider, now, newId: randomUUID });
    // Recovery intentionally bypasses expired financial/configuration approval:
    // fresh custody is still required, but recovery can only observe, never write.
    return Object.freeze({ ...core, recover: recovery.recover });
  };
}
