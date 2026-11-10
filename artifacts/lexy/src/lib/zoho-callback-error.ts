const messages: Record<string, string> = {
  zoho_invalid_client:
    "Zoho rejected the application credentials. Check that the Client ID and Client Secret belong to the same application in the data center shown on this page. Do not paste credentials into chat.",
  zoho_invalid_code:
    "Zoho rejected the one-time authorization code. It may have expired or already been used. Start a fresh connection; do not refresh the callback page.",
  zoho_invalid_redirect_uri:
    "Zoho rejected the callback address. Register the exact redirect URI shown above in this Zoho application's authorized redirect URIs.",
  zoho_invalid_scope:
    "Zoho rejected the requested Recruit permissions. The application's supported scopes need to be checked before trying again.",
  zoho_access_denied:
    "Zoho authorization was declined. Start again and approve access if you want to connect.",
  zoho_token_exchange_failed:
    "Lexy could not complete the token exchange with Zoho. No authorization was saved. Start a fresh connection; if it repeats, the token endpoint response needs investigation.",
  zoho_token_or_region_invalid:
    "Zoho returned an unexpected token format or API region. It must match the data center shown on this page. The response must be checked before proceeding.",
  zoho_region_mismatch:
    "Zoho returned a different or unrecognized account data center. Lexy did not exchange the code or send credentials to that server. The configured data center and Zoho application must match this Recruit account.",
  zoho_offline_consent_required:
    "Zoho did not return the offline authorization required for this connection. Start a fresh connection and approve offline access.",
  zoho_org_scope_missing:
    "Zoho accepted authorization but did not allow the Recruit organization-details permission. No authorization was saved. The organization scope needs to be checked.",
  zoho_org_access_denied:
    "Zoho accepted authorization but denied access to Recruit organization details. Check that the signing-in user has access to the employer's Zoho Recruit organization.",
  zoho_org_token_rejected:
    "Zoho issued a token but Recruit rejected it when Lexy checked organization details. No authorization was saved. The account and region need investigation.",
  zoho_org_request_failed:
    "Zoho authorization reached the Recruit organization check, but that request failed. No authorization was saved. The Recruit endpoint or account access needs investigation.",
  zoho_organization_unverified:
    "Zoho returned organization details that Lexy could not verify. No authorization was saved. The response format needs investigation.",
  zoho_flow_invalid:
    "This connection attempt expired, was declined, or did not match this browser. Keep Lexy signed in in this tab and start a fresh connection.",
  unauthenticated:
    "Your Lexy sign-in was not available when Zoho returned. Sign in in this browser tab, then start a fresh connection.",
  zoho_employer_admin_required:
    "An administrator of this exact employer must stay signed in while connecting Zoho.",
  zoho_authority_changed:
    "Employer authorization changed during sign-in. Sign in as the employer administrator and start a fresh connection.",
  zoho_connection_changed:
    "The connection changed during authorization. Reload the connection status before starting again.",
};

export function zohoCallbackError(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("zoho") !== "error") return null;
  const reason = params.get("reason") ?? "";
  const message = Object.hasOwn(messages, reason)
    ? messages[reason]
    : "Zoho authorization was not confirmed. The earlier attempt did not retain a specific reason. Start a fresh connection to get a diagnostic result.";
  return `${message} No candidate imports were started.`;
}
