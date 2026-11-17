import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";
import {
  offerActorSchema,
  offerScopeSchema,
  offerBindingSchema,
  offerSnapshotSchema,
  offerCommandSchema,
  offerRevision,
  offerTermsHash,
  offerDigest,
  offerBlocker,
  offerHash,
  type OfferActor,
  type OfferScope,
  type OfferSnapshot,
} from "./greenhouse-offer-policy";

export const offerAttemptSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.string(),
  scope: offerScopeSchema,
  revision: offerHash,
  termsHash: offerHash,
  bindingHash: offerHash,
  accountRef: offerHash,
  connectionRevision: z.string(),
  state: z.enum([
    "prepared",
    "approved",
    "claimed",
    "draft_created",
    "provider_accepted",
    "verified_submission",
    "not_sent",
    "review_required",
    "observed_match",
    "observed_other",
  ]),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
  prepareRequestId: z.uuid(),
  executionRequestId: z.uuid().nullable(),
  receiptHash: offerHash.nullable(),
});
export type OfferAttempt = z.infer<typeof offerAttemptSchema>;
export interface OfferControlStore {
  prepare(row: OfferAttempt): Promise<OfferAttempt>;
  approve(
    actor: OfferActor,
    scope: OfferScope,
    id: string,
    revision: string,
  ): Promise<OfferAttempt>;
  get(actor: OfferActor, scope: OfferScope, id: string): Promise<OfferAttempt | null>;
  latest(actor: OfferActor, scope: OfferScope): Promise<OfferAttempt | null>;
  /** Commit a durable, atomic claim before acquired:true; unresolved outcomes never expire into retries. */
  claim(
    actor: OfferActor,
    scope: OfferScope,
    id: string,
    revision: string,
    requestId: string,
  ): Promise<{ acquired: boolean; attempt: OfferAttempt }>;
  record(
    actor: OfferActor,
    attempt: OfferAttempt,
    state: OfferAttempt["state"],
    receiptHash?: string,
  ): Promise<OfferAttempt>;
}
const chain = offerSnapshotSchema.shape.existingChain;
export const offerObservationSchema = z.strictObject({
  accountRef: offerHash,
  binding: offerBindingSchema,
  chain,
  termsHash: offerHash.nullable(),
  approvalState: z.enum(["none", "not_requested", "pending", "approved", "rejected"]),
});
type Observation = z.infer<typeof offerObservationSchema>;
export interface OfferControlSource {
  current(actor: OfferActor, scope: OfferScope): Promise<OfferSnapshot>;
  /** Must revalidate and hold staff, HR, privacy, source and custody authority. */
  fence<T>(
    actor: OfferActor,
    scope: OfferScope,
    work: (s: OfferSnapshot) => Promise<T>,
  ): Promise<T>;
}
export interface OfferControlProvider {
  read(s: OfferSnapshot): Promise<Observation>;
  /** Draft/approval submission ONLY; candidate delivery must never be a side effect. */
  submitForApproval(
    s: OfferSnapshot,
  ): Promise<
    | { status: "accepted"; chain: NonNullable<Observation["chain"]> }
    | { status: "rejected" | "uncertain" }
  >;
}
const changed = () =>
  new CalendarError(
    409,
    "greenhouse_offer_changed",
    "Reload and review the exact offer intent again.",
  );

