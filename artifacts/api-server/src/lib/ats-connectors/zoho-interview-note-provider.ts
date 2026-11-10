import { z } from "zod/v4";
import { decryptSecret } from "../crypto-secrets";
import { CalendarError } from "../outlook-calendar-core";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import { zohoOAuthStore, type ZohoActor } from "./zoho-oauth-store";
import { zohoOAuthConfig, zohoOAuthProvider, zohoFailure } from "./zoho-oauth-provider";
import { applicationBinding } from "./zoho-stage-metadata-policy";

export type NoteBinding = {
  accountRef: string;
  connectionRevision: string;
  externalCandidateId: string;
  externalJobId: string;
  applicationId: string;
};
export function zohoInterviewNoteProvider({
  store = zohoOAuthStore(),
  config = zohoOAuthConfig(),
  actorLookup = zohoEmployerAdmin,
  unseal = decryptSecret,
  providerFactory = zohoOAuthProvider,
  request = fetch,
} = {}) {
  async function authorization(actor: ZohoActor, binding: NoteBinding) {
    if (!config) throw zohoFailure("zoho_setup_required", 409);
    const row = await store.get(actor);
    const requester = await actorLookup(actor.id);
    if (
      !row?.approvedAt ||
      !row.refreshTokenEnc ||
      row.tenantId !== actor.tenantId ||
      requester.tenantId !== actor.tenantId ||
      requester.id !== actor.id ||
      row.accountRef !== binding.accountRef ||
      row.revision !== binding.connectionRevision ||
      row.fingerprint !== config.fingerprint
    )
      throw zohoFailure("zoho_connection_changed", 409);
    const owner = await actorLookup(row.userId);
    if (owner.id !== row.userId || owner.tenantId !== actor.tenantId)
      throw zohoFailure("zoho_authority_changed", 403);
    let custody;
    try {
      custody = z
        .object({
          purpose: z.literal("zoho-recruit"),
          tenantId: z.literal(actor.tenantId),
          userId: z.literal(row.userId),
          accountRef: z.literal(binding.accountRef),
          fingerprint: z.literal(config.fingerprint),
          token: z.string().min(1).max(16384),
          interviewNotes: z.literal(true),
        })
        .parse(JSON.parse(unseal(row.refreshTokenEnc)));
    } catch {
      throw new CalendarError(
        409,
        "zoho_notes_consent_required",
        "The employer must reconnect with interview-note creation permission and confirm the account. Existing read-only access is unchanged.",
      );
    }
    return { row, custody, config };
  }
  return {
    async publicationRevision(actor: ZohoActor, binding: NoteBinding): Promise<string | null> {
      const current = await store.get(actor);
      if (!current?.revision) return null;
      try {
        await authorization(actor, { ...binding, connectionRevision: current.revision });
        return current.revision;
      } catch (error) {
        if (error instanceof CalendarError && error.status === 409) return null;
        throw error;
      }
    },
    async permitted(actor: ZohoActor, binding: NoteBinding) {
      try {
        await authorization(actor, binding);
        return true;
      } catch (error) {
        if (error instanceof CalendarError && error.status === 409) return false;
        throw error;
      }
    },
    async connect(actor: ZohoActor, binding: NoteBinding) {
      const initial = await authorization(actor, binding);
      async function guard() {
        const fresh = await authorization(actor, binding);
        if (
          fresh.row.refreshTokenEnc !== initial.row.refreshTokenEnc ||
          fresh.row.userId !== initial.row.userId ||
          fresh.row.approvedAt?.getTime() !== initial.row.approvedAt?.getTime()
        )
          throw zohoFailure("zoho_connection_changed", 409);
      }
      const provider = providerFactory(initial.config);
      const token = await provider.refresh(initial.custody.token);
      await guard();
      const org = await provider.organization(token);
      if (org.accountRef !== binding.accountRef) throw zohoFailure("zoho_account_changed", 409);
      await guard();
      applicationBinding(
        await provider.readApplication(token, binding.applicationId),
        binding.externalJobId,
        binding.applicationId,
        binding.externalCandidateId,
      );
      await guard();
      return {
        guard,
        async create(title: string, content: string, authorityFenced = false): Promise<string> {
          // Caller must hold the source/account authority fence after guard().
          // Do not acquire a second pool connection while that fence is held.
          if (!authorityFenced) await guard();
          z.string().min(1).max(200).parse(title);
          z.string().min(1).max(12000).parse(content);
          // Deliberately candidate Notes: application-note creation is not established
          // by the public create-notes contract. Job/application IDs are in the text.
          // One request only, no redirects/retries; any ambiguous response is held.
          const response = await request(`${initial.config.region.organization}/recruit/v2/Notes`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(20000),
            headers: {
              Authorization: `Zoho-oauthtoken ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: [
                {
                  Note_Title: title,
                  Note_Content: content,
                  Parent_Id: binding.externalCandidateId,
                  se_module: "Candidates",
                },
              ],
            }),
          });
          if (!response.ok || response.redirected || !response.body)
            throw zohoFailure("zoho_note_outcome_uncertain", 409);
          const reader = response.body.getReader();
          let size = 0;
          const parts: Uint8Array[] = [];
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 128000) throw zohoFailure("zoho_note_outcome_uncertain", 409);
              parts.push(part.value);
            }
            const parsed = z
              .object({
                data: z
                  .array(
                    z.object({
                      code: z.literal("SUCCESS"),
                      status: z.literal("success"),
                      details: z.object({ id: z.string().regex(/^[1-9]\d{0,39}$/) }),
                    }),
                  )
                  .length(1),
              })
              .parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
            return parsed.data[0].details.id;
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        },
      };
    },
  };
}
