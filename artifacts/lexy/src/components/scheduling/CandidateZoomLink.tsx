import { useEffect, useRef } from "react";
import {
  getGetCandidateZoomLinkQueryKey,
  useGetCandidateZoomLink,
} from "@workspace/api-client-react";
import { Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { safeZoomJoinUrl } from "@/lib/zoom-link";

const POLL_MS = 30_000;

/** Candidate-only join link; provider receipts and manual links remain distinct. */
export function CandidateZoomLink({ scheduleId }: { scheduleId: string }) {
  const { user } = useAuth();
  const isCandidate = user?.role === "candidate";
  const key = [
    ...getGetCandidateZoomLinkQueryKey(scheduleId),
    user?.id,
    user?.role,
    user?.tenantId,
  ];
  const q = useGetCandidateZoomLink(scheduleId, {
    request: { cache: "no-store" },
    query: {
      queryKey: key,
      enabled: isCandidate,
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      refetchInterval: POLL_MS,
      refetchIntervalInBackground: false,
    },
  });
  const ref = useRef(q.refetch);
  ref.current = q.refetch;
  useEffect(() => () => undefined, []);
  if (!isCandidate) return null;
  if (q.isError) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 text-xs text-muted-foreground"
        data-testid={`status-zoom-error-${scheduleId}`}
      >
        <span>The Zoom link could not be checked.</span>
        <Button
          size="sm"
          variant="outline"
          disabled={q.isFetching}
          onClick={() => void ref.current()}
          data-testid={`button-zoom-retry-${scheduleId}`}
        >
          Retry
        </Button>
      </div>
    );
  }
  const d = q.data;
  if (q.isFetching && !d) return null;
  if (
    !d ||
    d.scheduleId !== scheduleId ||
    d.status !== "available" ||
    !(
      (d.source === "staff_provided" && d.providerVerified === false) ||
      (d.source === "zoom_api" && d.providerVerified === true)
    )
  )
    return null;
  const url = safeZoomJoinUrl(d.joinUrl);
  if (!url || q.isFetching) return null;
  return (
    <div className="flex flex-col gap-1">
      <Button asChild size="sm" className="gap-1.5" data-testid={`link-zoom-join-${scheduleId}`}>
        <a href={url} target="_blank" rel="noopener noreferrer">
          <Video className="w-3.5 h-3.5" /> Join on Zoom
        </a>
      </Button>
      <span className="text-[10px] text-muted-foreground">
        {d.source === "zoom_api"
          ? "Meeting created through the host’s Zoom account. Your invitation is separate."
          : "Link provided by your recruiter team. Not verified by Zoom."}
      </span>
    </div>
  );
}
