import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";

// Deployment-selected, fixed origins only. Never follow callback-supplied hosts.
export const ZOHO_DATA_CENTERS = {
  in: {
    location: "in",
    label: "India",
    accounts: "https://accounts.zoho.in",
    api: "https://www.zohoapis.in",
    organization: "https://recruit.zoho.in",
  },
  us: {
    location: "us",
    label: "United States",
    accounts: "https://accounts.zoho.com",
    api: "https://www.zohoapis.com",
    organization: "https://recruit.zoho.com",
  },
} as const;
export const ZOHO_SCOPES = [
  "ZohoRecruit.org.all",
  "ZohoRECRUIT.modules.candidate.READ",
  "ZohoRECRUIT.modules.jobopening.READ",
  "ZohoRECRUIT.modules.application.READ",
  "ZohoRecruit.search.READ",
] as const;
export const ZOHO_READ_MODULES = ["Job_Openings", "Candidates", "Applications"] as const;
export const zohoDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export const zohoFailure = (code = "zoho_unavailable", status = 503) =>
  new CalendarError(status, code, "Zoho Recruit could not be confirmed. Reload and try again.");
// Only these constants may leave the callback or enter logs. Never log a
// provider body, authorization code, state, token, cookie or exception message.
const callbackReasons = new Set([
  "zoho_invalid_client",
  "zoho_invalid_code",
  "zoho_invalid_redirect_uri",
  "zoho_invalid_scope",
  "zoho_access_denied",
  "zoho_token_exchange_failed",
  "zoho_token_or_region_invalid",
  "zoho_region_mismatch",
  "zoho_offline_consent_required",
  "zoho_org_scope_missing",
  "zoho_org_access_denied",
  "zoho_org_token_rejected",
  "zoho_org_request_failed",
  "zoho_module_scope_missing",
  "zoho_module_access_denied",
  "zoho_module_token_rejected",
  "zoho_module_unsupported",
  "zoho_module_request_failed",
  "zoho_organization_unverified",
  "zoho_flow_invalid",
  "zoho_employer_admin_required",
  "zoho_authority_changed",
  "zoho_connection_changed",
  "unauthenticated",
]);
export function zohoCallbackReason(error: unknown): string {
  return error instanceof CalendarError && callbackReasons.has(error.code)
    ? error.code
    : "zoho_unavailable";
}
export type ZohoOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  settingsUrl: string;
  fingerprint: string;
  region: (typeof ZOHO_DATA_CENTERS)[keyof typeof ZOHO_DATA_CENTERS];
};
export function zohoOAuthConfig(env = process.env): ZohoOAuthConfig | null {
  const clientId = env.ZOHO_CLIENT_ID?.trim();
  const clientSecret = env.ZOHO_CLIENT_SECRET?.trim();
  const redirectUri = env.ZOHO_REDIRECT_URI?.trim();
  const settingsUrl = env.ZOHO_SETTINGS_URL?.trim();
  const dataCenter = env.ZOHO_DATA_CENTER?.trim() || "in";
  if (dataCenter !== "in" && dataCenter !== "us") return null;
  const region = ZOHO_DATA_CENTERS[dataCenter];
  if (!clientId || !clientSecret || !redirectUri || !settingsUrl || !env.SESSION_SECRET)
    return null;
  try {
    if (!/^1000\.[A-Za-z0-9]+$/.test(clientId)) return null;
    const callback = new URL(redirectUri);
    const settings = new URL(settingsUrl);
    for (const url of [callback, settings])
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        return null;
    if (
      callback.pathname !== "/api/zoho-recruit/callback" ||
      !settings.pathname.endsWith("/settings/ats")
    )
      return null;
    return {
      clientId,
      clientSecret,
      redirectUri,
      settingsUrl,
      region,
      fingerprint: zohoDigest(
        JSON.stringify([clientId, clientSecret, redirectUri, settingsUrl, ZOHO_SCOPES, region]),
      ),
    };
  } catch {
    return null;
  }
}
export function zohoConsent(
  config: ZohoOAuthConfig,
  state: string,
  includeStageMetadata = false,
  includeInterviewNotes = false,
  includeStageWrites = false,
) {
  const url = new URL(`${config.region.accounts}/oauth/v2/auth`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: [
      ...ZOHO_SCOPES,
      ...(includeStageMetadata ? ["ZohoRecruit.settings.stage.READ"] : []),
      ...(includeInterviewNotes ? ["ZohoRecruit.modules.notes.CREATE"] : []),
      ...(includeStageWrites ? ["ZohoRecruit.modules.candidate.UPDATE"] : []),
    ].join(","),
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}
/** Bounded response reader shared by token and metadata requests. No raw failures escape. */
async function json(response: Response): Promise<unknown> {
  if (!response.body || response.redirected) throw zohoFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 128_000) throw zohoFailure();
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw zohoFailure();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function zohoOAuthProvider(config: ZohoOAuthConfig, request: typeof fetch = fetch) {
  async function send(url: string, init: RequestInit, stage: "token" | "org" | "module") {
    const fallback =
      stage === "token" ? "zoho_token_exchange_failed" : `zoho_${stage}_request_failed`;
    try {
      const response = await request(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (stage === "module" && response.status === 204 && !response.redirected)
        return { data: [] };
      const body = await json(response);
      const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const providerCode =
        typeof fields.error === "string"
          ? fields.error
          : typeof fields.code === "string"
            ? fields.code
            : "";
      const known =
        stage === "token"
          ? ({
              invalid_client: "zoho_invalid_client",
              invalid_client_secret: "zoho_invalid_client",
              invalid_code: "zoho_invalid_code",
              invalid_redirect_uri: "zoho_invalid_redirect_uri",
              invalid_scope: "zoho_invalid_scope",
              access_denied: "zoho_access_denied",
            } as Record<string, string>)
          : ({
              OAUTH_SCOPE_MISMATCH: `zoho_${stage}_scope_missing`,
              INVALID_OAUTHSCOPE: `zoho_${stage}_scope_missing`,
              NO_PERMISSION: `zoho_${stage}_access_denied`,
              AUTHORIZATION_FAILED: `zoho_${stage}_access_denied`,
              INVALID_TOKEN: `zoho_${stage}_token_rejected`,
              AUTHENTICATION_FAILURE: `zoho_${stage}_token_rejected`,
              ...(stage === "module"
                ? {
                    INVALID_MODULE: "zoho_module_unsupported",
                    NOT_SUPPORTED: "zoho_module_unsupported",
                  }
                : {}),
            } as Record<string, string>);
      const reason = Object.hasOwn(known, providerCode) ? known[providerCode] : undefined;
      if (reason) throw zohoFailure(reason, 409);
      if (!response.ok || providerCode) throw zohoFailure(fallback);
      return body;
    } catch (error) {
      if (error instanceof CalendarError && zohoCallbackReason(error) !== "zoho_unavailable")
        throw error;
      throw zohoFailure(fallback);
    }
  }
  async function tokens(parameters: Record<string, string>) {
    const body = await send(
      `${config.region.accounts}/oauth/v2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...parameters,
        }),
      },
      "token",
    );
    const parsed = z
      .object({
        access_token: z.string().min(1).max(16384),
        refresh_token: z.string().min(1).max(16384).optional(),
        api_domain: z.literal(config.region.api),
        token_type: z.literal("Bearer"),
        expires_in: z.number().int().min(1).max(86400),
      })
      .safeParse(body);
    if (!parsed.success) throw zohoFailure("zoho_token_or_region_invalid", 409);
    return parsed.data;
  }
  async function organization(accessToken: string) {
    const result = await send(
      `${config.region.organization}/recruit/v2/org`,
      {
        method: "GET",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      },
      "org",
    );
    const org = z
      .object({
        org: z
          .array(
            z.object({
              primary_userid: z.string().regex(/^[1-9]\d{0,39}$/),
              company_name: z.string().trim().min(1).max(255),
            }),
          )
          .length(1),
      })
      .safeParse(result);
    if (!org.success) throw zohoFailure("zoho_organization_unverified", 409);
    return {
      companyName: org.data.org[0].company_name,
      // Primary-user reference, NOT a claimed immutable Zoho organization ID.
      accountRef: zohoDigest(`${config.region.api}|${org.data.org[0].primary_userid}`),
    };
  }
  return {
    organization,
    async readIntakeRecord(accessToken: string, kind: "job" | "candidate", id: string) {
      if (!/^[1-9]\d{0,39}$/.test(id) || !["job", "candidate"].includes(kind))
        throw zohoFailure("zoho_module_request_failed", 400);
      const module = kind === "job" ? "Job_Openings" : "Candidates";
      const fields =
        kind === "job"
          ? "id,Posting_Title,Job_Description,City,Job_Opening_Status"
          : "id,First_Name,Last_Name,Email,Email_Opt_Out";
      const url = new URL(`${config.region.organization}/recruit/v2/${module}/${id}`);
      url.searchParams.set("fields", fields);
      return send(
        url.toString(),
        {
          method: "GET",
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        },
        "module",
      );
    },
    async searchJobApplications(accessToken: string, jobId: string, page: number) {
      if (!/^[1-9]\d{0,39}$/.test(jobId) || !Number.isInteger(page) || page < 1 || page > 100)
        throw zohoFailure("zoho_module_request_failed", 400);
      const url = new URL(`${config.region.organization}/recruit/v2/Applications/search`);
      url.search = new URLSearchParams({
        criteria: `($Job_Opening_Id:equals:${jobId})`,
        page: String(page),
        per_page: "25",
        approved: "both",
        converted: "both",
      }).toString();
      return send(
        url.toString(),
        {
          method: "GET",
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        },
        "module",
      );
    },
    async readApplication(accessToken: string, id: string) {
      if (!/^[1-9]\d{0,39}$/.test(id)) throw zohoFailure("zoho_module_request_failed", 400);
      const url = new URL(`${config.region.organization}/recruit/v2/Applications/${id}`);
      url.searchParams.set(
        "fields",
        "id,$Job_Opening_Id,$Candidate_Id,Job_Opening_Name,Candidate_Name,Application_Status",
      );
      return send(
        url.toString(),
        { method: "GET", headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
        "module",
      );
    },
    async readStageCatalog(accessToken: string, page: number) {
      if (!Number.isInteger(page) || page < 1 || page > 10)
        throw zohoFailure("zoho_module_request_failed", 400);
      const url = new URL(`${config.region.organization}/recruit/v2/settings/stages`);
      url.search = new URLSearchParams({ page: String(page), per_page: "200" }).toString();
      return send(
        url.toString(),
        {
          method: "GET",
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        },
        "module",
      );
    },
    async refresh(refreshToken: string) {
      const token = await tokens({ grant_type: "refresh_token", refresh_token: refreshToken });
      return token.access_token;
    },
    async probeModule(accessToken: string, module: (typeof ZOHO_READ_MODULES)[number]) {
      if (!ZOHO_READ_MODULES.includes(module)) throw zohoFailure("zoho_module_unsupported", 400);
      const url = new URL(`${config.region.organization}/recruit/v2/${module}`);
      url.search = new URLSearchParams({ fields: "id", page: "1", per_page: "1" }).toString();
      const result = await send(
        url.toString(),
        {
          method: "GET",
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        },
        "module",
      );
      const parsed = z
        .object({
          data: z.array(z.object({ id: z.string().regex(/^[1-9]\d{0,39}$/) })).max(1),
        })
        .safeParse(result);
      if (!parsed.success) throw zohoFailure("zoho_module_request_failed");
      return parsed.data.data.length ? ("readable" as const) : ("empty" as const);
    },
    async authorize(code: string) {
      const token = await tokens({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
      });
      if (!token.refresh_token) throw zohoFailure("zoho_offline_consent_required", 409);
      return { ...(await organization(token.access_token)), refreshToken: token.refresh_token };
    },
  };
}
