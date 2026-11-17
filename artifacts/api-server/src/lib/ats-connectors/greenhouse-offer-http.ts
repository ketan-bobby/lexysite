import { z } from "zod/v4";
import {
  offerBlocker,
  offerHash,
  offerRevision,
  offerSnapshotSchema,
  type OfferSnapshot,
} from "./greenhouse-offer-policy";
import {
  boundGreenhouseOffer,
  greenhouseCurrencyDigitsSchema,
  greenhouseOfferDraftBody,
  matchesGreenhouseOfferDraft,
  type GreenhouseWireOffer,
} from "./greenhouse-offer-wire";
import { offerDigest } from "./greenhouse-offer-policy";
import {
  boundGreenhouseApprovalFlow,
  greenhouseOfferAuthoritySchema,
  greenhouseOfferCapabilities,
  type GreenhouseFlowTarget,
  type GreenhouseApprovalFlow,
} from "./greenhouse-offer-evidence";
import {
  GREENHOUSE_OFFER_CONFIGURATION_SCOPES,
  readGreenhouseOfferConfiguration,
} from "./greenhouse-offer-configuration";

const permitSchema = z.strictObject({
  tenantId: z.string().min(1),
  accountRef: offerHash,
  connectionRevision: z.string().min(1),
  expectedRevision: offerHash,
  expiresAt: z.number().int().nonnegative(),
  privateOfferReadVerified: z.literal(true),
  authority: greenhouseOfferAuthoritySchema,
  approvalReadVerified: z.boolean().optional(),
  offerCreateVerified: z.boolean(),
  claimedAttemptId: z.uuid().nullable(),
  reviewedBodyHash: offerHash.nullable(),
  approvalTargetHash: offerHash.nullable().optional(),
  currencyDigits: greenhouseCurrencyDigitsSchema,
  token: z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/),
});
export type GreenhouseOfferHttpPermit = z.infer<typeof permitSchema>;
export type GreenhouseOfferHttpOperation =
  | "read"
  | "create"
  | "approval-read-job"
  | "approval-read-offer"
  | "approval-request"
  | "configuration-read";
export type GreenhouseOfferHttpTarget = {
  offer: GreenhouseWireOffer;
  flow?: GreenhouseApprovalFlow;
};
export class GreenhouseOfferHttpError extends Error {
  constructor() {
    super("Greenhouse offer request unavailable.");
    this.name = "GreenhouseOfferHttpError";
  }
}
const MAX_BYTES = 524288;
const READ_FIELDS =
  "id,version,application_id,candidate_id,job_id,opening_id,starts_on,sent_on,resolved_at,updated_at,status,custom_fields";

/**
 * Fixed-purpose, server-only Harvest wire transport. No default fetcher, token
 * source, routes or wiring to the application. Future callers MUST use the durable
 * human-controlled claim protocol; authorize must verify that exact claim.
 * A Created draft is NOT a requested/approved approval flow or candidate delivery.
 */
