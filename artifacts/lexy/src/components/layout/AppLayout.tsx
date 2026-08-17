/**
 * AppLayout.tsx — Root layout shell for the entire Lexy application.
 *
 * Renders two distinct layouts depending on the logged-in user's role:
 *
 *  - Candidate   → Horizontal top-nav bar with portal links (Career Engine,
 *                   Applications, Interviews, Prep Center).
 *  - Recruiter /
 *    Platform Admin → Collapsible left sidebar with grouped nav items,
 *                     an AI-agent status pill, and a notifications bell.
 *
 * Both layouts share the same auth context and route-based active-state logic.
 */

import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, Briefcase, Users, Inbox, Search,
  BarChart3, Settings, LogOut, Brain, ChevronDown, Menu, CreditCard, TrendingUp, LineChart,
  Building2, Bell, Zap, Ghost, Video, UserCheck, ShieldOff,
  Database, Bot, ClipboardCheck, FileUp, HelpCircle, Sparkles, RotateCcw,
  AlertTriangle, Send, ScrollText, Scale, Handshake, MessageCircleQuestion,
  Receipt,
} from "lucide-react";
import { useTour } from "@/lib/tour/TourProvider";
import { tours } from "@/lib/tour/tours";
import { resetAllHotspots } from "@/lib/tour/Hotspot";
import { cn, pluralize } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { QuickSearch } from "@/components/layout/QuickSearch";
import { HelpBot } from "@/components/layout/HelpBot";
import { apiBase, authHeaders } from "@/lib/api";

/* ─── Internal authenticated fetch (returns JSON, throws on non-OK) ─────── */

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

/**
 * Lightweight fetch helper used only inside AppLayout for polling endpoints
 * (e.g. /agents). Cookie-first via credentials:"include" (dev keeps a Bearer
 * fallback through authHeaders()); returns parsed JSON directly.
 */
async function layoutApiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { ...authHeaders() },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/* ─── Navigation definitions ─────────────────────────────────────────────── */

/** Sidebar nav groups for recruiters. */
const recruiterNav = [
  {
    group: "Main",
    items: [
      { title: "Dashboard",   href: "/dashboard",        icon: LayoutDashboard },
      { title: "Work Orders", href: "/jobs",             icon: Briefcase       },
      { title: "Candidates",  href: "/candidates",       icon: Users           },
      { title: "Internal Talent", href: "/internal-talent", icon: Building2    },
      { title: "Recommended", href: "/hiring/talent-pool", icon: Database      },
      { title: "Sourcing",    href: "/sourcing",         icon: Search          },
      { title: "Outreach",    href: "/outreach",         icon: Send            },
      { title: "Inbox",       href: "/outreach/inbox",   icon: Inbox           },
      { title: "Anti-Ghost",  href: "/anti-ghost",       icon: Ghost           },
      { title: "DNC List",    href: "/dnc",              icon: ShieldOff       },
      { title: "Engagement",  href: "/engagement",       icon: Zap             },
      { title: "Analytics",   href: "/analytics",        icon: BarChart3       },
      { title: "Market Intel", href: "/market-intelligence", icon: LineChart    },
      { title: "AI Job Queue", href: "/admin/ai-jobs",   icon: Bot             },
      { title: "Team",        href: "/team",             icon: UserCheck       },
      { title: "Settings",    href: "/recruiter/settings", icon: Settings      },
    ],
  },
];

/** Sidebar nav for platform super-admins. */
const platformAdminNav = [
  {
    group: "Platform",
    items: [
      { title: "Overview",        href: "/platform",               icon: LayoutDashboard },
      { title: "Clients",         href: "/clients",                icon: Building2       },
      { title: "Candidate Pool",  href: "/candidates?pool=platform", icon: Database      },
      { title: "Open Work Orders", href: "/open-work-orders",     icon: ClipboardCheck  },
      { title: "Engagement",       href: "/engagement",             icon: Zap             },
      { title: "AI Agents",       href: "/agents",                 icon: Bot             },
      { title: "Resume Import",   href: "/import",                 icon: FileUp          },
      { title: "Subscriptions",   href: "/platform/subscriptions", icon: TrendingUp      },
      { title: "Fee Ledger",      href: "/platform/fee-ledger",    icon: Receipt         },
      { title: "Pricing",         href: "/platform/pricing",       icon: CreditCard      },
      { title: "Trial Requests",  href: "/platform/trial-requests", icon: Inbox          },
      { title: "System Errors",   href: "/platform/system-errors", icon: AlertTriangle   },
      { title: "Fairness",        href: "/admin/fairness",         icon: Scale           },
      { title: "AI Job Queue",    href: "/admin/ai-jobs",          icon: Bot             },
      { title: "Settings",        href: "/admin",                  icon: Settings        },
    ],
  },
];

