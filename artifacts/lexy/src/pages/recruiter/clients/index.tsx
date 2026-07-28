/**
 * pages/recruiter/clients/index.tsx — Clients (Tenant) List
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Used by agency / platform_admin accounts to manage their portfolio of client
 * tenants. Each client card shows the client's name, active job count, total
 * candidate count, and subscription status.
 *
 * ─── Key interactions ────────────────────────────────────────────────────────
 *   "Add Client"   — creates a new tenant + assigns the caller as the admin
 *   Client card    — navigates to /recruiter/clients/:id detail page
 *   Status badge   — shows trial / active / paused / churned
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/tenants   — list of tenants the caller can manage
 *   POST /api/tenants  — create a new tenant
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/clients  (platform_admin and agency accounts only)
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Building2, Plus, Search, Users, Briefcase, UserCheck,
  ChevronRight, Globe, GitBranch, LayoutGrid, List,
  Star, CheckCircle2, Clock, Ban, Database, Calendar, Hash, User,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn, formatDate } from "@/lib/utils";
import { useToast } from "@workspace/react-hooks/use-toast";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const planColors: Record<string, string> = {
  starter:    "bg-slate-500/10 text-slate-300 border-slate-500/20",
  growth:     "bg-blue-500/10 text-blue-300 border-blue-500/20",
  enterprise: "bg-violet-500/10 text-violet-300 border-violet-500/20",
};

const statusConfig: Record<string, { label: string; icon: any; className: string }> = {
  active:    { label: "Active",    icon: CheckCircle2, className: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
  trial:     { label: "Trial",     icon: Clock,        className: "text-amber-400 bg-amber-500/10 border-amber-500/20"       },
  suspended: { label: "Suspended", icon: Ban,          className: "text-rose-400 bg-rose-500/10 border-rose-500/20"          },
};

const clientTypeConfig: Record<string, { label: string; color: string }> = {
  direct:     { label: "Enterprise",  color: "bg-primary/10 text-primary border-primary/20"           },
  enterprise: { label: "Enterprise",  color: "bg-primary/10 text-primary border-primary/20"           },
  agency:     { label: "Agency",      color: "bg-cyan-500/10 text-cyan-300 border-cyan-500/20"        },
  sub_client: { label: "Client",      color: "bg-violet-500/10 text-violet-300 border-violet-500/20"  },
  branch:     { label: "Subsidiary",  color: "bg-orange-500/10 text-orange-300 border-orange-500/20"  },
};

function slugify(str: string) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function useClients() {
  const { user } = useAuth() as any;
  const isPlatformAdmin = user?.role === "platform_admin";
  const url = isPlatformAdmin
    ? `${BASE}/api/tenants?topLevel=true`
    : `${BASE}/api/tenants?parentId=${user?.tenantId}`;
  return useQuery({
    queryKey: ["clients", isPlatformAdmin ? "topLevel" : user?.tenantId],
    queryFn: async (): Promise<any[]> => {
      if (!isPlatformAdmin && !user?.tenantId) return [];
      const res = await fetch(url, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) {
        throw new Error(`Failed to load clients (${res.status})`);
      }
      const data = await res.json();
      // API may return either a bare array or a `{tenants: [...]}` envelope.
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.tenants)) return data.tenants;
      if (Array.isArray(data?.clients)) return data.clients;
      return [];
    },
    enabled: !!user,
    staleTime: 30000,
  });
}

/* ── Add Client Dialog ───────────────────────────────────────────────────── */
function AddClientDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth() as any;
  const isPlatformAdmin = user?.role === "platform_admin";
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [name, setName]           = useState("");
  const [slug, setSlug]           = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [industry, setIndustry]   = useState("");
  const [website, setWebsite]     = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [plan, setPlan]           = useState("starter");
  const [clientType, setClientType] = useState("enterprise");
  const [dbAccess, setDbAccess]   = useState(false);
  /* Multi-region Phase 0: only platform_admins creating root tenants pick
   * a region. Tenant_admins creating sub-clients inherit silently from
   * their own tenant — no UI control needed. */
  const [region, setRegion]       = useState("us");

  const reset = () => {
    setName(""); setSlug(""); setSlugEdited(false); setIndustry("");
    setWebsite(""); setContactEmail(""); setPlan("starter"); setClientType("enterprise"); setDbAccess(false);
    setRegion("us");
  };

  const handleNameChange = (v: string) => {
    setName(v);
    if (!slugEdited) setSlug(slugify(v));
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/tenants`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name, slug: slug || slugify(name), industry,
          website, contactEmail,
          /* Only platform_admin chooses clientType (Enterprise/Agency) —
           * that describes the parent organisation. For everyone else the
           * server defaults the child to "sub_client". */
          ...(isPlatformAdmin ? { clientType } : {}),
          /* Plan & portal-pool access are platform-level commercial
           * decisions, not something a tenant admin sets on their own
           * sub-clients. Only platform_admin sends them; for everyone
           * else the server inherits from the parent tenant. */
          ...(isPlatformAdmin ? { plan, candidateDatabaseAccess: dbAccess, region } : {}),
          parentId: isPlatformAdmin ? undefined : user?.tenantId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create client");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      toast({ title: "Client created", description: `${data.name} has been added.` });
      reset();
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message || "Could not create client.", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" /> Add New Client
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name */}
          <div className="space-y-1.5">
            <Label>Organization Name <span className="text-primary">*</span></Label>
            <Input
              placeholder="e.g. Acme Corporation"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              required
            />
          </div>

          {/* Slug */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              URL Slug <span className="text-muted-foreground text-[11px] font-normal ml-1">(auto-generated)</span>
            </Label>
            <Input
              placeholder="acme-corporation"
              value={slug}
              onChange={(e) => { setSlug(e.target.value); setSlugEdited(true); }}
            />
          </div>

          {/* Industry (+ Plan row for platform admins only) */}
          <div className={cn("grid gap-3", isPlatformAdmin ? "grid-cols-2" : "grid-cols-1")}>
            <div className="space-y-1.5">
              <Label>Industry</Label>
              <Input placeholder="e.g. Technology" value={industry} onChange={(e) => setIndustry(e.target.value)} />
            </div>
            {isPlatformAdmin && (
              <div className="space-y-1.5">
                <Label>Plan <span className="text-primary">*</span></Label>
                <Select value={plan} onValueChange={setPlan}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="starter">Starter</SelectItem>
                    <SelectItem value="growth">Growth</SelectItem>
                    <SelectItem value="enterprise">Enterprise</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Client Type — Enterprise vs Agency describes the *parent*
             organization, not each client it adds. Platform admins still
             pick this when creating a brand-new top-level tenant; tenant
             admins adding their own clients don't need to see it
             (server defaults to "sub_client"). */}
          {isPlatformAdmin && (
            <div className="space-y-1.5">
              <Label>Client Type <span className="text-primary">*</span></Label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: "enterprise", label: "Enterprise", desc: "Company hiring for itself. Can have subsidiaries & branches.", color: "border-primary/40 bg-primary/5 text-primary"   },
                  { value: "agency",     label: "Agency",     desc: "Staffing agency with its own branch office network.",       color: "border-cyan-500/40 bg-cyan-500/5 text-cyan-300" },
                ] as const).map(({ value, label, desc, color }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setClientType(value)}
                    className={cn(
                      "text-left p-3 rounded-xl border-2 transition-all",
                      clientType === value ? color : "border-border/50 bg-muted/20 text-muted-foreground hover:border-border"
                    )}
                  >
                    <p className="text-xs font-semibold">{label}</p>
                    <p className="text-[10px] mt-0.5 leading-tight">{desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Contact email + website */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Contact Email</Label>
              <Input type="email" placeholder="contact@acme.com" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Website</Label>
              <Input placeholder="acme.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>
          </div>

          {/* Data Residency Region — platform_admin only, root tenants only.
              This selection is immutable after creation. Sub-clients of a
              parent tenant inherit the parent's region automatically (the
              server enforces this), so we don't show the picker to
              tenant_admins. */}
          {isPlatformAdmin && (
            <div className="space-y-1.5">
              <Label>
                Data Residency Region <span className="text-primary">*</span>
                <span className="text-muted-foreground text-[11px] font-normal ml-2">(cannot be changed later)</span>
              </Label>
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="us">United States (us-east-1)</SelectItem>
                  <SelectItem value="in">India (ap-south-1)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Determines where this tenant's candidate, interview, and resume data is stored. Subsidiaries inherit this region.
              </p>
            </div>
          )}

          {/* Candidate portal pool access is a platform-level entitlement —
             tenant admins cannot grant it to their own sub-clients. */}
          {isPlatformAdmin && (
            <div className={cn(
              "flex items-center justify-between p-3 rounded-xl border transition-colors",
              dbAccess ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/60 bg-muted/30",
            )}>
              <div className="flex-1 min-w-0 pr-4">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Database className={cn("w-4 h-4", dbAccess ? "text-emerald-400" : "text-muted-foreground")} />
                  Candidate Portal Pool Access
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  {dbAccess
                    ? "Client can see candidates who registered through the candidate portal."
                    : "Client only sees candidates they sourced or uploaded themselves."}
                </p>
              </div>
              <Switch checked={dbAccess} onCheckedChange={setDbAccess} />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !name.trim()}
            className="gap-2"
          >
            {mutation.isPending
              ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />Creating…</>
              : <><Plus className="w-3.5 h-3.5" />Create Client</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Add Branch / Subsidiary Dialog ─────────────────────────────────────── */
function AddSubClientDialog({ open, onClose, parentClient, childType = "branch" }: { open: boolean; onClose: () => void; parentClient: any | null; childType?: "sub_client" | "branch" }) {
  /* Parent-derived child term: Enterprise → Subsidiary, anything else → Client. */
  const entityLabel = parentClient && isEnterprise(parentClient) ? "Subsidiary" : "Client";
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [name, setName]             = useState("");
  const [slug, setSlug]             = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [industry, setIndustry]     = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [website, setWebsite]       = useState("");
  const [dbAccess, setDbAccess]     = useState(false);

  const reset = () => { setName(""); setSlug(""); setSlugEdited(false); setIndustry(""); setContactEmail(""); setWebsite(""); setDbAccess(false); };

  const handleNameChange = (v: string) => {
    setName(v);
    if (!slugEdited) setSlug(slugify(v));
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/tenants`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name,
          slug: slug || slugify(name),
          plan: parentClient?.plan || "starter",
          parentId: parentClient?.id,
          clientType: childType,
          industry,
          contactEmail,
          website,
          candidateDatabaseAccess: dbAccess,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create sub-client");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["subclients", parentClient?.id] });
      toast({ title: `${entityLabel} created`, description: `${data.name} added under ${parentClient?.name}.` });
      reset();
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message || "Could not create sub-entity.", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            Add {entityLabel}
          </DialogTitle>
        </DialogHeader>

        {parentClient && (
          <div className="flex items-center gap-2 px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg text-xs mb-1">
            <Building2 className="w-3.5 h-3.5 text-primary" />
            <span className="text-muted-foreground">Under:</span>
            <span className="font-semibold text-primary">{parentClient.name}</span>
          </div>
        )}

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{entityLabel} Name <span className="text-primary">*</span></Label>
            <Input placeholder={entityLabel === "Subsidiary" ? "e.g. Acme — West Division" : "e.g. Acme Corp"} value={name} onChange={(e) => handleNameChange(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              URL Slug <span className="text-muted-foreground text-[11px] font-normal ml-1">(auto-generated)</span>
            </Label>
            <Input placeholder="acme-west-division" value={slug} onChange={(e) => { setSlug(e.target.value); setSlugEdited(true); }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Industry</Label>
              <Input placeholder="e.g. Technology" value={industry} onChange={(e) => setIndustry(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Contact Email</Label>
              <Input type="email" placeholder="contact@acme.com" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Website</Label>
            <Input placeholder="acme-west.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>

          {/* Candidate portal pool access toggle */}
          <div className={cn(
            "flex items-center justify-between p-3 rounded-xl border transition-colors",
            dbAccess ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/60 bg-muted/30",
          )}>
            <div className="flex-1 min-w-0 pr-4">
              <p className="text-sm font-medium flex items-center gap-1.5">
                <Database className={cn("w-4 h-4", dbAccess ? "text-emerald-400" : "text-muted-foreground")} />
                Candidate Portal Pool Access
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                {dbAccess
                  ? "Can see candidates who registered through the candidate portal."
                  : "Only sees candidates they sourced or uploaded themselves."}
              </p>
            </div>
            <Switch checked={dbAccess} onCheckedChange={setDbAccess} />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name.trim()} className="gap-2">
            {mutation.isPending
              ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />Creating…</>
              : <><Plus className="w-3.5 h-3.5" />Create {entityLabel}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isAgency(c: any) { return c.clientType === "agency"; }
function isEnterprise(c: any) { return c.clientType === "enterprise" || c.clientType === "direct"; }
/* Child-entity terminology derived from a tenant's own type:
 *   Agency     → "Clients"     (companies it recruits for)
 *   Enterprise → "Subsidiaries" (divisions of itself)
 *   anything else (e.g. a Subsidiary) → "Clients"   */
function subEntityLabel(c: any)    { return isEnterprise(c) ? "Subsidiaries" : "Clients"; }
function addSubEntityLabel(c: any) { return isEnterprise(c) ? "Add Subsidiary" : "Add Client"; }

/* ── Client card (grid view) ──────────────────────────────────────────────── */
function ClientCard({ client, onAddSubClient, canAddSub = true }: { client: any; onAddSubClient: (c: any, childType: "sub_client" | "branch") => void; canAddSub?: boolean }) {
  const status = statusConfig[client.status] || statusConfig.active;
  const StatusIcon = status.icon;
  const initials = client.name.split(" ").slice(0, 2).map((w: string) => w[0]).join("").toUpperCase();

  return (
    <Link href={`/clients/${client.id}`}>
      <Card className="hover-elevate cursor-pointer group transition-all hover:border-primary/30">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <Avatar className="w-10 h-10 rounded-xl border border-border shadow-sm">
                <AvatarFallback className="rounded-xl bg-primary/10 text-primary font-bold text-sm">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div>
                <h3 className="font-semibold text-sm group-hover:text-primary transition-colors flex items-center gap-1.5">
                  {client.name}
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </h3>
                <p className="text-xs text-muted-foreground">{client.industry || "General"}</p>
              </div>
            </div>
            <Badge variant="outline" className={cn("text-[10px] font-medium shrink-0", status.className)}>
              <StatusIcon className="w-2.5 h-2.5 mr-1" />{status.label}
            </Badge>
          </div>

          <div className="flex flex-wrap gap-1.5 mb-4">
            <Badge variant="outline" className={cn("text-[10px]", planColors[client.plan] || planColors.starter)}>
              {client.plan.charAt(0).toUpperCase() + client.plan.slice(1)}
            </Badge>
            <Badge variant="outline" className={cn("text-[10px]", clientTypeConfig[client.clientType]?.color || clientTypeConfig.direct.color)}>
              {clientTypeConfig[client.clientType]?.label || "Direct"}
            </Badge>
            {client.candidateDatabaseAccess && (
              <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20 gap-1">
                <Database className="w-2.5 h-2.5" /> DB Access
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-4 gap-2 pt-3 border-t border-border/60">
            {[
              { icon: GitBranch, label: subEntityLabel(client), value: client.branchCount    },
              { icon: Users,     label: "Members",                                       value: client.userCount      },
              { icon: Briefcase, label: "Requisitions",                                  value: client.jobCount       },
              { icon: UserCheck, label: "Candidates",                                    value: client.candidateCount },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="text-center">
                <p className="text-base font-bold text-foreground">{value}</p>
                <p className="text-[9px] text-muted-foreground flex items-center justify-center gap-0.5">
                  <Icon className="w-2.5 h-2.5" />{label}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Calendar className="w-3 h-3" />
              <span>{formatDate(client.createdAt)}</span>
            </div>
            {canAddSub && (isAgency(client) || isEnterprise(client)) && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAddSubClient(client, "branch"); }}
                className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-primary transition-colors"
              >
                <GitBranch className="w-3 h-3" />
                {addSubEntityLabel(client)}
              </button>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* ── Client list row ─────────────────────────────────────────────────────── */
function ClientListRow({ client, onAddSubClient, canAddSub = true }: { client: any; onAddSubClient: (c: any, childType: "sub_client" | "branch") => void; canAddSub?: boolean }) {
  const status = statusConfig[client.status] || statusConfig.active;
  const StatusIcon = status.icon;
  const initials = client.name.split(" ").slice(0, 2).map((w: string) => w[0]).join("").toUpperCase();

  return (
    <Link href={`/clients/${client.id}`}>
      <div className="flex items-center gap-4 p-4 rounded-xl hover:bg-muted/40 cursor-pointer group transition-all border border-transparent hover:border-border">
        <Avatar className="w-9 h-9 rounded-xl border border-border">
          <AvatarFallback className="rounded-xl bg-primary/10 text-primary font-bold text-xs">{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm group-hover:text-primary transition-colors">{client.name}</span>
            <Badge variant="outline" className={cn("text-[10px]", clientTypeConfig[client.clientType]?.color)}>
              {clientTypeConfig[client.clientType]?.label}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{client.industry || "—"} · {client.contactEmail || client.website || "—"}</p>
        </div>
        <div className="hidden sm:flex items-center gap-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><GitBranch className="w-3 h-3" />{client.branchCount} {subEntityLabel(client).toLowerCase()}</span>
          <span className="flex items-center gap-1"><Users className="w-3 h-3" />{client.userCount} members</span>
          <span className="flex items-center gap-1"><Briefcase className="w-3 h-3" />{client.jobCount} reqs</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("text-[10px]", planColors[client.plan])}>{client.plan.charAt(0).toUpperCase() + client.plan.slice(1)}</Badge>
          <Badge variant="outline" className={cn("text-[10px]", status.className)}>
            <StatusIcon className="w-2.5 h-2.5 mr-1" />{status.label}
          </Badge>
        </div>
        {canAddSub && (isAgency(client) || isEnterprise(client)) && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAddSubClient(client, "branch"); }}
            className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-primary transition-colors whitespace-nowrap"
          >
            <GitBranch className="w-3 h-3" />
            {addSubEntityLabel(client)}
          </button>
        )}
        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </Link>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */
export default function ClientsPage() {
  const { user } = useAuth() as any;
  const isPlatformAdmin = user?.role === "platform_admin";
  /* recruiter_admin gets a read-only directory: they can browse every client
   * under their agency, but creating clients stays with tenant/platform admins
   * (the backend rejects their POST /tenants anyway). */
  const canCreate = isPlatformAdmin || user?.role === "tenant_admin";

  const [search, setSearch]     = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [filter, setFilter]     = useState<"all" | "active" | "trial" | "suspended">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "agency" | "enterprise">("all");
  const [showAdd, setShowAdd]   = useState(false);
  const [subClientParent, setSubClientParent] = useState<any | null>(null);
  const [subClientChildType, setSubClientChildType] = useState<"sub_client" | "branch">("branch");

  const { data: clients = [], isLoading } = useClients();

  const filtered = clients.filter((c: any) => {
    const matchSearch = !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.industry?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || c.status === filter;
    const matchType = typeFilter === "all" || (typeFilter === "agency" ? isAgency(c) : isEnterprise(c));
    return matchSearch && matchFilter && matchType;
  });

  const stats = {
    total:         clients.length,
    agencies:      clients.filter((c: any) => isAgency(c)).length,
    enterprises:   clients.filter((c: any) => isEnterprise(c)).length,
    active:        clients.filter((c: any) => c.status === "active").length,
    trial:         clients.filter((c: any) => c.status === "trial").length,
    totalSubEntities: clients.reduce((s: number, c: any) => s + (c.branchCount || 0), 0),
  };

  return (
    <AppLayout>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="page-title flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <Building2 className="w-5 h-5" />
            </div>
            {isPlatformAdmin ? "Tenant Management" : "Client Management"}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {isPlatformAdmin
              ? "View and manage all tenants subscribed to the L3xy platform."
              : "Manage client organizations, branch offices, and team members."}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setShowAdd(true)} className="shadow-md shadow-primary/20 gap-2 hover-elevate active-elevate-2">
            <Plus className="w-4 h-4" /> {isPlatformAdmin ? "Add Tenant" : "Add Client"}
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: isPlatformAdmin ? "Total Tenants" : "Total Clients", value: stats.total,            icon: Building2,    glow: "from-primary/20 to-primary/5 text-primary"             },
          { label: "Agencies",                                           value: stats.agencies,         icon: Users,        glow: "from-cyan-500/20 to-cyan-500/5 text-cyan-400"           },
          { label: "Enterprises",                                        value: stats.enterprises,      icon: Building2,    glow: "from-violet-500/20 to-violet-500/5 text-violet-400"     },
          { label: "Sub-entities",                                       value: stats.totalSubEntities, icon: GitBranch,    glow: "from-orange-500/20 to-orange-500/5 text-orange-400"     },
        ].map(({ label, value, icon: Icon, glow }) => (
          <div key={label} className="relative rounded-xl border border-white/8 p-6 bg-card hover-elevate overflow-hidden" style={{ boxShadow: "0 1px 3px rgba(15,23,42,0.05)" }}>
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <div className="flex items-center gap-3">
              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br border border-white/10", glow)}>
                <Icon className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
                <p className="text-2xl font-bold">{isLoading ? "—" : value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Search + Filter bar */}
      <div className="flex flex-col gap-3 mb-6">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder={isPlatformAdmin ? "Search tenants by name or industry…" : "Search clients by name or industry…"} className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="flex gap-2">
            {(["all", "active", "trial", "suspended"] as const).map((f) => (
              <Button key={f} variant={filter === f ? "default" : "outline"} size="sm" onClick={() => setFilter(f)} className="capitalize">
                {f}
              </Button>
            ))}
          </div>
          <div className="flex gap-1 border border-border/60 rounded-lg p-1">
            <Button variant={viewMode === "grid" ? "default" : "ghost"} size="icon" aria-label="Grid view" aria-pressed={viewMode === "grid"} className="h-7 w-7" onClick={() => setViewMode("grid")}>
              <LayoutGrid className="w-3.5 h-3.5" />
            </Button>
            <Button variant={viewMode === "list" ? "default" : "ghost"} size="icon" aria-label="List view" aria-pressed={viewMode === "list"} className="h-7 w-7" onClick={() => setViewMode("list")}>
              <List className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        {/* Type filter row */}
        <div className="flex gap-2">
          {([
            { value: "all",        label: "All Types" },
            { value: "enterprise", label: "Enterprises" },
            { value: "agency",     label: "Agencies" },
          ] as const).map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTypeFilter(value)}
              className={cn(
                "text-[11px] font-medium px-3 py-1.5 rounded-full border transition-all",
                typeFilter === value
                  ? value === "agency"
                    ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
                    : value === "enterprise"
                    ? "bg-primary/15 text-primary border-primary/40"
                    : "bg-muted text-foreground border-border"
                  : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
              )}
            >
              {label}
              {value !== "all" && (
                <span className="ml-1.5 opacity-60">
                  {value === "agency" ? stats.agencies : stats.enterprises}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Client list */}
      {isLoading ? (
        <div className={cn(viewMode === "grid" ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" : "space-y-2")}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-48 rounded-xl bg-muted/30 animate-pulse border border-white/5" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground bg-card border border-dashed border-border/40 rounded-xl">
          <Building2 className="w-12 h-12 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No clients found</p>
          <p className="text-sm mt-1">{canCreate ? "Try adjusting your search or add a new client." : "Try adjusting your search."}</p>
          {canCreate && (
            <Button onClick={() => setShowAdd(true)} className="mt-4 gap-2" size="sm">
              <Plus className="w-4 h-4" /> Add First Client
            </Button>
          )}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((c: any) => (
            <ClientCard key={c.id} client={c} canAddSub={canCreate} onAddSubClient={(cl, ct) => { setSubClientParent(cl); setSubClientChildType(ct); }} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-2">
            <div className="divide-y divide-border/40">
              {filtered.map((c: any) => (
                <ClientListRow key={c.id} client={c} canAddSub={canCreate} onAddSubClient={(cl, ct) => { setSubClientParent(cl); setSubClientChildType(ct); }} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <AddClientDialog open={showAdd} onClose={() => setShowAdd(false)} />
      <AddSubClientDialog
        open={!!subClientParent}
        onClose={() => setSubClientParent(null)}
        parentClient={subClientParent}
        childType={subClientChildType}
      />
    </AppLayout>
  );
}
