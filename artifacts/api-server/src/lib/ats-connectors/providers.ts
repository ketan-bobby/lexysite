import { atsSystemKey } from "./records";

/**
 * Describes the supported integration target, never its connection health.
 * Other vendors need their own adapter; a universal connector is not a
 * universal vendor API. Unknown/manual systems remain valid manual handoffs.
 */
const greenhouse = Object.freeze({
  key: "greenhouse" as const,
  apiVersion: "harvest_v3" as const,
  partnerAuthorization: "oauth_authorization_code" as const,
  customAuthorization: "oauth_client_credentials" as const,
  recordReadScopes: Object.freeze([
    "harvest:jobs:list",
    "harvest:candidates:list",
    "harvest:applications:list",
  ]),
  capabilities: Object.freeze({
    recordVerification: "read_only" as const,
    synchronization: false,
    externalWrites: false,
    offerAutomation: false,
  }),
});

export function atsProviderDefinition(system: string): typeof greenhouse | null {
  return atsSystemKey(system) === greenhouse.key ? greenhouse : null;
}