/** Top-nav links rendered in the candidate portal header. */
const candidateNav = [
  { title: "Career Engine", href: "/portal/career"       },
  { title: "Applications",  href: "/portal/applications" },
  { title: "Interviews",    href: "/portal/interviews"   },
  { title: "Prep Center",   href: "/portal/prep"         },
];

/** Sidebar nav for hiring managers (client-side, read + approve). */
const hiringManagerNav = [
  {
    group: "My Company",
    items: [
      { title: "Dashboard",   href: "/hiring/dashboard",    icon: LayoutDashboard },
      { title: "Open Roles",  href: "/hiring/jobs",         icon: Briefcase       },
      { title: "Candidates",  href: "/hiring/candidates",   icon: Users           },
      { title: "Recommended", href: "/hiring/talent-pool",  icon: Database        },
      { title: "Interviews",  href: "/hiring/interviews",   icon: Video           },
    ],
  },
];

/** Top-nav links for interviewers (minimal — just their assigned interviews). */
const interviewerNav = [
  { title: "My Interviews", href: "/interviewer/interviews" },
];

/* ─── Shared sub-components ──────────────────────────────────────────────── */

/**
 * Lexy logo — shows the full image when expanded, or a compact icon when
 * the sidebar is collapsed. Platform-admin gets a different home link.
 */
function Logo({
  collapsed = false,
  isPlatformAdmin = false,
}: {
  collapsed?: boolean;
  isPlatformAdmin?: boolean;
}) {
  return (
    <Link
      href={isPlatformAdmin ? "/platform" : "/dashboard"}
      className="flex items-center gap-2 group"
    >
      {collapsed ? (
        /* Mini icon fallback when sidebar is narrow */
        <div className="relative w-9 h-9 shrink-0">
          <div className="absolute inset-0 rounded-xl bg-primary/20 blur-md group-hover:bg-primary/30 transition-all" />
          <div className="relative w-9 h-9 bg-gradient-to-br from-primary to-cyan-700 rounded-xl flex items-center justify-center shadow-lg shadow-primary/30">
            <Brain className="w-5 h-5 text-white" />
          </div>
        </div>
      ) : (
        /* Full logo image */
        <img
          src={`${import.meta.env.BASE_URL}lexy-logo.png`}
          alt="Lexy AI"
          className="h-8 w-auto object-contain opacity-90 group-hover:opacity-100 transition-opacity"
        />
      )}
    </Link>
  );
}

/**
 * Indented child nav item (sub-item of a parent NavItem).
 * Rendered when a nav item has a `children` array (e.g. Outreach sub-pages).
 */
function SubNavItem({
  item, isActive, collapsed,
}: {
  item: { title: string; href: string; icon: React.ElementType };
  isActive: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={item.href}
      className={cn(
        "relative flex items-center gap-2 pl-9 pr-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150 group",
        collapsed && "pl-0 justify-center px-0",
        isActive
          ? "text-primary transition-none"
          : "text-sidebar-foreground/50 hover:text-sidebar-foreground/80 hover:bg-sidebar-accent/40",
      )}
    >
      {isActive && !collapsed && (
        <span className="absolute left-[22px] top-1/2 -translate-y-1/2 w-0.5 h-3.5 bg-primary/60 rounded-full" />
      )}
      <item.icon className={cn(
        "w-3.5 h-3.5 shrink-0 transition-all",
        collapsed && "w-4 h-4",
        isActive
          ? "text-primary drop-shadow-[0_0_6px_rgba(0,212,255,0.8)]"
          : "text-sidebar-foreground/40 group-hover:text-sidebar-foreground/70",
      )} />
      {!collapsed && <span>{item.title}</span>}
    </Link>
  );
}

