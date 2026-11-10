import { useEffect, useRef, useState } from "react";
import {
  getCandidateGoogleMeet,
  getGetCandidateGoogleMeetQueryKey,
  useGetCandidateGoogleMeet,
} from "@workspace/api-client-react";
import { Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { readReadyMeet } from "@/lib/candidate-google-meet";

const POLL_MS = 60_000;
const JOIN_TIMEOUT_MS = 20_000;

/**
 * Candidate Join control for a confirmed native schedule. Shows a stored
 * provider acceptance plus a read-only check of the original Google event:
 * not an availability, delivery or RSVP guarantee.
 * Renders nothing unless a fresh, exactly matching, strictly safe link exists.
 */
export function CandidateGoogleMeet({
  scheduleId,
  scheduledAt,
  durationMinutes,
}: {
  scheduleId: string;
  scheduledAt: string;
  durationMinutes?: number | null;
}) {
  const { user } = useAuth();
  const isCandidate = user?.role === "candidate" && !!durationMinutes;
  const identity = `${user?.id ?? ""}|${user?.role ?? ""}|${user?.tenantId ?? ""}|${scheduleId}|${scheduledAt}|${durationMinutes ?? ""}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [joinState, setJoinState] = useState<"idle" | "checking" | "failed">("idle");
  const joinAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    setJoinState("idle");
    return () => joinAbort.current?.abort();
  }, [identity]);

  const query = useGetCandidateGoogleMeet(scheduleId, {
    request: { cache: "no-store" },
    query: {
      queryKey: [
        ...getGetCandidateGoogleMeetQueryKey(scheduleId),
        user?.id,
        user?.role,
        user?.tenantId,
        scheduledAt,
        durationMinutes,
      ],
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

  if (!isCandidate) return null;
  const expected = { scheduleId, scheduledAt, durationMinutes: durationMinutes as number };
  const url = query.isError || query.isFetching ? null : readReadyMeet(query.data, expected);
  if (!url) return null;

  const join = async () => {
    const key = identityRef.current;
    joinAbort.current?.abort();
    const ctl = new AbortController();
    joinAbort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), JOIN_TIMEOUT_MS);
    setJoinState("checking");
    try {
      const fresh = await getCandidateGoogleMeet(scheduleId, {
        cache: "no-store",
        signal: ctl.signal,
      });
      const target = readReadyMeet(fresh, expected);
      if (ctl.signal.aborted || key !== identityRef.current) return;
      if (!target) {
        setJoinState("failed");
        void query.refetch();
        return;
      }
      window.location.assign(target);
    } catch {
      if (!ctl.signal.aborted && key === identityRef.current) {
        setJoinState("failed");
        void query.refetch();
      } else if (ctl.signal.aborted && joinAbort.current === ctl && key === identityRef.current)
        setJoinState("failed");
    } finally {
      clearTimeout(timer);
    }
  };

  return (
    <div className="flex flex-col gap-1" data-testid={`google-meet-${scheduleId}`}>
      <Button
        className="gap-1.5 shadow-md shadow-primary/20"
        onClick={join}
        disabled={joinState === "checking"}
        data-testid="button-join-google-meet"
      >
        <Video className="w-3.5 h-3.5" />
        {joinState === "checking" ? "Checking link..." : "Join Google Meet"}
      </Button>
      {joinState === "failed" ? (
        <p role="status" className="text-xs text-destructive" data-testid="text-google-meet-failed">
          This link could not be confirmed. Check with your recruiter.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Meeting link on file in Lexy</p>
      )}
    </div>
  );
}
