import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CareerCampaignEntry, CareerCampaignPage } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const labels: Record<CareerCampaignEntry["status"], string> = {
  not_invited: "Not invited",
  invited: "Invitation prepared · not activated",
  portal_created: "Portal activated",
  interview_completed: "Interview completed",
  profile_complete: "Career profile complete",
};

async function loadPage(cursor?: string): Promise<CareerCampaignPage> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  const response = await apiFetch(`${BASE}/api/invites/career-campaign-status?${params}`);
  const body = (await response.json()) as CareerCampaignPage & { error?: string };
  if (!response.ok) throw new Error(body.error || "Portal progress could not be loaded.");
  if (
    !Array.isArray(body.data) ||
    typeof body.hasMore !== "boolean" ||
    (body.hasMore && (!body.nextCursor || body.nextCursor === cursor)) ||
    (!body.hasMore && body.nextCursor !== null)
  )
    throw new Error("The report response is incomplete. Refresh before continuing.");
  return body;
}

export function CareerCampaignReport() {
  const { user } = useAuth();
  // Remount pagination and dialog state if another account signs in.
  const identity = user ? `${user.id}:${user.role}:${user.tenantId ?? ""}` : null;
  return identity ? <Report key={identity} userId={identity} /> : null;
}

function Report({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cache = useQueryClient();
  const cursor = cursors.at(-1);
  const reportKey = ["career-campaign-status", userId];
  const query = useQuery({
    queryKey: [...reportKey, cursor],
    queryFn: () => loadPage(cursor),
    enabled: open,
    retry: false,
    staleTime: 0,
    refetchInterval: open ? 30_000 : false,
  });
  function refresh() {
    setCursors([undefined]);
    void cache.invalidateQueries({ queryKey: reportKey });
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Portal progress
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setCursors([undefined]);
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] max-w-3xl max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Candidate portal progress</DialogTitle>
            <DialogDescription>
              Candidate-bound portal onboarding, not hiring evaluation scores. An invitation alone
              record does not prove delivery or portal activation. Erased and do-not-contact
              candidates are excluded.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Page {cursors.length} · {query.data?.data.length ?? 0} candidates on this page
            </p>
            <Button variant="outline" size="sm" onClick={refresh} disabled={query.isFetching}>
              Refresh from first page
            </Button>
          </div>
          {query.isFetching ? (
            <p role="status">Loading portal progress…</p>
          ) : query.isError ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-destructive">{query.error.message}</p>
              <Button variant="outline" onClick={() => query.refetch()}>
                Retry this page
              </Button>
            </div>
          ) : query.data ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Candidate portal activation and profile progress
                  </caption>
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="p-2">
                        Candidate
                      </th>
                      <th scope="col" className="p-2">
                        Portal status
                      </th>
                      <th scope="col" className="p-2">
                        Latest invitation record
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.data.map((row) => (
                      <tr key={row.candidateId} className="border-b">
                        <td className="p-2">
                          <Link
                            href={`/recruiter/candidates/${encodeURIComponent(row.candidateId)}`}
                            className="text-primary underline"
                          >
                            {row.name}
                          </Link>
                          <p className="text-muted-foreground break-all">{row.email}</p>
                        </td>
                        <td className="p-2">{labels[row.status]}</td>
                        <td className="p-2 whitespace-nowrap">
                          {row.invitedAt ? new Date(row.invitedAt).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {query.data.data.length === 0 && (
                  <p className="py-4">No eligible candidates on this page.</p>
                )}
              </div>
              <p className="text-sm text-muted-foreground" role="status">
                {query.data.hasMore
                  ? "More candidates are available. Continue to the next page."
                  : "End of report."}{" "}
                Permissions and progress are checked again on each page; refresh to see newly added
                candidates.
              </p>
            </>
          ) : null}
          <div className="flex justify-between gap-2">
            <Button
              variant="outline"
              disabled={cursors.length === 1 || query.isFetching}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              Previous page
            </Button>
            <Button
              disabled={query.isFetching || query.isError || !query.data?.hasMore}
              onClick={() => {
                const next = query.data?.nextCursor;
                if (next) setCursors((current) => [...current, next]);
              }}
            >
              Next page
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