/**
 * Primary sidebar nav item with active accent bar and icon glow effect.
 * Collapses to icon-only mode when the sidebar is narrow.
 */
function NavItem({
  item, isActive, collapsed,
}: {
  item: { title: string; href: string; icon: React.ElementType };
  isActive: boolean;
  collapsed: boolean;
}) {
  // Map sidebar items to stable tour anchors so the welcome tour can find them.
  const tourId =
    item.href === "/jobs"           ? "nav-jobs" :
    item.href === "/candidates"     ? "nav-candidates" :
    item.href === "/outreach/inbox" ? "nav-inbox" :
    item.href === "/engagement"     ? "nav-engagement" :
    item.href === "/dashboard"      ? "nav-dashboard" :
    item.href === "/anti-ghost"     ? "nav-anti-ghost" :
    item.href === "/analytics"      ? "nav-analytics" : undefined;

  return (
    <Link
      href={item.href}
      data-tour={tourId}
      className={cn(
        "relative flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors duration-150 group",
        collapsed && "justify-center px-0",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground nav-active-glow transition-none"
          : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60",
      )}
    >
      {/* Active accent bar on the left edge */}
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-full shadow-[0_0_8px_2px] shadow-primary/60" />
      )}

      {/* Icon container */}
      <div className={cn(
        "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all",
        isActive ? "bg-primary/20 shadow-sm shadow-primary/20" : "bg-transparent group-hover:bg-sidebar-accent",
      )}>
        <item.icon className={cn(
          "w-4 h-4 transition-all",
          isActive
            ? "text-primary drop-shadow-[0_0_8px_rgba(0,212,255,0.9)]"
            : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80",
        )} />
      </div>

      {!collapsed && <span>{item.title}</span>}

      {/* Optional count badge (e.g. pending approvals) */}
      {!collapsed && (item as any).badge ? (
        <span className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
          {(item as any).badge}
        </span>
      ) : isActive && !collapsed ? (
        /* Active indicator dot on the right */
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_6px_2px] shadow-primary/50" />
      ) : null}
    </Link>
  );
}

/**
 * FloatingHelpButton — Fixed bottom-right circular help dock.
 *
 * Always visible regardless of scroll position or layout chrome. Solves the
 * discoverability problem where the header HelpCircle icon gets clipped in
 * narrow viewports or scrolled out of view. Pulses cyan until the welcome
 * tour is completed.
 */
