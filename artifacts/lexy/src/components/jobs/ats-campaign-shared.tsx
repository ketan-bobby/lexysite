import type {
  AtsCampaignDetail,
  AtsCampaignMember,
  AtsCampaignMemberInvitationStatus,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

export const MAX_CAMPAIGN_RECIPIENTS = 10;

export const CAMPAIGN_STATUS_LABEL: Record<AtsCampaignDetail["status"], string> = {
  review: "Awaiting review",
  approved: "Approved",
  needs_review: "Needs review",
  cancelled: "Cancelled",
  complete: "Complete",
};

const MEMBER_LABEL: Record<AtsCampaignMemberInvitationStatus, string> = {
  ready: "Ready",
  blocked: "Blocked",
  unavailable: "Unavailable",
  provider_accepted: "Accepted by provider",
  previously_sent: "Previously sent",
  review_required: "Held for review",
  simulated: "Simulated, held",
};

export const MEMBER_NOTE: Partial<Record<AtsCampaignMemberInvitationStatus, string>> = {
  provider_accepted: "Accepted by the email provider. Inbox delivery is unverified.",
  previously_sent: "An invitation already exists for this interview. No duplicate send.",
  review_required: "Outcome uncertain. Held; this attempt cannot be retried here.",
  simulated: "No real email left Lexy. Held; this attempt cannot be retried here.",
  unavailable: "Not available for invitation in this campaign.",
};

export function memberTone(s: AtsCampaignMemberInvitationStatus) {
  if (s === "provider_accepted" || s === "previously_sent")
    return "border-signal-green/40 text-signal-green";
  if (s === "review_required" || s === "simulated" || s === "blocked")
    return "border-signal-amber/50 text-signal-amber";
  if (s === "ready") return "border-primary/40 text-primary";
  return "border-border text-muted-foreground";
}

export function MemberBadge({ status }: { status: AtsCampaignMemberInvitationStatus }) {
  return (
    <Badge variant="outline" className={`rounded-full font-medium ${memberTone(status)}`}>
      {MEMBER_LABEL[status]}
    </Badge>
  );
}

export function CampaignStatusBadge({ status }: { status: AtsCampaignDetail["status"] }) {
  const tone =
    status === "complete"
      ? "border-signal-green/40 text-signal-green"
      : status === "needs_review"
        ? "border-signal-amber/50 text-signal-amber"
        : status === "cancelled"
          ? "border-border text-muted-foreground"
          : "border-primary/40 text-primary";
  return (
    <Badge variant="outline" className={`rounded-full font-medium ${tone}`}>
      {CAMPAIGN_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Members the main batch run may send to: server says ready and dispatchable. Blocked rows excluded. */
export const isRunnable = (m: AtsCampaignMember) => m.invitationStatus === "ready" && m.canDispatch;
export const isRetryableBlocked = (m: AtsCampaignMember) =>
  m.invitationStatus === "blocked" && m.canDispatch;

export function prepareSignature(
  recordIds: string[],
  planId: string,
  planHash: string,
  sourceHash: string,
) {
  return JSON.stringify([[...recordIds].sort(), planId, planHash, sourceHash]);
}

export type RunItem = {
  memberId: string;
  label: string;
  state: "sent" | "failed" | "stopped";
  message?: string;
};