/** Internal protocol with mandatory injected dependencies. No routes, tokens or default transport. */
export function greenhouseOfferControls({
  source,
  store,
  provider,
  now = Date.now,
  newId,
}: {
  source: OfferControlSource;
  store: OfferControlStore;
  provider: OfferControlProvider;
  now?: () => number;
  newId: () => string;
}) {
  function checked(raw: OfferSnapshot, actor: OfferActor, scope: OfferScope) {
    const s = offerSnapshotSchema.parse(raw);
    if (
      s.actor.id !== actor.id ||
      s.actor.tenantId !== actor.tenantId ||
      s.scope.workflowId !== scope.workflowId
    )
      throw new CalendarError(404, "not_found", "This offer intent is unavailable.");
    return s;
  }
  async function current(actor: OfferActor, scope: OfferScope) {
    offerActorSchema.parse(actor);
    offerScopeSchema.parse(scope);
    return checked(await source.current(actor, scope), actor, scope);
  }
  function ready(s: OfferSnapshot, revision: string) {
    if (offerRevision(s) !== revision) throw changed();
    const blocker = offerBlocker(s, now());
    if (blocker)
      throw new CalendarError(409, blocker, "The employer's offer requirements are not satisfied.");
  }
  function role(s: OfferSnapshot, key: "termsOwnerId" | "approverId" | "submitterId") {
    if (s.actor.id !== s[key])
      throw new CalendarError(
        403,
        "hr_authority_required",
        "The designated human must perform this action.",
      );
  }
  async function attempt(actor: OfferActor, scope: OfferScope, id: string) {
    z.uuid().parse(id);
    const row = await store.get(actor, scope, id);
    if (!row) throw new CalendarError(404, "not_found", "This offer intent is unavailable.");
    return offerAttemptSchema.parse(row);
  }
  function matches(row: OfferAttempt, s: OfferSnapshot) {
    if (
      row.tenantId !== s.actor.tenantId ||
      row.scope.workflowId !== s.scope.workflowId ||
      row.accountRef !== s.accountRef ||
      row.connectionRevision !== s.connectionRevision ||
      row.bindingHash !== offerDigest(s.binding)
    )
      throw changed();
  }
  function observation(raw: Observation, s: OfferSnapshot) {
    const value = offerObservationSchema.parse(raw);
    if (value.accountRef !== s.accountRef || offerDigest(value.binding) !== offerDigest(s.binding))
      throw changed();
    return value;
  }
  return {
    async preview(actor: OfferActor, scope: OfferScope) {
      const s = await current(actor, scope);
      return {
        revision: offerRevision(s),
        termsHash: offerTermsHash(s),
        blocker: offerBlocker(s, now()),
      };
    },
    async prepare(actor: OfferActor, scope: OfferScope, raw: z.infer<typeof offerCommandSchema>) {
      const input = offerCommandSchema.parse(raw);
      await current(actor, scope);
      return source.fence(actor, scope, async (locked) => {
        const s = checked(locked, actor, scope);
        ready(s, input.expectedRevision);
        role(s, "termsOwnerId");
        return store.prepare(
          offerAttemptSchema.parse({
            id: newId(),
            tenantId: actor.tenantId,
            scope,
            revision: offerRevision(s),
            termsHash: offerTermsHash(s),
            bindingHash: offerDigest(s.binding),
            accountRef: s.accountRef,
            connectionRevision: s.connectionRevision,
            state: "prepared",
            preparedBy: actor.id,
            approvedBy: null,
            prepareRequestId: input.requestId,
            executionRequestId: null,
            receiptHash: null,
          }),
        );
      });
    },
    async approve(
      actor: OfferActor,
      scope: OfferScope,
      id: string,
      raw: z.infer<typeof offerCommandSchema>,
    ) {
      const input = offerCommandSchema.parse(raw);
      await current(actor, scope);
      return source.fence(actor, scope, async (locked) => {
        const s = checked(locked, actor, scope);
        ready(s, input.expectedRevision);
        role(s, "approverId");
        const row = await attempt(actor, scope, id);
        matches(row, s);
        if (row.revision !== input.expectedRevision) throw changed();
        return store.approve(actor, scope, id, row.revision);
      });
    },
    async submit(
      actor: OfferActor,
      scope: OfferScope,
      id: string,
      raw: z.infer<typeof offerCommandSchema>,
    ) {
      const input = offerCommandSchema.parse(raw);
      const s = await current(actor, scope);
      ready(s, input.expectedRevision);
      role(s, "submitterId");
      const prior = await attempt(actor, scope, id);
      matches(prior, s);
      if (prior.revision !== input.expectedRevision || prior.approvedBy !== s.approverId)
        throw changed();
      const claim = await store.claim(actor, scope, id, prior.revision, input.requestId);
      let row = offerAttemptSchema.parse(claim.attempt);
      matches(row, s);
      if (row.id !== id || row.revision !== prior.revision || row.approvedBy !== s.approverId)
        throw changed();
      if (!claim.acquired) return row;
      if (row.state !== "claimed" || row.executionRequestId !== input.requestId) throw changed();
      let invoked = false;
      try {
        return await source.fence(actor, scope, async (locked) => {
          const fresh = checked(locked, actor, scope);
          ready(fresh, input.expectedRevision);
          role(fresh, "submitterId");
          const before = observation(await provider.read(fresh), fresh);
          if (
            offerDigest(before.chain) !== offerDigest(fresh.existingChain) ||
            before.approvalState !== fresh.existingApprovalState
          )
            throw changed();
          // Matching existing terms are not attributable to this new attempt.
          if (before.chain && before.termsHash === row.termsHash)
            return store.record(actor, row, "not_sent");
          ready(fresh, input.expectedRevision);
          invoked = true;
          const result = await provider.submitForApproval(fresh);
          if (result.status !== "accepted") return store.record(actor, row, "review_required");
          const acceptedChain = offerSnapshotSchema.shape.existingChain
            .unwrap()
            .parse(result.chain);
          row = await store.record(actor, row, "provider_accepted", offerDigest(acceptedChain));
          const after = observation(await provider.read(fresh), fresh);
          const verified =
            offerDigest(after.chain) === offerDigest(acceptedChain) &&
            after.termsHash === row.termsHash &&
            ["pending", "approved"].includes(after.approvalState);
          return store.record(actor, row, verified ? "verified_submission" : "review_required");
        });
      } catch {
        return store.record(actor, row, invoked ? "review_required" : "not_sent");
      }
    },
    async recover(actor: OfferActor, scope: OfferScope, id: string) {
      const s = await current(actor, scope);
      if (!s.canReadRemote) throw changed();
      const row = await attempt(actor, scope, id);
      matches(row, s);
      if (["prepared", "approved"].includes(row.state)) throw changed();
      if (["verified_submission", "not_sent"].includes(row.state)) return row;
      return source.fence(actor, scope, async (locked) => {
        const fresh = checked(locked, actor, scope);
        matches(row, fresh);
        if (!fresh.canReadRemote) throw changed();
        const remote = observation(await provider.read(fresh), fresh);
        return store.record(
          actor,
          row,
          remote.chain && remote.termsHash === row.termsHash ? "observed_match" : "observed_other",
        );
      });
    },
  };
}