function FloatingHelpButton() {
  const [location] = useLocation();
  const { user } = useAuth();
  const { start, resetAll, hasCompleted } = useTour();
  const [helpBotOpen, setHelpBotOpen] = useState(false);

  /* Chat bot answers from the recruiter guide — staff only (server enforces
     the role gate too; candidates get 403 so don't offer it to them). */
  const staffRoles = ["recruiter", "recruiter_admin", "hiring_manager", "tenant_admin", "platform_admin", "interviewer"];
  const canAskBot = !!user && staffRoles.includes(user.role);

  const pageTour = Object.values(tours).find(t =>
    t.routes.some(r => location === r || location.startsWith(r)),
  );
  // Welcome tour anchors to recruiter-layout sidebar selectors — only offer it
  // to roles that actually render that sidebar.
  const sidebarRoles = ["recruiter", "hiring_manager", "tenant_admin", "platform_admin"];
  const canRunWelcome = !!user && sidebarRoles.includes(user.role);
  const showPulse = canRunWelcome && !hasCompleted("welcome");

  return (
    <>
    {canAskBot && <HelpBot open={helpBotOpen} onClose={() => setHelpBotOpen(false)} />}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-tour="help-button"
          aria-label="Help and product tour"
          className={cn(
            "fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center",
            "bg-primary text-primary-foreground",
            "border border-primary/40 hover:scale-105 active:scale-95 transition-transform",
          )}
        >
          <HelpCircle className="w-6 h-6" />
          {showPulse && (
            <>
              <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping" />
              <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-cyan-300 border-2 border-background" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-64 mb-2">
        <DropdownMenuLabel className="font-semibold flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-primary" /> Need help?
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {canAskBot && (
          <DropdownMenuItem className="cursor-pointer" onClick={() => setHelpBotOpen(true)}>
            <MessageCircleQuestion className="w-4 h-4 mr-2 text-primary" />
            <div className="flex-1">
              <div className="font-medium">Ask a question</div>
              <div className="text-[11px] text-muted-foreground">Chat with the Lexy help assistant</div>
            </div>
          </DropdownMenuItem>
        )}
        {canRunWelcome && (
          <DropdownMenuItem className="cursor-pointer" onClick={() => start("welcome")}>
            <HelpCircle className="w-4 h-4 mr-2 text-primary" />
            <div className="flex-1">
              <div className="font-medium">Take the welcome tour</div>
              <div className="text-[11px] text-muted-foreground">60-second walkthrough</div>
            </div>
          </DropdownMenuItem>
        )}
        {pageTour && pageTour.id !== "welcome" && (
          <DropdownMenuItem className="cursor-pointer" onClick={() => start(pageTour.id)}>
            <Sparkles className="w-4 h-4 mr-2 text-primary" />
            <div className="flex-1">
              <div className="font-medium">Tour this page</div>
              <div className="text-[11px] text-muted-foreground">{pageTour.description}</div>
            </div>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer text-muted-foreground"
          onClick={() => { resetAll(); resetAllHotspots(); }}
        >
          <RotateCcw className="w-4 h-4 mr-2" />
          <span>Reset all hints &amp; tours</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}

/* ─── Main export ─────────────────────────────────────────────────────────── */

export function AppLayout({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  const { user, logout } = useAuth();
  const [location, navigate] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const isPlatformAdmin = user?.role === "platform_admin";
  const isHiringManager = user?.role === "hiring_manager";
  const isInterviewer   = user?.role === "interviewer";

  /* Poll the AI agent status every 10 seconds to update the status pill. */
  const { data: agentData } = useQuery<any>({
    queryKey: ["agent-status-pill"],
    queryFn: () => layoutApiFetch("/agents"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const agents: any[] = agentData?.agents ?? [];
  const runningCount = agents.filter(a => a.status === "running").length;

  /* Pill label + colour: cyan when agents are active, green when idle. */
  const agentPillLabel = runningCount > 0
    ? `${pluralize(runningCount, "Agent")} Running`
    : "AI Ready";
  const agentPillClass = runningCount > 0
    ? "bg-primary/8 border-primary/20 text-primary"
    : "bg-emerald-500/8 border-emerald-500/15 text-emerald-400";

  /* Pending-approval count — drives the "Approvals" sidebar badge for
     hiring managers, tenant admins, and platform admins. */
  const canApprove = ["hiring_manager", "tenant_admin", "platform_admin"].includes(user?.role ?? "");
  const { data: jobsForApproval } = useQuery<any>({
    queryKey: ["sidebar-pending-approval"],
    queryFn: () => layoutApiFetch("/jobs"),
    enabled: canApprove,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  /* LINX engagement queue — visible ONLY to admins of the LINX tenant.
     The server is the authority: a non-LINX admin gets 403 and the probe
     fails silently, so the link never renders for them. */
  const { data: linxProbe } = useQuery<any>({
    queryKey: ["sidebar-linx-queue-probe"],
    queryFn: () => layoutApiFetch("/linx/requests?status=pending"),
    enabled: ["tenant_admin", "platform_admin"].includes(user?.role ?? ""),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const isLinxAdmin = Array.isArray(linxProbe?.requests);
  const linxPendingCount = linxProbe?.requests?.length ?? 0;

  const pendingApprovalCount = (jobsForApproval?.jobs ?? jobsForApproval ?? [])
    .filter((j: any) => {
      if (j.status !== "pending_approval") return false;
      if (user?.role === "hiring_manager") return j.assignedHiringManagerId === user?.id;
      return true;
    }).length;

  /* Inject "Approvals" into the sidebar for users who can approve WOs. */
  const navWithApprovals = canApprove && !isHiringManager
    ? recruiterNav.map(group =>
        group.group === "Main"
          ? {
              ...group,
              items: [
                ...group.items.slice(0, 2), // Dashboard, Work Orders
                { title: "Approvals", href: "/jobs?queue=pending", icon: ClipboardCheck, badge: pendingApprovalCount },
                ...group.items.slice(2),
              ],
            }
          : group,
      )
    : recruiterNav;

  const baseNav = isPlatformAdmin
    ? platformAdminNav
    : isHiringManager
    ? hiringManagerNav
    : navWithApprovals;

  /* Inject the LINX queue link for confirmed LINX-tenant admins only. */
  const effectiveNav = isLinxAdmin
    ? baseNav.map((group, i) =>
        i === 0
          ? {
              ...group,
              items: [
                ...group.items,
                { title: "LINX Queue", href: "/linx/queue", icon: Handshake, badge: linxPendingCount },
              ],
            }
          : group,
      )
    : baseNav;

  /* Show a full-screen spinner while the auth context is still loading. */
  if (!user) {
    return (
      <div className="app-bg min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  const isCandidate = user.role === "candidate";

  /* ── Candidate layout ──────────────────────────────────────────────────── */
  if (isCandidate) {
    return (
      <div className="app-bg min-h-screen flex flex-col">
        {/* Sticky top nav */}
        <header className="sticky top-0 z-50 px-6 py-3 flex items-center justify-between frosted-nav">
          <div className="flex items-center gap-8">
            <Logo isPlatformAdmin={user.role === "platform_admin"} />

            {/* Portal section links */}
            <nav className="hidden md:flex gap-1">
              {candidateNav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "px-4 py-2 rounded-lg text-sm font-medium transition-all",
                    location === item.href
                      ? "bg-primary/15 text-primary shadow-sm shadow-primary/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                  )}
                >
                  {item.title}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            {/* Notification bell — dot always shown (badge count from server) */}
            <Button variant="ghost" size="icon" aria-label="Notifications" className="relative hover-elevate text-muted-foreground" onClick={() => navigate(isCandidate ? "/portal/notifications" : "/notifications")}>
              <Bell className="w-5 h-5" />
              <span className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full shadow-[0_0_6px_2px] shadow-primary/50" />
            </Button>

            {/* User avatar + dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="pl-1 pr-3 gap-2 rounded-full hover-elevate border border-foreground/8">
                  <Avatar className="w-8 h-8">
                    <AvatarImage src={user.avatarUrl || undefined} />
                    <AvatarFallback className="bg-primary/20 text-primary font-bold">
                      {user.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm font-medium hidden sm:block">{user.name}</span>
                  <ChevronDown className="w-4 h-4 text-muted-foreground hidden sm:block" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-semibold">{user.name}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => navigate("/portal/settings")}
                >
                  <Settings className="w-4 h-4 mr-2" /> My Account
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer text-destructive focus:bg-destructive/10"
                  onClick={logout}
                >
                  <LogOut className="w-4 h-4 mr-2" /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 w-full p-4 md:p-8 animate-in fade-in duration-500">
          {children}
        </main>
        <FloatingHelpButton />
      </div>
    );
  }

  /* ── Interviewer top-nav layout ───────────────────────────────────────── */
  if (isInterviewer) {
    return (
      <div className="app-bg min-h-screen flex flex-col">
        <header className="sticky top-0 z-50 px-6 py-3 flex items-center justify-between frosted-nav">
          <div className="flex items-center gap-8">
            <Logo />
            <nav className="hidden md:flex gap-1">
              {interviewerNav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "px-4 py-2 rounded-lg text-sm font-medium transition-all",
                    location === item.href
                      ? "bg-primary/15 text-primary shadow-sm shadow-primary/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
                  )}
                >
                  {item.title}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="pl-1 pr-3 gap-2 rounded-full hover-elevate border border-foreground/8">
                <Avatar className="w-8 h-8">
                  <AvatarImage src={user.avatarUrl || undefined} />
                  <AvatarFallback className="bg-primary/20 text-primary font-bold">
                    {user.name?.charAt(0) || "U"}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium hidden sm:block">{user.name}</span>
                <ChevronDown className="w-4 h-4 text-muted-foreground hidden sm:block" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-semibold">{user.name}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer" onClick={() => navigate("/settings/intro-video")}>
                <Video className="w-4 h-4 mr-2" /> My Introduction Video
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer text-destructive focus:bg-destructive/10" onClick={logout}>
                <LogOut className="w-4 h-4 mr-2" /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 w-full p-4 md:p-8 animate-in fade-in duration-500">
          {children}
        </main>
        <FloatingHelpButton />
      </div>
    );
  }

  /* ── Recruiter / Admin sidebar layout ─────────────────────────────────── */
  return (
    <div className="app-bg min-h-screen flex" style={style}>

      {/* ── Collapsible sidebar ─────────────────────────────────────────── */}
      <aside className={cn(
        "frosted-rail transition-all duration-300 flex flex-col fixed inset-y-0 z-40",
        sidebarOpen ? "w-64" : "w-[72px]",
      )}>

        {/* Logo row */}
        <div className="h-16 flex items-center px-4 border-b border-sidebar-border shrink-0">
          <Logo collapsed={!sidebarOpen} isPlatformAdmin={user.role === "platform_admin"} />
        </div>

        {/* Scrollable nav area */}
        <div className="flex-1 overflow-y-auto py-4 space-y-6">
          {effectiveNav.map((group, i) => (
            <div key={i} className="px-3">
              {sidebarOpen && (
                <p className="text-[9px] uppercase tracking-[0.18em] text-sidebar-foreground/30 font-bold mb-2 px-3">
                  {group.group}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  /* Active when the path starts with the item href (avoids false positives on /outreach) */
                  const isActive =
                    location.startsWith(item.href) &&
                    (item.href !== "/outreach" ||
                      location === "/outreach" ||
                      location.startsWith("/outreach/campaigns"));

                  const hasChildren = (item as any).children?.length > 0;

                  return (
                    <div key={item.href}>
                      <NavItem item={item} isActive={isActive} collapsed={!sidebarOpen} />

                      {/* Render child items indented below the parent */}
                      {hasChildren && (
                        <div className="mt-0.5 space-y-0.5">
                          {(item as any).children.map(
                            (child: { title: string; href: string; icon: React.ElementType }) => (
                              <SubNavItem
                                key={child.href}
                                item={child}
                                isActive={location.startsWith(child.href)}
                                collapsed={!sidebarOpen}
                              />
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Recruiter-admin extra section (read-only Clients directory) */}
          {user.role === "recruiter_admin" && (
            <div className="px-3">
              {sidebarOpen && (
                <p className="text-[9px] uppercase tracking-[0.18em] text-sidebar-foreground/30 font-bold mb-2 px-3">
                  Admin
                </p>
              )}
              <div className="space-y-0.5">
                <NavItem
                  item={{ title: "Clients", href: "/clients", icon: Building2 }}
                  isActive={location.startsWith("/clients")}
                  collapsed={!sidebarOpen}
                />
              </div>
            </div>
          )}

          {/* Tenant-admin extra section (Settings / Clients) */}
          {user.role === "tenant_admin" && (
            <div className="px-3">
              {sidebarOpen && (
                <p className="text-[9px] uppercase tracking-[0.18em] text-sidebar-foreground/30 font-bold mb-2 px-3">
                  Admin
                </p>
              )}
              <div className="space-y-0.5">
                {(() => {
                  const settingsHref = `/clients/${(user as any).tenantId ?? ""}`;
                  return [
                    { title: "Clients",      href: "/clients",      icon: Building2,   active: location === "/clients" || (location.startsWith("/clients") && location !== settingsHref) },
                    { title: "Fairness",     href: "/admin/fairness", icon: Scale,     active: location === "/admin/fairness" },
                    { title: "Audit Log",    href: "/activity",     icon: ScrollText,  active: location === "/activity" },
                    { title: "AI Brand",     href: "/admin",        icon: Sparkles,    active: location === "/admin" },
                    { title: "Subscription", href: "/subscription", icon: CreditCard,  active: location === "/subscription" },
                    { title: "Fees",         href: "/fees",         icon: Receipt,     active: location === "/fees" },
                    { title: "Settings",     href: settingsHref,    icon: Settings,    active: location === settingsHref },
                  ].map(item => (
                    <NavItem
                      key={item.href}
                      item={item}
                      isActive={item.active}
                      collapsed={!sidebarOpen}
                    />
                  ));
                })()}
              </div>
            </div>
          )}
        </div>

        {/* User footer with avatar + logout dropdown */}
        <div className="p-3 border-t border-sidebar-border shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className={cn(
                "w-full flex items-center gap-3 p-2 rounded-xl hover:bg-sidebar-accent transition-all group",
                !sidebarOpen && "justify-center",
              )}>
                <div className="relative shrink-0">
                  <Avatar className="w-9 h-9 border border-primary/20 shadow-sm shadow-primary/10">
                    <AvatarImage src={user.avatarUrl || undefined} />
                    <AvatarFallback className="bg-primary/20 text-primary text-sm font-bold">
                      {user.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  {/* Online presence dot */}
                  <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 border-2 border-sidebar rounded-full shadow-[0_0_6px_1px] shadow-emerald-500/50" />
                </div>
                {sidebarOpen && (
                  <div className="flex-1 text-left overflow-hidden">
                    <p className="text-sm font-semibold text-sidebar-foreground truncate">{user.name}</p>
                    <p className="text-xs text-sidebar-foreground/50 truncate capitalize">
                      {user.role.replace(/_/g, " ")}
                    </p>
                  </div>
                )}
                {sidebarOpen && (
                  <ChevronDown className="w-3.5 h-3.5 text-sidebar-foreground/30 group-hover:text-sidebar-foreground/60 shrink-0" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-56 mb-1">
              <DropdownMenuLabel>
                <div>
                  <p className="font-semibold">{user.name}</p>
                  <p className="text-xs text-muted-foreground font-normal capitalize">
                    {user.role.replace(/_/g, " ")}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => navigate("/settings/intro-video")}
              >
                <Video className="w-4 h-4 mr-2" /> My Introduction Video
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer text-destructive focus:bg-destructive/10"
                onClick={logout}
              >
                <LogOut className="w-4 h-4 mr-2" /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* ── Main content area (offset by sidebar width) ─────────────────── */}
      <div className={cn(
        "flex-1 flex flex-col min-h-screen transition-all duration-300",
        sidebarOpen ? "ml-64" : "ml-[72px]",
      )}>

        {/* Sticky top header bar */}
        <header className="h-16 flex items-center justify-between px-6 sticky top-0 z-30 frosted-nav">
          <div className="flex items-center gap-4">
            {/* Toggle sidebar collapse */}
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-all"
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Tenant / platform context indicator */}
            <div className="hidden md:flex items-center gap-2">
              <div className={cn(
                "w-2 h-2 rounded-full shadow-[0_0_8px_2px]",
                user.role === "platform_admin"
                  ? "bg-primary shadow-primary/50"
                  : "bg-emerald-500 shadow-emerald-500/50"
              )} />
              <span className="font-semibold text-sm text-foreground">
                {user.role === "platform_admin" ? "L3XY Platform" : ((user as any).tenantName ?? "My Workspace")}
              </span>
              <Badge className="text-[10px] h-5 border shadow-none bg-primary/10 text-primary border-primary/20">
                {user.role === "platform_admin" ? "Super Admin" : ((user as any).tenantType === "agency" ? "Agency" : "Enterprise")}
              </Badge>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Quick search — ⌘K command palette over candidates/work orders/pages */}
            <QuickSearch role={user.role} />

            {/* AI agent status pill — updates every 10s */}
            <div className={cn(
              "hidden md:flex items-center gap-1.5 h-9 px-3 rounded-xl border text-xs font-medium transition-colors",
              agentPillClass,
            )}>
              <Zap className={cn("w-3.5 h-3.5", runningCount > 0 && "animate-pulse")} />
              <span>{agentPillLabel}</span>
            </div>

            <ThemeToggle />

            {/* Notification bell — links to candidate notifications page */}
            <button
              className="relative w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-all"
              onClick={() => navigate(isCandidate ? "/portal/notifications" : "/notifications")}
            >
              <Bell className="w-5 h-5" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full shadow-[0_0_6px_2px] shadow-primary/60 animate-pulse" />
            </button>
          </div>
        </header>

        {/* Page content — fades in on mount */}
        <main className="flex-1 p-6 md:p-8 animate-in fade-in duration-500 w-full">
          {children}
        </main>
      </div>
      <FloatingHelpButton />
    </div>
  );
}
