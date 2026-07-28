/**
 * pages/recruiter/clients/[id].tsx — Client (Tenant) Detail Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Full management view for a single client tenant. Used by agency / platform
 * admin accounts to manage client settings, users, jobs, and subscription.
 *
 * ─── Tabs ────────────────────────────────────────────────────────────────────
 *   Overview      — client profile: company name, industry, HQ location,
 *                   logo, website, custom email domain
 *   Team          — list of users under this tenant + "Invite Member" flow
 *   Jobs          — active job postings for this client
 *   Analytics     — hiring metrics for this client
 *   Settings      — subscription tier, feature flags, branding config
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/tenants/:id      — tenant row
 *   GET /api/users?tenantId=  — users for this tenant
 *   PATCH /api/tenants/:id    — update tenant settings
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/clients/:id
 */
import { useState, useEffect } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  Building2, ArrowLeft, Globe, Mail, MapPin, GitBranch, Users,
  Briefcase, UserCheck, Shield, User, UserCog, Plus, ChevronRight,
  CheckCircle2, Clock, Ban, Database, ExternalLink, Star, Edit,
  Phone, Calendar, Activity, Video, TrendingUp, FileText, Copy, Loader2,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from "recharts";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const planColors: Record<string, string> = {
  starter: "bg-slate-500/10 text-slate-400 border-slate-500/25",
  growth: "bg-blue-500/10 text-blue-400 border-blue-500/25",
  enterprise: "bg-violet-500/10 text-violet-400 border-violet-500/25",
};

