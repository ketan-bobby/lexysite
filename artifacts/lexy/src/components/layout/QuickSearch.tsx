/**
 * QuickSearch.tsx — the header ⌘K command palette (staff only).
 *
 * Opens from the header button or ⌘K / Ctrl+K anywhere. Searches:
 *   • Candidates — server-side via GET /candidates?search= (the endpoint
 *     already enforces tenant scoping, the recruiter ownership ceiling and
 *     the privacy/pool seals — we never add a new search surface here).
 *   • Work orders — GET /jobs (same tenant/role scoping), filtered
 *     client-side on title / WO number (the endpoint has no search param).
 *   • App pages — a static, role-filtered jump list.
 * Selecting a result navigates. Renders nothing for candidate users.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { authHeaders } from "@/lib/api";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Search, User, Briefcase, LayoutDashboard, Loader2 } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type CandidateHit = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  currentTitle?: string | null;
  currentCompany?: string | null;
};

type JobHit = {
  id: string;
  title?: string | null;
  workOrderNumber?: string | null;
  status?: string | null;
};

const PAGES: Array<{ label: string; path: string; roles?: string[] }> = [
  { label: "Dashboard", path: "/dashboard" },
  { label: "Work Orders", path: "/jobs" },
  { label: "Candidates", path: "/candidates" },
  { label: "Decision Queue", path: "/decision-queue" },
  { label: "Interviews", path: "/interviews" },
  { label: "Outreach", path: "/outreach" },
  { label: "Analytics", path: "/analytics" },
  {
    label: "Fairness Dashboard",
    path: "/admin/fairness",
    roles: ["platform_admin", "tenant_admin"],
  },
  {
    label: "Network Prior",
    path: "/admin/network-prior",
    roles: ["platform_admin", "tenant_admin"],
  },
];

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function QuickSearch({ role }: { role: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 300);
  const [, navigate] = useLocation();

  /* Global ⌘K / Ctrl+K shortcut */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Candidates — server-side scoped search, only once 2+ chars typed */
  const { data: candData, isFetching: candLoading } = useQuery<{ candidates: CandidateHit[] }>({
    queryKey: ["quick-search", "candidates", debounced],
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/api/candidates?search=${encodeURIComponent(debounced)}&limit=8`,
        { credentials: "include", headers: { ...authHeaders() } },
      );
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
  });

  /* Work orders — fetch once per open, filter client-side */
  const { data: jobsData } = useQuery<{ jobs: JobHit[] }>({
    queryKey: ["quick-search", "jobs"],
    enabled: open,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/jobs`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
  });

  const candidates = (candData?.candidates ?? []).slice(0, 8);
  const jobs = useMemo(() => {
    const all = jobsData?.jobs ?? [];
    if (debounced.length < 2) return all.slice(0, 5);
    const q = debounced.toLowerCase();
    return all
      .filter(
        (j) =>
          (j.title ?? "").toLowerCase().includes(q) ||
          (j.workOrderNumber ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [jobsData, debounced]);

  const pages = useMemo(() => {
    const allowed = PAGES.filter((p) => !p.roles || p.roles.includes(role));
    if (debounced.length < 2) return allowed;
    const q = debounced.toLowerCase();
    return allowed.filter((p) => p.label.toLowerCase().includes(q));
  }, [role, debounced]);

  const go = (path: string) => {
    setOpen(false);
    setQuery("");
    navigate(path);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Quick search"
        className="hidden md:flex items-center gap-2 h-9 px-4 rounded-xl bg-foreground/5 border border-foreground/8 text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/8 transition-all"
      >
        <Search className="w-3.5 h-3.5" />
        <span>Quick search…</span>
        <kbd className="ml-2 bg-foreground/10 px-1.5 rounded text-[10px] font-sans text-faint dark:text-inherit">
          ⌘K
        </kbd>
      </button>

      {/* shouldFilter={false}: the server already filtered candidates (incl. on
          email, which isn't in the visible value string) and jobs/pages are
          filtered explicitly below — cmdk's second fuzzy pass would silently
          hide legitimate matches. */}
      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
        <CommandInput
          placeholder="Search candidates, work orders, pages…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {candLoading ? (
              <span className="flex items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Searching…
              </span>
            ) : debounced.length < 2 ? (
              "Type at least 2 characters to search candidates and work orders."
            ) : (
              "No results found."
            )}
          </CommandEmpty>

          {candidates.length > 0 && (
            <CommandGroup heading="Candidates">
              {candidates.map((c) => {
                const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed";
                const sub = [c.currentTitle, c.currentCompany].filter(Boolean).join(" · ");
                return (
                  <CommandItem
                    key={`cand-${c.id}`}
                    value={`candidate ${name} ${sub} ${c.id}`}
                    onSelect={() => go(`/candidates/${c.id}`)}
                  >
                    <User className="w-4 h-4 mr-2 text-muted-foreground" />
                    <span className="truncate">{name}</span>
                    {sub && (
                      <span className="ml-2 text-xs text-muted-foreground truncate">{sub}</span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {jobs.length > 0 && (
            <CommandGroup heading="Work Orders">
              {jobs.map((j) => (
                <CommandItem
                  key={`job-${j.id}`}
                  value={`job ${j.title ?? ""} ${j.workOrderNumber ?? ""} ${j.id}`}
                  onSelect={() => go(`/jobs/${j.id}`)}
                >
                  <Briefcase className="w-4 h-4 mr-2 text-muted-foreground" />
                  <span className="truncate">{j.title ?? "Untitled"}</span>
                  {j.workOrderNumber && (
                    <span className="ml-2 text-xs text-muted-foreground font-mono">
                      {j.workOrderNumber}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          <CommandGroup heading="Pages">
            {pages.map((p) => (
              <CommandItem
                key={`page-${p.path}`}
                value={`page ${p.label}`}
                onSelect={() => go(p.path)}
              >
                <LayoutDashboard className="w-4 h-4 mr-2 text-muted-foreground" />
                {p.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
