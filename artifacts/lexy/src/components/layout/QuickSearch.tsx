/**
 * QuickSearch.tsx — ⌘K command palette for the staff layout.
 *
 * Opens from the header "Quick search…" button or the ⌘K / Ctrl+K shortcut.
 * Searches, tenant/role-scoped via the EXISTING list endpoints (no new
 * search routes — GET /candidates?search= and GET /jobs both enforce the
 * caller's recruiter-ownership / tenant-subtree scoping server-side):
 *   • Candidates — server-side ?search= filter (name/email/title/company)
 *   • Work Orders — client-side filter over the caller's scoped jobs list
 *   • Pages — static filter over the caller's own nav items
 * Selecting an item navigates. Staff-only: AppLayout only mounts this in the
 * staff (sidebar) layout, never in the candidate portal.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, Users, ArrowRight, Loader2 } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function qsFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { ...authHeaders() },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/** Small debounce hook — avoids hammering /candidates on every keystroke. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export interface QuickSearchPage {
  title: string;
  href: string;
  icon: React.ElementType;
}

export function QuickSearch({
  open,
  onOpenChange,
  pages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: QuickSearchPage[];
}) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const hasQuery = debouncedQuery.length >= 2;

  /* Global ⌘K / Ctrl+K shortcut. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  /* Reset the query whenever the palette closes. */
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  /* Candidates — server-side search, already tenant/role scoped. */
  const { data: candidateData, isFetching: candidatesLoading } = useQuery<any>({
    queryKey: ["quick-search-candidates", debouncedQuery],
    queryFn: () => qsFetch(`/candidates?search=${encodeURIComponent(debouncedQuery)}&limit=8`),
    enabled: open && hasQuery,
    staleTime: 30_000,
    retry: false,
  });
  const candidates: any[] = (candidateData?.candidates ?? []).slice(0, 8);

  /* Work orders — fetch the caller's scoped list once while open, filter here. */
  const { data: jobsData, isFetching: jobsLoading } = useQuery<any>({
    queryKey: ["quick-search-jobs"],
    queryFn: () => qsFetch("/jobs"),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const jobs: any[] = useMemo(() => {
    if (!hasQuery) return [];
    const q = debouncedQuery.toLowerCase();
    return (jobsData?.jobs ?? [])
      .filter((j: any) =>
        `${j.title ?? ""} ${j.workOrderNumber ?? ""} ${j.clientWorkOrderNumber ?? ""} ${j.department ?? ""} ${j.location ?? ""}`
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 8);
  }, [jobsData, debouncedQuery, hasQuery]);

  /* Pages — the caller's own nav (already role-appropriate). */
  const filteredPages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pages.slice(0, 6);
    return pages.filter((p) => p.title.toLowerCase().includes(q)).slice(0, 8);
  }, [pages, query]);

  const loading = (candidatesLoading || jobsLoading) && hasQuery;
  const nothingFound =
    !loading && candidates.length === 0 && jobs.length === 0 && filteredPages.length === 0;

  const go = (href: string) => {
    onOpenChange(false);
    navigate(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false}>
      <CommandInput
        placeholder="Search candidates, work orders, pages…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Searching…
          </div>
        )}

        {nothingFound && (
          <CommandEmpty>
            {hasQuery
              ? "No matches. Search candidates by name, email, title or company; work orders by title or WO number."
              : "Type at least 2 characters to search candidates and work orders, or jump to a page."}
          </CommandEmpty>
        )}

        {candidates.length > 0 && (
          <CommandGroup heading="Candidates">
            {candidates.map((c) => (
              <CommandItem
                key={`cand-${c.id}`}
                value={`cand-${c.id}`}
                onSelect={() => go(`/candidates/${c.id}`)}
                className="cursor-pointer"
              >
                <Users className="text-primary" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {c.firstName} {c.lastName}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {[c.currentTitle, c.currentCompany].filter(Boolean).join(" · ") || c.email}
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {jobs.length > 0 && (
          <>
            {candidates.length > 0 && <CommandSeparator />}
            <CommandGroup heading="Work Orders">
              {jobs.map((j) => (
                <CommandItem
                  key={`job-${j.id}`}
                  value={`job-${j.id}`}
                  onSelect={() => go(`/jobs/${j.id}`)}
                  className="cursor-pointer"
                >
                  <Briefcase className="text-primary" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{j.title}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {[j.workOrderNumber, j.location, j.status].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {filteredPages.length > 0 && (
          <>
            {(candidates.length > 0 || jobs.length > 0) && <CommandSeparator />}
            <CommandGroup heading="Pages">
              {filteredPages.map((p) => (
                <CommandItem
                  key={`page-${p.href}`}
                  value={`page-${p.href}`}
                  onSelect={() => go(p.href)}
                  className="cursor-pointer"
                >
                  <p.icon className="text-muted-foreground" />
                  <span className="flex-1">{p.title}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/50" />
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