export function greenhouseOfferHttp({
  authorize,
  fetcher,
  now = Date.now,
  timeoutMs = 10000,
}: {
  authorize(
    s: OfferSnapshot,
    operation: GreenhouseOfferHttpOperation,
    signal: AbortSignal,
    target?: GreenhouseOfferHttpTarget,
  ): Promise<GreenhouseOfferHttpPermit>;
  fetcher: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new GreenhouseOfferHttpError();
  const getPermit = authorize;
  const send = fetcher;
  const clock = now;
  async function request(
    raw: OfferSnapshot,
    operation: GreenhouseOfferHttpOperation,
    configurationPath?: string,
    parent?: AbortSignal,
    rawTarget?: GreenhouseOfferHttpTarget,
  ) {
    const target = rawTarget ? structuredClone(rawTarget) : undefined;
    let invoked = false;
    const controller = new AbortController();
    const signal = controller.signal;
    const abortFromParent = () => controller.abort();
    parent?.addEventListener("abort", abortFromParent, { once: true });
    if (parent?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(new GreenhouseOfferHttpError());
      signal.addEventListener("abort", rejectAbort, { once: true });
      if (signal.aborted) rejectAbort();
      timer = setTimeout(() => {
        controller.abort();
        reject(new GreenhouseOfferHttpError());
      }, timeoutMs);
    });
    function check(s: OfferSnapshot, p: GreenhouseOfferHttpPermit) {
      signal.throwIfAborted();
      const time = clock();
      const capabilities = greenhouseOfferCapabilities(s, p.authority, time);
      if (
        !Number.isFinite(time) ||
        p.authority.credentialHash !== offerDigest(p.token) ||
        !capabilities.privateOfferReadVerified ||
        p.tenantId !== s.actor.tenantId ||
        p.accountRef !== s.accountRef ||
        p.connectionRevision !== s.connectionRevision ||
        p.expectedRevision !== offerRevision(s) ||
        !s.canReadRemote ||
        (operation.startsWith("approval-read-") &&
          (!p.approvalReadVerified || !capabilities.approvalReadVerified)) ||
        (operation === "approval-read-offer" && !s.existingChain && !target) ||
        (operation === "configuration-read" &&
          (!p.approvalReadVerified ||
            !capabilities.approvalReadVerified ||
            !GREENHOUSE_OFFER_CONFIGURATION_SCOPES.every((scope) =>
              p.authority.grantedScopes.includes(scope),
            ))) ||
        p.expiresAt <= time ||
        p.expiresAt > time + 60000 ||
        ((operation === "create" || operation === "approval-request") &&
          (!p.offerCreateVerified ||
            !p.approvalReadVerified ||
            !capabilities.offerCreateVerified ||
            !p.claimedAttemptId ||
            s.actor.id !== s.submitterId ||
            offerBlocker(s, time))) ||
        (operation === "approval-request" &&
          (!target?.flow ||
            p.approvalTargetHash !== offerDigest(target) ||
            !p.authority.grantedScopes.includes("harvest:approval_flows:request_approvals")))
      )
        throw new GreenhouseOfferHttpError();
    }
    async function work() {
      const s = offerSnapshotSchema.parse(raw);
      const flowSnapshot = target
        ? {
            ...s,
            existingChain: {
              id: String(boundGreenhouseOffer(target.offer, s).id),
              version: target.offer.version,
              revision: offerDigest(target.offer),
            },
          }
        : s;
      if (operation === "approval-request") {
        const flow = boundGreenhouseApprovalFlow([target?.flow], flowSnapshot, "offer");
        if (
          !flow ||
          flow.approval_status !== "pending" ||
          flow.requested_by_id !== null ||
          target!.offer.status !== "Created" ||
          target!.offer.sent_on !== null ||
          target!.offer.resolved_at !== null
        )
          throw new GreenhouseOfferHttpError();
      }
      signal.throwIfAborted();
      if (
        operation === "configuration-read" &&
        !/^\/v3\/(?:jobs|custom_fields|custom_field_options|custom_field_offices|custom_field_departments|offices|departments|openings|offers|approval_flows)\?[A-Za-z0-9_,=&]+$/.test(
          configurationPath ?? "",
        )
      )
        throw new GreenhouseOfferHttpError();
      // A private copy prevents an asynchronous authorizer from changing intent.
      const p = permitSchema.parse(
        await getPermit(structuredClone(s), operation, signal, structuredClone(target)),
      );
      check(s, p);
      let body: string | undefined;
      if (operation === "create") {
        const draft = greenhouseOfferDraftBody(s, p.currencyDigits);
        if (offerDigest(draft) !== p.reviewedBodyHash) throw new GreenhouseOfferHttpError();
        body = JSON.stringify(draft);
        if (Buffer.byteLength(body, "utf8") > MAX_BYTES) throw new GreenhouseOfferHttpError();
      }
      if (operation === "approval-request") {
        if (
          !matchesGreenhouseOfferDraft(target!.offer, greenhouseOfferDraftBody(s, p.currencyDigits))
        )
          throw new GreenhouseOfferHttpError();
        body = "{}";
      }
      const path =
        operation === "create"
          ? "/v3/offers"
          : operation === "approval-request"
            ? `/v3/approval_flows/${target!.flow!.id}/request_approvals`
            : operation === "configuration-read"
              ? configurationPath!
              : operation === "approval-read-job"
                ? `/v3/approval_flows?job_ids=${s.binding.jobId}&approval_type=offer_job&per_page=2`
                : operation === "approval-read-offer"
                  ? `/v3/approval_flows?offer_ids=${flowSnapshot.existingChain!.id}&approval_type=offer_candidate&per_page=2`
                  : `/v3/offers?application_ids=${s.binding.applicationId}&candidate_ids=${s.binding.candidateId}&job_ids=${s.binding.jobId}&current_only=true&per_page=2&fields=${READ_FIELDS}`;
      check(s, p);
      invoked = true;
      // Exactly one fetch invocation. No 401 refresh, Retry-After retry or redirects.
      const response = await send(`https://harvest.greenhouse.io${path}`, {
        method: operation === "create" || operation === "approval-request" ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${p.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
        signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
      }
      if (operation === "approval-request") {
        if (
          response.status !== 204 ||
          response.redirected ||
          response.headers.has("Link") ||
          response.body
        ) {
          void response.body?.cancel().catch(() => {});
          throw new GreenhouseOfferHttpError();
        }
        check(s, p);
        return { row: null, flow: null, configuration: null };
      }
      if (
        response.redirected ||
        response.status !== (operation === "create" ? 201 : 200) ||
        !response.body ||
        response.headers.has("Link") ||
        !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(
          response.headers.get("Content-Type") ?? "",
        ) ||
        (response.headers.has("Content-Length") &&
          (!/^\d+$/.test(response.headers.get("Content-Length")!) ||
            Number(response.headers.get("Content-Length")) > MAX_BYTES))
      ) {
        void response.body?.cancel().catch(() => {});
        throw new GreenhouseOfferHttpError();
      }
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      let payload: unknown;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_BYTES) throw new GreenhouseOfferHttpError();
          chunks.push(part.value);
        }
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        signal.removeEventListener("abort", cancel);
        cancel();
      }
      if (operation !== "create") {
        if (operation === "configuration-read") {
          const fresh = permitSchema.parse(await getPermit(structuredClone(s), operation, signal));
          check(s, fresh);
          return { row: null, flow: null, configuration: payload };
        }
        const flowRead = operation !== "read";
        if (!Array.isArray(payload) || payload.length > 1) throw new GreenhouseOfferHttpError();
        const row = flowRead || payload.length === 0 ? null : boundGreenhouseOffer(payload[0], s);
        const flow = flowRead
          ? boundGreenhouseApprovalFlow(
              payload,
              flowSnapshot,
              operation === "approval-read-job" ? "job" : "offer",
            )
          : null;
        const fresh = permitSchema.parse(
          await getPermit(structuredClone(s), operation, signal, structuredClone(target)),
        );
        check(s, fresh);
        return { row, flow, configuration: null };
      }
      check(s, p);
      const row = boundGreenhouseOffer(payload, s);
      if (
        row.status !== "Created" ||
        row.sent_on !== null ||
        row.resolved_at !== null ||
        !matchesGreenhouseOfferDraft(row, greenhouseOfferDraftBody(s, p.currencyDigits))
      )
        throw new GreenhouseOfferHttpError();
      return { row, flow: null, configuration: null };
    }
    try {
      const result = await Promise.race([work(), deadline]);
      return { ...result, uncertain: false as const };
    } catch {
      if ((operation === "create" || operation === "approval-request") && invoked)
        return { row: null, flow: null, configuration: null, uncertain: true as const };
      throw new GreenhouseOfferHttpError();
    } finally {
      clearTimeout(timer!);
      parent?.removeEventListener("abort", abortFromParent);
      controller.abort();
    }
  }
  return Object.freeze({
    async readCurrent(s: OfferSnapshot): Promise<GreenhouseWireOffer | null> {
      return (await request(s, "read")).row;
    },
    async readApprovalFlow(
      s: OfferSnapshot,
      target: GreenhouseFlowTarget,
      offer?: GreenhouseWireOffer,
    ) {
      if (target !== "job" && target !== "offer") throw new GreenhouseOfferHttpError();
      return (
        await request(
          s,
          target === "job" ? "approval-read-job" : "approval-read-offer",
          undefined,
          undefined,
          offer ? { offer } : undefined,
        )
      ).flow;
    },
    async requestApprovals(s: OfferSnapshot, target: Required<GreenhouseOfferHttpTarget>) {
      const result = await request(s, "approval-request", undefined, undefined, target);
      return { status: result.uncertain ? ("uncertain" as const) : ("accepted" as const) };
    },
    async readEmployerConfiguration(raw: OfferSnapshot) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new GreenhouseOfferHttpError());
        }, timeoutMs);
      });
      try {
        const snapshot = offerSnapshotSchema.parse(raw);
        return await Promise.race([
          readGreenhouseOfferConfiguration(snapshot, async (path) => {
            controller.signal.throwIfAborted();
            return (await request(snapshot, "configuration-read", path, controller.signal))
              .configuration;
          }),
          deadline,
        ]);
      } catch {
        throw new GreenhouseOfferHttpError();
      } finally {
        clearTimeout(timer!);
        controller.abort();
      }
    },
    async createOfferDraft(s: OfferSnapshot) {
      const result = await request(s, "create");
      return result.uncertain
        ? { status: "uncertain" as const }
        : { status: "created" as const, offer: result.row! };
    },
  });
}