const statusConfig: Record<string, { label: string; icon: any; className: string }> = {
  active: { label: "Active", icon: CheckCircle2, className: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25" },
  trial: { label: "Trial", icon: Clock, className: "text-amber-400 bg-amber-500/10 border-amber-500/25" },
  suspended: { label: "Suspended", icon: Ban, className: "text-red-400 bg-red-500/10 border-red-500/25" },
};

const roleConfig: Record<string, { label: string; icon: any; color: string }> = {
  platform_admin: { label: "Platform Admin", icon: Shield, color: "text-red-400 bg-red-500/10 border-red-500/25" },
  tenant_admin: { label: "Admin", icon: Shield, color: "text-violet-400 bg-violet-500/10 border-violet-500/25" },
  recruiter_admin: { label: "Recruiter Admin", icon: UserCog, color: "text-amber-400 bg-amber-500/10 border-amber-500/25" },
  recruiter: { label: "Recruiter", icon: User, color: "text-blue-400 bg-blue-500/10 border-blue-500/25" },
  hiring_manager: { label: "Hiring Manager", icon: UserCog, color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25" },
  interviewer: { label: "Interviewer", icon: UserCog, color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/25" },
  candidate: { label: "Candidate", icon: User, color: "text-slate-400 bg-slate-500/10 border-slate-500/25" },
};

function useTenant(id: string) {
  return useQuery({
    queryKey: ["tenant", id],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${id}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
  });
}

function useBranches(id: string) {
  return useQuery({
    queryKey: ["branches", id],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${id}/branches`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json() as Promise<any[]>;
    },
  });
}

function useMembers(id: string) {
  return useQuery({
    queryKey: ["members", id],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${id}/members`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return [];
      const data = await res.json();
      if (Array.isArray(data)) return data;
      if (Array.isArray((data as any)?.members)) return (data as any).members;
      return [];
    },
  });
}

function useActivity(id: string) {
  return useQuery({
    queryKey: ["tenant-activity", id],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${id}/activity`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    refetchInterval: 30000,
  });
}

function useSubClients(id: string) {
  return useQuery({
    queryKey: ["sub-clients", id],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${id}/sub-clients`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json() as Promise<any[]>;
    },
  });
}

function useParentTenant(parentId: string | null | undefined) {
  return useQuery({
    queryKey: ["tenant", parentId],
    enabled: !!parentId,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${parentId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
  });
}

function isAgency(c: any) { return c?.clientType === "agency"; }
function isEnterprise(c: any) { return c?.clientType === "enterprise" || c?.clientType === "direct"; }
function isSubClient(c: any) { return c?.clientType === "sub_client"; }

function BranchCard({ branch }: { branch: any }) {
  const status = statusConfig[branch.status] || statusConfig.active;
  const StatusIcon = status.icon;
  const initials = branch.name.split(" ").filter((w: string) => w !== "—").slice(-2).map((w: string) => w[0]).join("").toUpperCase();

  return (
    <Link href={`/clients/${branch.id}`}>
      <Card className="hover-elevate cursor-pointer group hover:border-primary/30 transition-all">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2.5">
              <Avatar className="w-8 h-8 rounded-lg border border-border">
                <AvatarFallback className="rounded-lg bg-primary/10 text-primary font-bold text-xs">{initials}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium text-sm group-hover:text-primary transition-colors">{branch.name}</p>
                <p className="text-[11px] text-muted-foreground">{branch.address || branch.contactEmail || "—"}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className={cn("text-[10px]", status.className)}>
                <StatusIcon className="w-2.5 h-2.5 mr-1" />{status.label}
              </Badge>
              <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border/60">
            {[
              { label: "Members", value: branch.userCount, icon: Users },
              { label: "Work Orders", value: branch.jobCount, icon: Briefcase },
              { label: "Candidates", value: branch.candidateCount, icon: UserCheck },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="text-center">
                <p className="text-sm font-bold">{value}</p>
                <p className="text-[9px] text-muted-foreground flex items-center justify-center gap-0.5">
                  <Icon className="w-2.5 h-2.5" />{label}
                </p>
              </div>
            ))}
          </div>
          {branch.candidateDatabaseAccess && (
            <div className="mt-2.5 pt-2 border-t border-border/40">
              <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/25 gap-1 w-full justify-center">
                <Database className="w-2.5 h-2.5" /> Lexy Candidate Database Access
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

/* Roles a caller may assign when editing a member, keyed by the caller's role. */
const ASSIGNABLE_ROLES: Record<string, string[]> = {
  platform_admin: ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager", "interviewer"],
  tenant_admin: ["tenant_admin", "recruiter_admin", "recruiter", "hiring_manager", "interviewer"],
  recruiter_admin: ["recruiter", "hiring_manager"],
};

/* Whether the caller is allowed to edit a given member. Mirrors the
 * authorization enforced by PATCH /api/users/:userId on the backend. */
function canManageMember(callerRole: string | undefined, callerTenantId: string | undefined, member: any): boolean {
  if (!callerRole) return false;
  if (member.role === "platform_admin" && callerRole !== "platform_admin") return false;
  if (callerRole === "platform_admin" || callerRole === "tenant_admin") return true;
  // Recruiter admins may only manage line staff (recruiters / hiring managers)
  // in their own tenant — mirrors PATCH /api/users/:userId enforcement.
  if (callerRole === "recruiter_admin") {
    return ["recruiter", "hiring_manager"].includes(member.role) && member.tenantId === callerTenantId;
  }
  return false;
}

function EditMemberDialog({
  open, onClose, member, tenantId, callerRole,
}: { open: boolean; onClose: () => void; member: any; tenantId: string; callerRole: string }) {
  const { user } = useAuth() as any;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState(member.role);
  const [status, setStatus] = useState<string>(member.status === "suspended" ? "suspended" : "active");

  // Re-seed the form whenever a different member is opened.
  useEffect(() => {
    setName(member.name);
    setRole(member.role);
    setStatus(member.status === "suspended" ? "suspended" : "active");
  }, [member.id, member.name, member.role, member.status]);

  const roleOptions = ASSIGNABLE_ROLES[callerRole] || [];
  // Always include the member's current role so the select can render it even
  // if it's outside the caller's normally-assignable set.
  const options = roleOptions.includes(role) ? roleOptions : [role, ...roleOptions];
  const isSelf = user?.id === member.id;

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (name.trim() && name.trim() !== member.name) body.name = name.trim();
      if (role !== member.role) body.role = role;
      const currentStatus = member.status === "suspended" ? "suspended" : "active";
      if (status !== currentStatus) body.status = status;
      if (Object.keys(body).length === 0) return null;
      const res = await fetch(`${BASE}/api/users/${member.id}`, {
        credentials: "include",
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || e.error || "Failed to update member"); }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
      toast({ title: data ? "Member updated" : "No changes", description: data ? `${name}'s details were saved.` : "Nothing was changed." });
      onClose();
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Edit className="w-4 h-4 text-primary" /> Edit Team Member</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border border-border/60 rounded-lg text-xs">
            <Mail className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground truncate">{member.email}</span>
          </div>
          <div>
            <Label className="mb-1.5 block">Full Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {options.map((r) => (
                  <SelectItem key={r} value={r}>{roleConfig[r]?.label || r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1.5 block">Account Status</Label>
            <Select value={status} onValueChange={setStatus} disabled={isSelf}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
            {isSelf && <p className="text-[11px] text-muted-foreground mt-1">You can't suspend your own account.</p>}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="gap-2">
            {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({ member, tenantId, callerRole, callerTenantId }: { member: any; tenantId: string; callerRole?: string; callerTenantId?: string }) {
  const role = roleConfig[member.role] || roleConfig.recruiter;
  const RoleIcon = role.icon;
  const initials = member.name.split(" ").slice(0, 2).map((w: string) => w[0]).join("").toUpperCase();
  const [editing, setEditing] = useState(false);
  const canEdit = canManageMember(callerRole, callerTenantId, member);

  return (
    <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-muted/40 transition-colors group">
      <Avatar className="w-9 h-9 border border-border">
        <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">{initials}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{member.name}</p>
        <p className="text-xs text-muted-foreground truncate">{member.email}</p>
      </div>
      {member.status === "suspended" && (
        <Badge variant="outline" className="text-[10px] gap-1 border-red-500/40 text-red-400 bg-red-500/10">
          <Ban className="w-2.5 h-2.5" />Suspended
        </Badge>
      )}
      <Badge variant="outline" className={cn("text-[10px] gap-1", role.color)}>
        <RoleIcon className="w-2.5 h-2.5" />{role.label}
      </Badge>
      {member.status === "pending" && (
        <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-400 bg-amber-500/10">
          Pending
        </Badge>
      )}
      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="w-7 h-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => setEditing(true)}
          aria-label={`Edit ${member.name}`}
        >
          <Edit className="w-3.5 h-3.5" />
        </Button>
      )}
      {canEdit && editing && (
        <EditMemberDialog
          open={editing}
          onClose={() => setEditing(false)}
          member={member}
          tenantId={tenantId}
          callerRole={callerRole!}
        />
      )}
    </div>
  );
}

function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

function SubClientCard({ sc }: { sc: any }) {
  const status = statusConfig[sc.status] || statusConfig.active;
  const StatusIcon = status.icon;
  const initials = sc.name.split(" ").slice(0, 2).map((w: string) => w[0]).join("").toUpperCase();
  return (
    <Link href={`/clients/${sc.id}`}>
      <Card className="hover-elevate cursor-pointer group hover:border-cyan-500/40 transition-all">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2.5">
              <Avatar className="w-8 h-8 rounded-lg border border-border">
                <AvatarFallback className="rounded-lg bg-cyan-500/10 text-cyan-300 font-bold text-xs">{initials}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium text-sm group-hover:text-cyan-300 transition-colors">{sc.name}</p>
                <p className="text-[11px] text-muted-foreground">{sc.industry || sc.contactEmail || "—"}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className={cn("text-[10px]", status.className)}>
                <StatusIcon className="w-2.5 h-2.5 mr-1" />{status.label}
              </Badge>
              <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border/60">
            {[
              { label: "Branches",    value: sc.branchCount,    icon: GitBranch },
              { label: "Work Orders", value: sc.jobCount,       icon: Briefcase },
              { label: "Members",     value: sc.userCount,      icon: Users     },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="text-center">
                <p className="text-sm font-bold">{value}</p>
                <p className="text-[9px] text-muted-foreground flex items-center justify-center gap-0.5">
                  <Icon className="w-2.5 h-2.5" />{label}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function AddChildDialog({
  open, onClose, parentId, parentName, childType, label,
}: { open: boolean; onClose: () => void; parentId: string; parentName: string; childType: "branch" | "sub_client"; label?: string }) {
  /* `label` (e.g. "Add Client" or "Add Subsidiary") is the parent-derived
   * term passed in by the caller; fall back to the generic "Add Entity"
   * if a caller forgets to set it. */
  const dialogTitle = label ?? "Add Entity";
  const nameLabel   = (label ?? "Entity").replace(/^Add\s+/, "") + " Name";
  const namePlaceholder = "e.g. Acme Corp";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [industry, setIndustry] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  const reset = () => { setName(""); setSlug(""); setSlugEdited(false); setIndustry(""); setContactEmail(""); };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/tenants`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name, slug: slug || slugify(name), plan: "starter", parentId, clientType: childType, industry, contactEmail, candidateDatabaseAccess: false }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Failed"); }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["branches", parentId] });
      queryClient.invalidateQueries({ queryKey: ["sub-clients", parentId] });
      queryClient.invalidateQueries({ queryKey: ["tenant", parentId] });
      toast({ title: `${(label ?? "Entity").replace(/^Add\s+/, "")} added`, description: `${data.name} added under ${parentName}.` });
      reset(); onClose();
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            {dialogTitle}
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg text-xs mb-1">
          <Building2 className="w-3.5 h-3.5 text-primary" />
          <span className="text-muted-foreground">Under:</span>
          <span className="font-semibold text-primary">{parentName}</span>
        </div>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{nameLabel} <span className="text-primary">*</span></Label>
            <Input placeholder={namePlaceholder} value={name}
              onChange={(e) => { setName(e.target.value); if (!slugEdited) setSlug(slugify(e.target.value)); }} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">URL Slug <span className="text-muted-foreground text-[11px] ml-1">(auto)</span></Label>
            <Input value={slug} onChange={(e) => { setSlug(e.target.value); setSlugEdited(true); }} />
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
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name.trim()} className="gap-2">
            {mutation.isPending
              ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />Creating…</>
              : <><Plus className="w-3.5 h-3.5" />{dialogTitle}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ClientDetailPage() {
  const [, params] = useRoute("/clients/:id");
  const id = params?.id || "";
  const [activeTab, setActiveTab] = useState("overview");

  const [showAddChild, setShowAddChild] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", role: "recruiter", tenantId: id });
  const [inviteResult, setInviteResult] = useState<{
    token: string;
    email: string;
    role: string;
    acceptUrl?: string;
    emailSent?: boolean;
    emailSimulated?: boolean;
    emailConfigured?: boolean;
  } | null>(null);
  const [inviting, setInviting] = useState(false);
  const { user } = useAuth() as any;
  const { toast } = useToast();

  const queryClient = useQueryClient();
  const [togglingDbAccess, setTogglingDbAccess] = useState(false);
  const [dbSearch, setDbSearch] = useState("");

  const { data: client, isLoading } = useTenant(id);
  const { data: branches = [] } = useBranches(id);
  const { data: subClients = [] } = useSubClients(id);
  const { data: members = [] } = useMembers(id);
  const { data: activity } = useActivity(id);
  const { data: parentTenant } = useParentTenant(client?.parentId);

  const { data: platformDb } = useQuery<{ access: boolean; total: number; candidates: any[]; message?: string }>({
    queryKey: ["platform-db", id, dbSearch],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${id}/candidate-database?search=${encodeURIComponent(dbSearch)}&limit=100`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    enabled: activeTab === "database" && !!id,
    staleTime: 30000,
  });

  const handleToggleDbAccess = async () => {
    if (!client) return;
    setTogglingDbAccess(true);
    try {
      const res = await fetch(`${BASE}/api/tenants/${id}/database-access`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ enabled: !client.candidateDatabaseAccess }),
      });
      if (!res.ok) throw new Error("Failed");
      await queryClient.invalidateQueries({ queryKey: ["tenant", id] });
      await queryClient.invalidateQueries({ queryKey: ["platform-db", id] });
      toast({
        title: client.candidateDatabaseAccess ? "Platform database access revoked" : "Platform database access granted",
        description: client.candidateDatabaseAccess
          ? `${client.name} can no longer access the platform candidate pool.`
          : `${client.name} can now search and source from the platform candidate pool.`,
      });
    } catch {
      toast({ title: "Failed to update access", variant: "destructive" });
    } finally {
      setTogglingDbAccess(false);
    }
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-4 animate-pulse">
          <div className="h-10 w-64 bg-muted rounded-xl" />
          <div className="h-40 bg-muted rounded-xl" />
        </div>
      </AppLayout>
    );
  }

  if (!client || client.error) {
    return (
      <AppLayout>
        <div className="text-center py-16 text-muted-foreground">
          <Building2 className="w-12 h-12 mx-auto mb-4 opacity-20" />
          <p className="font-medium">Client not found</p>
          <Link href="/clients"><Button variant="outline" className="mt-4 gap-2"><ArrowLeft className="w-4 h-4" /> Back to Clients</Button></Link>
        </div>
      </AppLayout>
    );
  }

  const status = statusConfig[client.status] || statusConfig.active;
  const StatusIcon = status.icon;
  const initials = client.name.split(" ").slice(0, 2).map((w: string) => w[0]).join("").toUpperCase();
  /* Label sub-tenants based on the parent's clientType:
   *   parent = Enterprise → "Subsidiary" (a division of the enterprise)
   *   anything else       → "Client"     (a company the parent works with).
   * "Subsidiary" is reserved for Enterprise parents — Agency or generic
   * tenants have *clients*, not subsidiaries. Root tenants keep their own
   * Agency / Enterprise label. */
  const parentIsEnterprise = parentTenant && isEnterprise(parentTenant);
  const typeLabel = isAgency(client)
    ? "Agency"
    : isEnterprise(client)
    ? "Enterprise"
    : parentIsEnterprise ? "Subsidiary" : "Client";
  const typeColor = isAgency(client)
    ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/25"
    : isEnterprise(client)
    ? "bg-primary/10 text-primary border-primary/25"
    : parentIsEnterprise
    ? "bg-orange-500/10 text-orange-300 border-orange-500/25"
    : "bg-violet-500/10 text-violet-300 border-violet-500/25";

  /* Plan + subscription-status badges are Lexy-side commercial info and
   * should only surface to platform admins. Tenant admins managing their
   * own clients shouldn't see (or be confused by) "Starter Plan / Trial". */
  const isPlatformAdmin = user?.role === "platform_admin";
  /* recruiter_admin gets read-only access to this page: write actions
   * (edit client, add child, invite member) stay with tenant/platform admins
   * — the backend rejects their writes anyway. */
  const canManageClients = isPlatformAdmin || user?.role === "tenant_admin";

  const canHaveChildren = isAgency(client) || isEnterprise(client);
  const childTypeToCrate: "branch" | "sub_client" = "branch";
  /* Hierarchy semantics:
   *   Agency      → its children are "Clients"      (companies it recruits for)
   *   Enterprise  → its children are "Subsidiaries" (divisions of itself)
   *   Subsidiary  → its children are "Clients"      (companies that subsidiary works with)
   * So the only place "Subsidiary" appears as a child term is under an Enterprise. */
  const childTerm       = isEnterprise(client) ? "Subsidiary" : "Client";
  const childTermPlural = childTerm + "s";
  const addChildLabel   = `Add ${childTerm}`;

  const childrenCount = branches.length;

  const safeMembers = Array.isArray(members) ? members : [];
  const roleBreakdown = safeMembers.reduce((acc: any, m: any) => {
    acc[m.role] = (acc[m.role] || 0) + 1;
    return acc;
  }, {});

  async function handleInvite() {
    if (!inviteForm.email || !inviteForm.name) {
      toast({ title: "Email and name are required", variant: "destructive" });
      return;
    }
    setInviting(true);
    try {
      const res = await fetch(`${BASE}/api/staff-invites`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ ...inviteForm, tenantId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Failed to generate invite", variant: "destructive" });
        return;
      }
      setInviteResult(data);
      if (data.emailSent) {
        toast({ title: `Invite email sent to ${data.email}` });
      } else if (data.emailSimulated) {
        toast({ title: "Invite created", description: "Email delivery isn't configured — share the link manually." });
      }
    } catch {
      toast({ title: "Failed to generate invite", variant: "destructive" });
    } finally {
      setInviting(false);
    }
  }

  // Prefer the absolute URL the backend used in the email, so the manual-share
  // fallback link always matches what the recipient received. Fall back to a
  // client-side reconstruction only if the backend didn't supply one.
  const inviteLink = inviteResult
    ? (inviteResult.acceptUrl
        || `${window.location.origin}${BASE}/accept-team-invite?token=${inviteResult.token}`)
    : "";

  return (
    <AppLayout>
      <div className="mb-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4 -ml-0.5">
          <Link href="/clients"><span className="hover:text-foreground cursor-pointer transition-colors">All Clients</span></Link>
          {parentTenant && (
            <>
              <ChevronRight className="w-3 h-3" />
              <Link href={`/clients/${parentTenant.id}`}><span className="hover:text-foreground cursor-pointer transition-colors">{parentTenant.name}</span></Link>
            </>
          )}
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{client.name}</span>
        </div>

        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar className="w-14 h-14 rounded-2xl border-2 border-border shadow-sm">
              <AvatarFallback className={cn("rounded-2xl font-bold text-lg",
                isAgency(client) ? "bg-cyan-500/10 text-cyan-300" : "bg-primary/10 text-primary"
              )}>{initials}</AvatarFallback>
            </Avatar>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="page-title">{client.name}</h1>
                <Badge variant="outline" className={cn("text-[10px]", typeColor)}>{typeLabel}</Badge>
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {isPlatformAdmin && (
                  <>
                    <Badge variant="outline" className={cn("text-[10px]", planColors[client.plan])}>
                      {client.plan.charAt(0).toUpperCase() + client.plan.slice(1)} Plan
                    </Badge>
                    <Badge variant="outline" className={cn("text-[10px]", status.className)}>
                      <StatusIcon className="w-2.5 h-2.5 mr-1" />{status.label}
                    </Badge>
                  </>
                )}
                {client.candidateDatabaseAccess && (
                  <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/25 gap-1">
                    <Database className="w-2.5 h-2.5" /> DB Access
                  </Badge>
                )}
                {client.industry && <span className="text-xs text-muted-foreground">{client.industry}</span>}
              </div>
            </div>
          </div>
          {canManageClients && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-2 hover-elevate">
                <Edit className="w-3.5 h-3.5" /> Edit Client
              </Button>
              {canHaveChildren && (
                <Button size="sm" className="gap-2 shadow-lg shadow-primary/20 hover-elevate" onClick={() => setShowAddChild(true)}>
                  <Plus className="w-3.5 h-3.5" /> {addChildLabel}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={cn("grid gap-4 mb-6 grid-cols-2", isSubClient(client) ? "md:grid-cols-3" : "md:grid-cols-4")}>
        {[
          /* Sub-clients are companies the parent tenant recruits *for* —
             they don't have their own org hierarchy or staff, so we drop
             the Subsidiaries and Team Members tiles. Jobs + candidates
             attributed to the sub-client are still meaningful. */
          ...(isSubClient(client) ? [] : [
            {
              label: isAgency(client) ? "Branch Offices" : "Subsidiaries",
              value: childrenCount,
              icon: GitBranch,
              color: isAgency(client) ? "text-cyan-400 bg-cyan-500/10" : "text-violet-400 bg-violet-500/10",
            },
            { label: "Team Members", value: members.length, icon: Users, color: "text-blue-400 bg-blue-500/10" },
          ]),
          { label: "Requisitions", value: client.jobCount, icon: Briefcase, color: "text-primary bg-primary/10" },
          { label: "Candidates", value: client.candidateCount, icon: UserCheck, color: "text-emerald-400 bg-emerald-500/10" },
          ...(isSubClient(client) ? [
            { label: "Open Roles", value: client.openJobCount ?? 0, icon: Briefcase, color: "text-amber-400 bg-amber-500/10" },
          ] : []),
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="hover-elevate">
            <CardContent className="p-4 flex items-center gap-3">
              <div className={cn("p-2 rounded-xl", color)}>
                <Icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <p className="text-xl font-bold">{value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <Activity className="w-3.5 h-3.5" /> Activity
          </TabsTrigger>
          {/* Branches/Subsidiaries + Team Members tabs only make sense for
              a real tenant. Sub-clients are companies the parent tenant
              recruits *for* — their "team" is the parent's recruiters,
              managed at /team. */}
          {!isSubClient(client) && (
            <>
              <TabsTrigger value="branches">
                {childTermPlural}
                {branches.length > 0 && <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1">{branches.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="members">
                Team Members
                {members.length > 0 && <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1">{members.length}</Badge>}
              </TabsTrigger>
            </>
          )}
          <TabsTrigger value="database">Candidate Database</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className={cn("grid gap-6", isSubClient(client) ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2")}>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Client Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { icon: Building2, label: "Organization", value: client.name },
                  { icon: Globe, label: "Website", value: client.website, link: client.website },
                  { icon: Mail, label: "Contact Email", value: client.contactEmail },
                  { icon: MapPin, label: "Address", value: client.address },
                  { icon: Calendar, label: "Client Since", value: client.createdAt ? format(parseISO(client.createdAt), "MMM d, yyyy") : "—" },
                ].map(({ icon: Icon, label, value, link }) => (
                  value ? (
                    <div key={label} className="flex items-start gap-3 text-sm">
                      <Icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                      <div>
                        <p className="text-[11px] text-muted-foreground">{label}</p>
                        {link ? (
                          <a href={link} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1">
                            {value} <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <p className="font-medium">{value}</p>
                        )}
                      </div>
                    </div>
                  ) : null
                ))}
              </CardContent>
            </Card>

            {/* Team Composition is only meaningful for real tenants.
                For sub_clients the "team" is their parent tenant's
                recruiters, shown on /team — not duplicated here. */}
            {!isSubClient(client) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Team Composition</CardTitle>
              </CardHeader>
              <CardContent>
                {members.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Users className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">No team members yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(roleBreakdown).map(([role, count]) => {
                      const cfg = roleConfig[role] || roleConfig.recruiter;
                      const RoleIcon = cfg.icon;
                      const pct = Math.round(((count as number) / members.length) * 100);
                      return (
                        <div key={role}>
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-1.5 text-xs">
                              <RoleIcon className="w-3 h-3 text-muted-foreground" />
                              <span>{cfg.label}</span>
                            </div>
                            <span className="text-xs font-medium">{count as number}</span>
                          </div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                    <Separator className="my-3" />
                    <div className="text-xs text-muted-foreground flex justify-between">
                      <span>Total Members</span>
                      <span className="font-semibold text-foreground">{members.length}</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            )}

            {/* Platform Access — Lexy-side entitlements (candidate pool,
                proctoring, plan tier). These are commercial decisions made
                by platform ops, not anything a tenant admin manages on their
                own clients. Only platform_admin sees this card. */}
            {isPlatformAdmin && (
            <Card className="md:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Platform Access</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className={cn("rounded-xl border p-4", client.candidateDatabaseAccess ? "border-emerald-500/25 bg-emerald-500/8" : "border-border bg-muted/10")}>
                    <div className="flex items-center gap-2 mb-1">
                      <Database className={cn("w-4 h-4", client.candidateDatabaseAccess ? "text-emerald-400" : "text-muted-foreground")} />
                      <span className="text-xs font-semibold">Platform Candidate Pool</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {client.candidateDatabaseAccess
                        ? "This tenant can search and source from the platform's shared candidate pool."
                        : "Access to the platform's global talent pool is not enabled."}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="outline" className={cn("text-[10px]", client.candidateDatabaseAccess ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25" : "text-muted-foreground")}>
                        {client.candidateDatabaseAccess ? "Enabled" : "Disabled"}
                      </Badge>
                      {user?.role === "platform_admin" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn("h-5 text-[10px] px-2 py-0", client.candidateDatabaseAccess ? "border-red-500/30 text-red-400 hover:bg-red-500/10" : "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10")}
                          onClick={handleToggleDbAccess}
                          disabled={togglingDbAccess}
                        >
                          {togglingDbAccess ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : client.candidateDatabaseAccess ? "Revoke" : "Grant"}
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Shield className="w-4 h-4 text-primary" />
                      <span className="text-xs font-semibold">AI Proctoring</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">AI-powered interview proctoring and integrity monitoring enabled.</p>
                    <Badge variant="outline" className="mt-2 text-[10px] text-emerald-400 bg-emerald-500/10 border-emerald-500/25">Enabled</Badge>
                  </div>
                  <div className={cn("rounded-xl border p-4", client.plan === "enterprise" ? "border-violet-500/25 bg-violet-500/8" : "border-border bg-muted/10")}>
                    <div className="flex items-center gap-2 mb-1">
                      <Star className={cn("w-4 h-4", client.plan === "enterprise" ? "text-violet-400" : "text-muted-foreground")} />
                      <span className="text-xs font-semibold">Plan Tier</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground capitalize">
                      {client.plan} plan — {client.plan === "enterprise" ? "unlimited seats, priority support, custom workflows." : client.plan === "growth" ? "up to 10 seats, advanced features." : "up to 3 seats, core features."}
                    </p>
                    <Badge variant="outline" className={cn("mt-2 text-[10px]", planColors[client.plan])}>
                      {client.plan.charAt(0).toUpperCase() + client.plan.slice(1)}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
            )}
          </div>
        </TabsContent>

        {/* ── Activity Tab ────────────────────────────────────────────── */}
        <TabsContent value="activity">
          {!activity || !activity.pipeline || !activity.interviews || !activity.applications ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[1,2,3].map(i => <div key={i} className="h-32 rounded-xl bg-muted/30 animate-pulse" />)}
            </div>
          ) : (
            <div className="space-y-6">
              {/* KPI row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "Active Work Orders", value: activity.pipeline.activeJobs,          icon: Briefcase, color: "text-primary bg-primary/10"           },
                  { label: "Interviews Completed", value: activity.interviews.completed,        icon: Video,     color: "text-violet-400 bg-violet-500/10"     },
                  { label: "Applications",         value: activity.applications.total,          icon: FileText,  color: "text-blue-400 bg-blue-500/10"         },
                  { label: "Hires",                value: activity.applications.hires,          icon: UserCheck, color: "text-emerald-400 bg-emerald-500/10"   },
                ].map(({ label, value, icon: Icon, color }) => (
                  <Card key={label}>
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className={cn("p-2 rounded-xl shrink-0", color)}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground leading-tight">{label}</p>
                        <p className="text-2xl font-bold">{value}</p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Charts row */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Pipeline breakdown bar chart */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Briefcase className="w-4 h-4 text-primary" /> Hiring Pipeline
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[160px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={[
                            { name: "Active",  value: activity.pipeline.activeJobs,  fill: "hsl(var(--primary))" },
                            { name: "Draft",   value: activity.pipeline.draftJobs,   fill: "hsl(var(--muted-foreground))" },
                            { name: "Closed",  value: activity.pipeline.closedJobs,  fill: "rgba(255,255,255,0.15)" },
                          ]}
                          margin={{ top: 4, right: 4, left: -20, bottom: 4 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} allowDecimals={false} />
                          <Tooltip
                            cursor={{ fill: "rgba(255,255,255,0.03)" }}
                            contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                          />
                          <Bar dataKey="value" radius={[4,4,0,0]} maxBarSize={48}>
                            {["hsl(var(--primary))", "rgba(255,255,255,0.3)", "rgba(255,255,255,0.12)"].map((color, i) => (
                              <Cell key={i} fill={color} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                {/* Application funnel */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-primary" /> Application Funnel
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {[
                      { label: "Total Applications", value: activity.applications.total,    color: "bg-primary"       },
                      { label: "In Screening",        value: activity.applications.screening, color: "bg-blue-500"     },
                      { label: "Offers Extended",     value: activity.applications.offers,   color: "bg-violet-500"   },
                      { label: "Hires",               value: activity.applications.hires,    color: "bg-emerald-500"  },
                    ].map(({ label, value, color }) => {
                      const pct = activity.applications.total > 0
                        ? Math.round((value / activity.applications.total) * 100)
                        : 0;
                      return (
                        <div key={label}>
                          <div className="flex justify-between mb-1 text-xs">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="font-semibold">{value} <span className="text-muted-foreground font-normal">({pct}%)</span></span>
                          </div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                    <div className="pt-2 border-t border-border/40 flex justify-between text-xs">
                      <span className="text-muted-foreground">Conversion rate</span>
                      <span className="font-bold text-emerald-400">{activity.applications.conversionRate}%</span>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Interview stats + recent jobs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Interview stats */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Video className="w-4 h-4 text-violet-400" /> AI Interview Activity
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {[
                      { label: "Total Sessions",    value: activity.interviews.total,          color: "text-foreground"    },
                      { label: "Completed",         value: activity.interviews.completed,       color: "text-emerald-400"   },
                      { label: "In Progress",       value: activity.interviews.active,          color: "text-primary"       },
                      { label: "Completion Rate",   value: `${activity.interviews.completionRate}%`, color: "text-violet-400" },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <span className={cn("text-sm font-bold", color)}>{value}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                {/* Recent work orders */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Briefcase className="w-4 h-4 text-blue-400" /> Recent Work Orders
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {activity.recentJobs.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <Briefcase className="w-8 h-8 mx-auto mb-2 opacity-20" />
                        <p className="text-sm">No work orders yet</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {activity.recentJobs.map((job: any) => (
                          <div key={job.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/30">
                            <div className={cn("w-2 h-2 rounded-full shrink-0",
                              job.status === "active" ? "bg-emerald-500 shadow-[0_0_6px_1px] shadow-emerald-500/50"
                              : job.status === "draft" ? "bg-amber-500" : "bg-muted-foreground/30"
                            )} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium truncate">{job.title}</p>
                              <p className="text-[10px] text-muted-foreground">{job.workOrderNumber || "—"}</p>
                            </div>
                            <Badge variant="outline" className={cn("text-[10px] capitalize shrink-0",
                              job.status === "active" ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/8"
                              : job.status === "draft" ? "text-amber-400 border-amber-500/30 bg-amber-500/8"
                              : "text-muted-foreground"
                            )}>
                              {job.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </TabsContent>

        {!isSubClient(client) && (
        <TabsContent value="branches">
          <>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">{childTermPlural}</h3>
                <p className="text-sm text-muted-foreground">
                  {isAgency(client)
                    ? `Companies ${client.name} recruits for.`
                    : isEnterprise(client)
                    ? `Subsidiary entities under ${client.name}.`
                    : `Companies ${client.name} works with.`}
                </p>
              </div>
              {canHaveChildren && (
                <Button size="sm" className="gap-2 hover-elevate shadow-lg shadow-primary/20" onClick={() => setShowAddChild(true)}>
                  <Plus className="w-3.5 h-3.5" /> {addChildLabel}
                </Button>
              )}
            </div>
            {branches.length === 0 ? (
              <Card>
                <CardContent className="py-16 text-center text-muted-foreground">
                  <GitBranch className="w-12 h-12 mx-auto mb-4 opacity-20" />
                  <p className="font-medium">No {childTermPlural.toLowerCase()} yet</p>
                  <p className="text-sm mt-1">
                    {isAgency(client)
                      ? "Add the companies this agency recruits for."
                      : isEnterprise(client)
                      ? "Add subsidiaries to organize hiring across the enterprise."
                      : "Add the companies this entity works with."}
                  </p>
                  {canHaveChildren && (
                    <Button variant="outline" size="sm" className="mt-4 gap-2" onClick={() => setShowAddChild(true)}>
                      <Plus className="w-3.5 h-3.5" /> {addChildLabel}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {branches.map((b: any) => <BranchCard key={b.id} branch={b} />)}
              </div>
            )}
          </>
        </TabsContent>
        )}

        {!isSubClient(client) && (
        <TabsContent value="members">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold">Team Members</h3>
              <p className="text-sm text-muted-foreground">Recruiters, hiring managers, and admins with access to this client.</p>
            </div>
            {canManageClients && (
              <Button size="sm" className="gap-2 hover-elevate shadow-lg shadow-primary/20" onClick={() => { setInviteResult(null); setInviteForm({ email: "", name: "", role: "recruiter", tenantId: id }); setShowInviteModal(true); }}>
                <Plus className="w-3.5 h-3.5" /> Invite Member
              </Button>
            )}
          </div>

          {members.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center text-muted-foreground">
                <Users className="w-12 h-12 mx-auto mb-4 opacity-20" />
                <p className="font-medium">No team members yet</p>
                <Button variant="outline" size="sm" className="mt-4 gap-2"><Plus className="w-3.5 h-3.5" /> Invite First Member</Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {(["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager", "interviewer"] as const).map((role) => {
                const roleMembers = members.filter((m: any) => m.role === role);
                if (roleMembers.length === 0) return null;
                const cfg = roleConfig[role];
                const RoleIcon = cfg.icon;
                return (
                  <Card key={role} className="overflow-hidden">
                    <CardHeader className="py-3 px-4 border-b border-border/60 bg-muted/20">
                      <CardTitle className="text-xs font-semibold flex items-center gap-2">
                        <RoleIcon className="w-3.5 h-3.5 text-muted-foreground" />
                        {cfg.label}s
                        <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1">{roleMembers.length}</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-2">
                      {roleMembers.map((m: any) => <MemberRow key={m.id} member={m} tenantId={id} callerRole={user?.role} callerTenantId={user?.tenantId} />)}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
        )}

        <TabsContent value="database">
          <div className="space-y-4">
            {/* Access header */}
            <Card className={cn("border", client.candidateDatabaseAccess ? "border-emerald-500/25 bg-emerald-500/5" : "border-amber-500/25 bg-amber-500/5")}>
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-3">
                    <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0", client.candidateDatabaseAccess ? "bg-emerald-500/15" : "bg-amber-500/15")}>
                      <Database className={cn("w-4.5 h-4.5", client.candidateDatabaseAccess ? "text-emerald-400" : "text-amber-400")} />
                    </div>
                    <div>
                      <p className={cn("font-semibold text-sm", client.candidateDatabaseAccess ? "text-emerald-300" : "text-amber-300")}>
                        {client.candidateDatabaseAccess ? "Platform pool access is active" : "Platform pool access is not enabled"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {client.candidateDatabaseAccess
                          ? `${client.name}'s recruiters can search the platform candidate pool alongside their private pipeline. Candidates from this pool are marked with a "Platform" badge.`
                          : `${client.name} only sees candidates from their own hiring efforts. Grant access below to unlock the platform's shared talent pool.`}
                      </p>
                    </div>
                  </div>
                  {user?.role === "platform_admin" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleToggleDbAccess}
                      disabled={togglingDbAccess}
                      className={cn("gap-1.5 flex-shrink-0", client.candidateDatabaseAccess
                        ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
                        : "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10")}
                    >
                      {togglingDbAccess
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Database className="w-3.5 h-3.5" />}
                      {client.candidateDatabaseAccess ? "Revoke Access" : "Grant Access"}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Two separate pools explained */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Card className="border-white/8 bg-white/3">
                <CardContent className="pt-5 pb-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                    <p className="text-sm font-semibold">Platform Pool</p>
                    <Badge variant="outline" className="text-[10px] ml-auto">Shared</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">Candidates who self-registered on the Lexy platform — independent job seekers not attached to any specific employer. This pool is curated by Lexy and shared across all tenants with access.</p>
                  <p className="text-xs font-semibold text-primary">{platformDb?.access ? `${platformDb.total ?? 0} candidates` : "Access required"}</p>
                </CardContent>
              </Card>
              <Card className="border-white/8 bg-white/3">
                <CardContent className="pt-5 pb-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-cyan-400" />
                    <p className="text-sm font-semibold">{client.name} Private Pool</p>
                    <Badge variant="outline" className="text-[10px] ml-auto">Private</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">Candidates sourced by {client.name}'s own efforts — job applications via their career page embed, manual additions, CSV imports, and AI sourcing agents. Fully private to this tenant.</p>
                  <p className="text-xs font-semibold text-cyan-400">{client.candidateCount ?? 0} candidates</p>
                </CardContent>
              </Card>
            </div>

            {/* Platform pool browser — only if access is granted */}
            {client.candidateDatabaseAccess && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-4">
                    <CardTitle className="text-sm">Platform Candidate Pool</CardTitle>
                    <Input
                      placeholder="Search by name, email, title…"
                      value={dbSearch}
                      onChange={e => setDbSearch(e.target.value)}
                      className="h-8 text-sm max-w-64"
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  {!platformDb ? (
                    <div className="py-8 flex items-center justify-center">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : !platformDb.access ? (
                    <p className="text-sm text-muted-foreground text-center py-8">{platformDb.message}</p>
                  ) : platformDb.candidates?.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No candidates found{dbSearch ? " matching your search" : ""}.</p>
                  ) : (
                    <div className="space-y-2">
                      {platformDb.candidates?.map((c: any) => (
                        <div key={c.id} className="flex items-center gap-4 p-3 rounded-xl border border-white/6 bg-white/2 hover:border-primary/30 transition-colors">
                          <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center text-sm font-bold text-primary flex-shrink-0">
                            {c.firstName?.[0]}{c.lastName?.[0]}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold truncate">{c.firstName} {c.lastName}</p>
                            <p className="text-xs text-muted-foreground truncate">{c.currentTitle ?? c.email}</p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/25">Platform</Badge>
                            {c.skills?.slice(0, 2).map((s: string) => (
                              <Badge key={s} variant="outline" className="text-[10px] hidden sm:flex">{s}</Badge>
                            ))}
                          </div>
                        </div>
                      ))}
                      <p className="text-xs text-muted-foreground text-center pt-2">
                        Showing {platformDb.candidates?.length} of {platformDb.total} platform candidates
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {!client.candidateDatabaseAccess && user?.role !== "platform_admin" && (
              <Card className="border-dashed border-white/15">
                <CardContent className="py-12 text-center text-muted-foreground">
                  <Database className="w-12 h-12 mx-auto mb-4 opacity-20" />
                  <p className="font-semibold text-sm">Platform pool not unlocked</p>
                  <p className="text-xs mt-1 max-w-sm mx-auto">Contact your platform administrator to request access to the Lexy platform candidate pool.</p>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {canHaveChildren && (
        <AddChildDialog
          open={showAddChild}
          onClose={() => setShowAddChild(false)}
          parentId={id}
          parentName={client.name}
          childType={childTypeToCrate}
          label={addChildLabel}
        />
      )}

      {/* Invite Member Modal — only mountable for real tenants. Sub-clients
          have no team of their own, so we never want this dialog to surface
          even if showInviteModal somehow gets set. */}
      <Dialog open={showInviteModal && !isSubClient(client)} onOpenChange={(open) => { if (!open) { setShowInviteModal(false); setInviteResult(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invite Team Member</DialogTitle>
          </DialogHeader>
          {!inviteResult ? (
            <div className="space-y-4 py-2">
              <div>
                <Label className="mb-1.5 block">Full Name</Label>
                <Input
                  placeholder="Jane Smith"
                  value={inviteForm.name}
                  onChange={(e) => setInviteForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div>
                <Label className="mb-1.5 block">Email Address</Label>
                <Input
                  type="email"
                  placeholder="jane@company.com"
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm(f => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div>
                <Label className="mb-1.5 block">Role</Label>
                <Select value={inviteForm.role} onValueChange={(v) => setInviteForm(f => ({ ...f, role: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tenant_admin">Admin</SelectItem>
                    <SelectItem value="recruiter_admin">Recruiter Admin</SelectItem>
                    <SelectItem value="recruiter">Recruiter</SelectItem>
                    <SelectItem value="hiring_manager">Hiring Manager</SelectItem>
                    <SelectItem value="interviewer">Interviewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                An invite email will be sent to this address with a secure link to set their password and join your team.
              </p>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-emerald-300">
                    {inviteResult.emailSent
                      ? "Invite email sent!"
                      : inviteResult.emailSimulated
                        ? "Invite created (email simulated)"
                        : "Invite link generated"}
                  </p>
                  <p className="text-xs text-emerald-400/70">
                    {inviteResult.emailSent
                      ? `Delivered to ${inviteResult.email} • Valid for 7 days`
                      : "Valid for 7 days"}
                  </p>
                </div>
              </div>
              {!inviteResult.emailSent && (
                <p className="text-xs text-amber-400/80 bg-amber-500/8 border border-amber-500/20 rounded-lg p-2.5">
                  {inviteResult.emailSimulated
                    ? "Email delivery is not configured on this environment, so no real email was sent. Share the link below manually."
                    : "We couldn't send the invite email. Share the link below manually."}
                </p>
              )}
              <div>
                <Label className="mb-1.5 block">Invite Link {inviteResult.emailSent ? "(backup)" : ""}</Label>
                <div className="flex gap-2">
                  <Input value={inviteLink} readOnly className="text-xs font-mono" />
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label="Copy invite link"
                    onClick={() => { navigator.clipboard.writeText(inviteLink); toast({ title: "Link copied!" }); }}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {inviteResult.emailSent
                  ? <>The invite email was sent to <span className="text-foreground font-medium">{inviteResult.email}</span>. They'll create their password when they open the link.</>
                  : <>Send this link to <span className="text-foreground font-medium">{inviteResult.email}</span>. They'll create their password when they open it.</>}
              </p>
            </div>
          )}
          <DialogFooter>
            {!inviteResult ? (
              <>
                <Button variant="outline" onClick={() => setShowInviteModal(false)}>Cancel</Button>
                <Button onClick={handleInvite} disabled={inviting}>
                  {inviting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Generate Invite
                </Button>
              </>
            ) : (
              <Button onClick={() => { setShowInviteModal(false); setInviteResult(null); }}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
