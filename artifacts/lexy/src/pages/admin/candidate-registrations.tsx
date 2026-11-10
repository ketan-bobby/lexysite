import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CandidateRegistrationPage } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppLayout } from "@/components/layout/AppLayout";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const poolLabels: Record<string, string> = {
  pending_profile: "Private · not in Candidate Pool",
  platform: "In Candidate Pool · consent-based visibility",
  tenant: "Tenant-owned · not in shared pool",
};

export default function CandidateRegistrations() {
  const { user } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${user.tenantId ?? ""}` : "";
  return user?.role === "platform_admin" ? (
    <AppLayout>
      <Directory key={identity} identity={identity} />
    </AppLayout>
  ) : null;
}

function Directory({ identity }: { identity: string }) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const query = useQuery({
    queryKey: ["candidate-registrations", identity, search, cursor],
    queryFn: async (): Promise<CandidateRegistrationPage> => {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      if (search) params.set("search", search);
      const response = await apiFetch(`${BASE}/api/platform/candidate-registrations?${params}`);
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Candidate registrations could not be loaded.");
      if (
        !Array.isArray(body.data) ||
        typeof body.hasMore !== "boolean" ||
        (body.hasMore && (!body.nextCursor || body.nextCursor === cursor)) ||
        (!body.hasMore && body.nextCursor !== null)
      ) {
        throw new Error("The registration response is incomplete. Please refresh.");
      }
      return body;
    },
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
  });

  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Candidate Registrations</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Accounts created through the Lexy candidate page, including Microsoft sign-up. Private
            registrations appear here even before they enter the Candidate Pool. This admin
            directory does not expose private coaching or change discovery consent. Erased and
            do-not-contact records are excluded.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => {
            if (cursor) setCursors([undefined]);
            else void query.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setCursors([undefined]);
          setSearch(draft.trim());
        }}
      >
        <div className="w-full max-w-md space-y-2">
          <label htmlFor="registration-search" className="text-sm font-medium">
            Find a registration
          </label>
          <Input
            id="registration-search"
            placeholder="Candidate name or email"
            maxLength={200}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button type="submit">Search</Button>
        {search && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft("");
              setSearch("");
              setCursors([undefined]);
            }}
          >
            Clear search
          </Button>
        )}
      </form>
      {query.isLoading ? (
        <p role="status">Loading registrations…</p>
      ) : query.isError ? (
        <div role="alert" className="space-y-3 rounded-lg border p-4">
          <p>{query.error.message}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.data ? (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="p-3">Candidate</th>
                  <th className="p-3">Registered</th>
                  <th className="p-3">Discovery status</th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((row) => (
                  <tr key={row.candidateId} className="border-t">
                    <td className="p-3">
                      <p className="font-medium">{row.name}</p>
                      <p className="break-all text-muted-foreground">{row.email}</p>
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {new Date(row.registeredAt).toLocaleString()}
                    </td>
                    <td className="p-3">
                      {poolLabels[row.pool] ?? "Not in shared Candidate Pool"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {query.data.data.length === 0 && (
              <p className="p-6 text-muted-foreground">
                {search
                  ? "No registrations match this name or email."
                  : "No self-registered candidates are recorded in this environment yet."}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="outline"
              disabled={cursors.length === 1 || query.isFetching}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              Previous page
            </Button>
            <p className="text-sm text-muted-foreground" role="status">
              Page {cursors.length}
              {query.isFetching ? " · Updating…" : ""}
            </p>
            <Button
              disabled={!query.data.hasMore || query.isFetching}
              onClick={() => {
                if (query.data.nextCursor)
                  setCursors((current) => [...current, query.data.nextCursor!]);
              }}
            >
              Next page
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
