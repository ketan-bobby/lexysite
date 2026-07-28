/**
 * pages/recruiter/team.tsx — My Team (tenant-scoped)
 *
 * Shows the logged-in user's OWN tenant's team members and lets a
 * tenant_admin invite new staff. This is the tenant-level team view —
 * distinct from /clients/:id which is for managing sub-clients.
 *
 *   Data:    GET  /api/tenants/<myTenantId>/members
 *   Invite:  POST /api/staff-invites   (tenantId = myTenantId)
 *
 * Recruiter Admin extensions (Task #43):
 *   • tenant_admin / platform_admin can assign client sub-tenants to a
 *     recruiter_admin (GET/PUT /api/recruiter-admins).
 *   • recruiter_admin sees their own assigned clients (GET
 *     /api/recruiter-admins/my/clients) and may invite recruiters /
 *     hiring managers into their agency tenant.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Users, Shield, User, UserCog, Plus, Loader2, Copy, CheckCircle2,
  Building2, Settings2, Network, List, Edit, Mail,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { OrgChart } from "@/components/team/OrgChart";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Per-role display config (label, icon, badge colours) used to render member rows.
const roleConfig: Record<string, { label: string; icon: any; color: string }> = {
  platform_admin:  { label: "Platform Admin",  icon: Shield,  color: "text-red-400 bg-red-500/10 border-red-500/25" },
  tenant_admin:    { label: "Admin",           icon: Shield,  color: "text-violet-400 bg-violet-500/10 border-violet-500/25" },
  recruiter_admin: { label: "Recruiter Admin", icon: UserCog, color: "text-amber-400 bg-amber-500/10 border-amber-500/25" },
  recruiter:       { label: "Recruiter",       icon: User,    color: "text-blue-400 bg-blue-500/10 border-blue-500/25" },
  hiring_manager:  { label: "Hiring Manager",  icon: UserCog, color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25" },
  interviewer:     { label: "Interviewer",     icon: UserCog, color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/25" },
};

// Which roles each caller role may ASSIGN when editing a member. Mirrors
// ALLOWED_ROLES_BY_CALLER on the backend (PATCH /api/users/:userId).
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
    return ["recruiter", "hiring_manager"].includes(member.role)
      && member.tenantId === callerTenantId;
  }
  return false;
}

// Edit dialog: change a member's name, role, and account status. PATCHes only
// the fields that actually changed to /api/users/:userId.
function EditMemberDialog({
  open, onClose, member, tenantId, callerRole,
}: { open: boolean; onClose: () => void; member: any; tenantId: string | undefined; callerRole: string }) {
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
      queryClient.invalidateQueries({ queryKey: ["my-team", tenantId] });
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

// Single row in the team list: avatar (initials), name/email, role + pending badges.
function MemberRow({ member, tenantId, callerRole, callerTenantId }: { member: any; tenantId?: string; callerRole?: string; callerTenantId?: string }) {
  const role = roleConfig[member.role] || roleConfig.recruiter;
  const RoleIcon = role.icon;
  // Derive initials from name (or email) — first letter of up to two words.
  const initials = (member.name || member.email || "?")
    .split(" ").slice(0, 2).map((w: string) => w[0]).join("").toUpperCase();
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
      <Badge variant="outline" className={cn("text-[10px] gap-1", role.color)}>
        <RoleIcon className="w-2.5 h-2.5" />{role.label}
      </Badge>
      {member.status === "pending" && (
        <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-400 bg-amber-500/10">
          Pending
        </Badge>
      )}
      {member.status === "suspended" && (
        <Badge variant="outline" className="text-[10px] gap-1 border-red-500/40 text-red-400 bg-red-500/10">
          Suspended
        </Badge>
      )}
      {canEdit && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => setEditing(true)}
        >
          <Edit className="w-3.5 h-3.5" /> Edit
        </Button>
      )}
      {canEdit && (
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

export default function MyTeam() {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const tenantId: string | undefined = user?.tenantId;

  const isTenantAdmin = user?.role === "tenant_admin" || user?.role === "platform_admin";
  const isRecruiterAdmin = user?.role === "recruiter_admin";
  // Tenant admins and recruiter admins may both invite (with different role sets).
  const canInvite = isTenantAdmin || isRecruiterAdmin;

  // Role options offered in the invite dialog depend on the caller's role:
  // recruiter admins manage line staff only; admins may invite the full set.
  const inviteRoleOptions = isRecruiterAdmin
    ? [
        { value: "recruiter", label: "Recruiter" },
        { value: "hiring_manager", label: "Hiring Manager" },
      ]
    : [
        { value: "tenant_admin", label: "Admin" },
        { value: "recruiter_admin", label: "Recruiter Admin" },
        { value: "recruiter", label: "Recruiter" },
        { value: "hiring_manager", label: "Hiring Manager" },
        { value: "interviewer", label: "Interviewer" },
      ];

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["my-team", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${tenantId}/members`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return [];
      const data = await res.json();
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.members)) return data.members;
      return [];
    },
  });

  // Tenant-admin view: recruiter admins + their assigned clients + available clients.
  const { data: raData } = useQuery({
    queryKey: ["recruiter-admins"],
    enabled: isTenantAdmin,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/recruiter-admins`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { recruiterAdmins: [], availableClients: [] };
      return res.json();
    },
  });
  const recruiterAdmins: any[] = raData?.recruiterAdmins ?? [];
  const availableClients: any[] = raData?.availableClients ?? [];

  // Tenant-admin view: recruiters + the recruiter admins they report to.
  const { data: reportingData } = useQuery({
    queryKey: ["recruiter-reporting"],
    enabled: isTenantAdmin,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/recruiter-reporting`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { recruiters: [], availableRecruiterAdmins: [] };
      return res.json();
    },
  });
  const reportingRecruiters: any[] = reportingData?.recruiters ?? [];
  const availableRecruiterAdmins: any[] = reportingData?.availableRecruiterAdmins ?? [];

  // Recruiter-admin self view: their own assigned clients.
  const { data: myClientsData } = useQuery({
    queryKey: ["my-clients"],
    enabled: isRecruiterAdmin,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/recruiter-admins/my/clients`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { clients: [] };
      return res.json();
    },
  });
  const myClients: any[] = myClientsData?.clients ?? [];

  // ── Manage-clients dialog state (tenant admin) ──────────────────────────────
  const [manageFor, setManageFor] = useState<any>(null); // the recruiter_admin being edited
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);

  const saveClients = useMutation({
    mutationFn: async ({ userId, clientTenantIds }: { userId: string; clientTenantIds: string[] }) => {
      const res = await fetch(`${BASE}/api/recruiter-admins/${userId}/clients`, {
        credentials: "include",
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ clientTenantIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save clients");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Clients updated" });
      queryClient.invalidateQueries({ queryKey: ["recruiter-admins"] });
      setManageFor(null);
    },
    onError: (e: any) => toast({ title: e.message || "Failed to save clients", variant: "destructive" }),
  });

  function openManage(ra: any) {
    setManageFor(ra);
    setSelectedClientIds((ra.clients ?? []).map((c: any) => c.clientTenantId));
  }
  function toggleClient(id: string) {
    setSelectedClientIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  // ── Manage-managers dialog state (tenant admin) ─────────────────────────────
  const [manageManagersFor, setManageManagersFor] = useState<any>(null); // the recruiter being edited
  const [selectedManagerIds, setSelectedManagerIds] = useState<string[]>([]);

  // Per-work-order manager selections, keyed by jobId. The default ("all work
  // orders") selection lives in selectedManagerIds above.
  const [perWoSelected, setPerWoSelected] = useState<Record<string, string[]>>({});

  // Snapshots of what was loaded, so the single footer Save only writes the
  // scopes (default + each work order) the user actually changed.
  const [initialManagerIds, setInitialManagerIds] = useState<string[]>([]);
  const [initialPerWo, setInitialPerWo] = useState<Record<string, string[]>>({});

  const saveManagers = useMutation({
    mutationFn: async ({ userId, recruiterAdminUserIds, jobId }: { userId: string; recruiterAdminUserIds: string[]; jobId?: string | null }) => {
      const res = await fetch(`${BASE}/api/recruiters/${userId}/managers`, {
        credentials: "include",
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ recruiterAdminUserIds, jobId: jobId ?? null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save reporting");
      }
      return res.json();
    },
    onError: (e: any) => toast({ title: e.message || "Failed to save reporting", variant: "destructive" }),
  });

  // True when two id lists hold the same set (order-independent).
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

  // Single Save for the whole dialog: writes the default scope and any work
  // order whose selection changed, then refreshes + closes.
  async function saveAllManagers() {
    if (!manageManagersFor) return;
    const userId = manageManagersFor.id;
    try {
      if (!sameSet(selectedManagerIds, initialManagerIds)) {
        await saveManagers.mutateAsync({ userId, recruiterAdminUserIds: selectedManagerIds, jobId: null });
      }
      for (const w of (manageManagersFor.workOrders ?? [])) {
        const cur = perWoSelected[w.jobId] ?? [];
        const init = initialPerWo[w.jobId] ?? [];
        if (!sameSet(cur, init)) {
          await saveManagers.mutateAsync({ userId, recruiterAdminUserIds: cur, jobId: w.jobId });
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["recruiter-reporting"] });
      toast({ title: "Reporting saved" });
      setManageManagersFor(null);
    } catch {
      // saveManagers.onError already surfaced the failure; keep dialog open.
    }
  }

  function openManageManagers(r: any) {
    setManageManagersFor(r);
    const def = (r.managers ?? []).map((m: any) => m.recruiterAdminUserId);
    setSelectedManagerIds(def);
    setInitialManagerIds(def);
    const wo: Record<string, string[]> = {};
    for (const w of (r.workOrders ?? [])) {
      wo[w.jobId] = (w.managers ?? []).map((m: any) => m.recruiterAdminUserId);
    }
    setPerWoSelected(wo);
    setInitialPerWo(wo);
  }
  function toggleManager(id: string) {
    setSelectedManagerIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function toggleWoManager(jobId: string, id: string) {
    setPerWoSelected(prev => {
      const cur = prev[jobId] ?? [];
      return { ...prev, [jobId]: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] };
    });
  }

  // Body view: org chart (who is assigned to whom) vs flat grouped list.
  const [view, setView] = useState<"chart" | "list">("chart");
  // Optional role filter applied to the list view (set by clicking a stat card).
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  // Switch to the list view, optionally narrowed to a single role.
  function showList(role: string | null) {
    setRoleFilter(role);
    setView("list");
  }

  const [showInvite, setShowInvite] = useState(false);
  const [inviting, setInviting]     = useState(false);
  const [inviteResult, setInviteResult] = useState<any>(null);
  const [form, setForm] = useState({ email: "", name: "", role: "recruiter" });

  // Create a staff invite for this tenant. The backend emails the link when
  // delivery is configured; otherwise it returns a link to share manually.
  async function handleInvite() {
    if (!form.email || !form.name) {
      toast({ title: "Email and name are required", variant: "destructive" });
      return;
    }
    setInviting(true);
    try {
      const res = await fetch(`${BASE}/api/staff-invites`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ ...form, tenantId }),
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
      queryClient.invalidateQueries({ queryKey: ["recruiter-admins"] });
    } catch {
      toast({ title: "Failed to generate invite", variant: "destructive" });
    } finally {
      setInviting(false);
    }
  }

  // Prefer the server-provided acceptUrl; fall back to building it from the token.
  const inviteLink = inviteResult
    ? (inviteResult.acceptUrl
        || `${window.location.origin}${BASE}/accept-team-invite?token=${inviteResult.token}`)
    : "";

  const safeMembers = Array.isArray(members) ? members : [];
  const roleOrder = ["tenant_admin", "recruiter_admin", "recruiter", "hiring_manager", "interviewer", "platform_admin"] as const;

  // Recruiter Admins (with assigned clients) feeding the org chart. Tenant admins
  // get the full list from /recruiter-admins; a recruiter_admin sees themselves
  // and their own assigned clients.
  // Map each recruiter admin -> the recruiters reporting to them, so the org
  // chart can nest recruiters under their actual manager(s). A recruiter with
  // multiple managers appears under each; recruiters with none stay grouped.
  const recruitersByAdminId = new Map<string, Array<{ id?: string; name?: string; email?: string }>>();
  for (const r of reportingRecruiters) {
    for (const m of (r.managers ?? [])) {
      const list = recruitersByAdminId.get(m.recruiterAdminUserId) ?? [];
      list.push({ id: r.id, name: r.name, email: r.email });
      recruitersByAdminId.set(m.recruiterAdminUserId, list);
    }
  }
  const chartRecruiterAdmins = isRecruiterAdmin
    ? [{
        id: user?.id,
        name: user?.name,
        email: user?.email,
        clients: myClients.map((c: any) => ({ clientTenantId: c.id, clientName: c.name })),
      }]
    : recruiterAdmins.map((ra: any) => ({
        ...ra,
        recruiters: recruitersByAdminId.get(ra.id) ?? [],
      }));

  return (
    <AppLayout>
      <div className={view === "chart" ? "max-w-6xl" : "max-w-5xl"}>
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="page-title">My Team</h1>
            <p className="text-sm text-muted-foreground mt-1">
              People on your team with access to {user?.tenantName || "your workspace"}.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* View toggle: org chart (assignment tree) vs flat list. */}
            <div className="flex items-center rounded-lg border border-border/60 p-0.5 bg-muted/30">
              <Button
                variant={view === "chart" ? "secondary" : "ghost"}
                size="sm"
                className="gap-1.5 h-8"
                onClick={() => setView("chart")}
              >
                <Network className="w-3.5 h-3.5" /> Org Chart
              </Button>
              <Button
                variant={view === "list" ? "secondary" : "ghost"}
                size="sm"
                className="gap-1.5 h-8"
                onClick={() => setView("list")}
              >
                <List className="w-3.5 h-3.5" /> List
              </Button>
            </div>
            {canInvite && (
              <Button
                className="gap-2 shadow-lg shadow-primary/20"
                onClick={() => { setInviteResult(null); setForm({ email: "", name: "", role: inviteRoleOptions[0].value }); setShowInvite(true); }}
              >
                <Plus className="w-4 h-4" /> Invite Team Member
              </Button>
            )}
          </div>
        </div>

        {/* Recruiter-admin: my assigned clients */}
        {isRecruiterAdmin && (
          <Card className="mb-6 border-amber-500/20">
            <CardHeader className="py-3 px-4 border-b border-border/60 bg-amber-500/[0.04]">
              <CardTitle className="text-xs font-semibold flex items-center gap-2">
                <Building2 className="w-3.5 h-3.5 text-amber-400" />
                My Clients
                <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1">{myClients.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              {myClients.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No clients assigned yet. Ask your administrator to assign clients to you.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {myClients.map((c: any) => (
                    <Badge key={c.id} variant="outline" className="gap-1.5 text-amber-300 border-amber-500/30 bg-amber-500/10">
                      <Building2 className="w-3 h-3" /> {c.name}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tenant-admin: recruiter admins & client assignments */}
        {isTenantAdmin && recruiterAdmins.length > 0 && (
          <Card className="mb-6 border-amber-500/20">
            <CardHeader className="py-3 px-4 border-b border-border/60 bg-amber-500/[0.04]">
              <CardTitle className="text-xs font-semibold flex items-center gap-2">
                <UserCog className="w-3.5 h-3.5 text-amber-400" />
                Recruiter Admins & Client Assignments
                <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1">{recruiterAdmins.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              {recruiterAdmins.map((ra: any) => (
                <div key={ra.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-muted/40 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{ra.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{ra.email}</p>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {(ra.clients ?? []).length === 0 ? (
                        <span className="text-[11px] text-muted-foreground italic">No clients assigned</span>
                      ) : (
                        (ra.clients ?? []).map((c: any) => (
                          <Badge key={c.clientTenantId} variant="outline" className="text-[10px] gap-1 text-amber-300 border-amber-500/30 bg-amber-500/10">
                            <Building2 className="w-2.5 h-2.5" /> {c.clientName ?? c.clientTenantId}
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => openManage(ra)}>
                    <Settings2 className="w-3.5 h-3.5" /> Manage Clients
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Tenant-admin: recruiters & reporting (who reports to which admins) */}
        {isTenantAdmin && reportingRecruiters.length > 0 && (
          <Card className="mb-6 border-blue-500/20">
            <CardHeader className="py-3 px-4 border-b border-border/60 bg-blue-500/[0.04]">
              <CardTitle className="text-xs font-semibold flex items-center gap-2">
                <User className="w-3.5 h-3.5 text-blue-400" />
                Recruiters & Reporting
                <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1">{reportingRecruiters.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              {reportingRecruiters.map((r: any) => (
                <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-muted/40 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{r.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{r.email}</p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      <span className="text-[11px] text-muted-foreground">Reports to:</span>
                      {(r.managers ?? []).length === 0 ? (
                        <span className="text-[11px] text-muted-foreground italic">No one assigned</span>
                      ) : (
                        (r.managers ?? []).map((m: any) => (
                          <Badge key={m.recruiterAdminUserId} variant="outline" className="text-[10px] gap-1 text-amber-300 border-amber-500/30 bg-amber-500/10">
                            <UserCog className="w-2.5 h-2.5" /> {m.name ?? m.email ?? m.recruiterAdminUserId}
                          </Badge>
                        ))
                      )}
                      {(() => {
                        const overrides = (r.workOrders ?? []).filter((w: any) => (w.managers ?? []).length > 0).length;
                        return overrides > 0 ? (
                          <Badge variant="outline" className="text-[10px] gap-1 text-blue-300 border-blue-500/30 bg-blue-500/10">
                            +{pluralize(overrides, "work-order override")}
                          </Badge>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => openManageManagers(r)}>
                    <Settings2 className="w-3.5 h-3.5" /> Manage Managers
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Stat strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Card
            role="button"
            tabIndex={0}
            onClick={() => showList(null)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showList(null); } }}
            className="cursor-pointer transition-colors hover:bg-muted/40 hover:border-primary/40"
          >
            <CardContent className="py-4">
              <p className="text-2xl font-bold">{safeMembers.length}</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
                <Users className="w-3 h-3" /> Total members
              </p>
            </CardContent>
          </Card>
          {(["recruiter_admin", "recruiter", "hiring_manager"] as const).map((r) => {
            const cfg = roleConfig[r];
            const count = safeMembers.filter((m: any) => m.role === r).length;
            const Icon = cfg.icon;
            return (
              <Card
                key={r}
                role="button"
                tabIndex={0}
                onClick={() => showList(r)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showList(r); } }}
                className="cursor-pointer transition-colors hover:bg-muted/40 hover:border-primary/40"
              >
                <CardContent className="py-4">
                  <p className="text-2xl font-bold">{count}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
                    <Icon className="w-3 h-3" /> {cfg.label}s
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Body */}
        {isLoading ? (
          <Card>
            <CardContent className="py-16 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </CardContent>
          </Card>
        ) : safeMembers.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p className="font-medium">No team members yet</p>
              {canInvite && (
                <Button variant="outline" size="sm" className="mt-4 gap-2" onClick={() => setShowInvite(true)}>
                  <Plus className="w-3.5 h-3.5" /> Invite First Member
                </Button>
              )}
            </CardContent>
          </Card>
        ) : view === "chart" ? (
          <Card className="overflow-hidden">
            <CardHeader className="py-3 px-4 border-b border-border/60 bg-muted/20">
              <CardTitle className="text-xs font-semibold flex items-center gap-2">
                <Network className="w-3.5 h-3.5 text-muted-foreground" />
                Org Chart — Assignments
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <OrgChart
                members={safeMembers}
                recruiterAdmins={chartRecruiterAdmins}
                tenantName={user?.tenantName}
                onSelect={({ type, id }) => {
                  if (type === "recruiter") {
                    const r = reportingRecruiters.find((x: any) => x.id === id);
                    if (r) openManageManagers(r);
                  } else if (type === "recruiter_admin") {
                    const ra = chartRecruiterAdmins.find((x: any) => x.id === id);
                    if (ra) openManage(ra);
                  }
                }}
              />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {roleFilter && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Showing</span>
                <Badge variant="outline" className={cn("gap-1", roleConfig[roleFilter]?.color)}>
                  {roleConfig[roleFilter]?.label || roleFilter}s
                </Badge>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setRoleFilter(null)}>
                  Show all
                </Button>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {roleOrder.filter((role) => !roleFilter || role === roleFilter).map((role) => {
              const list = safeMembers.filter((m: any) => m.role === role);
              if (list.length === 0) return null;
              const cfg = roleConfig[role];
              const RoleIcon = cfg.icon;
              return (
                <Card key={role} className="overflow-hidden">
                  <CardHeader className="py-3 px-4 border-b border-border/60 bg-muted/20">
                    <CardTitle className="text-xs font-semibold flex items-center gap-2">
                      <RoleIcon className="w-3.5 h-3.5 text-muted-foreground" />
                      {cfg.label}s
                      <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1">{list.length}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-2">
                    {list.map((m: any) => <MemberRow key={m.id} member={m} tenantId={tenantId} callerRole={user?.role} callerTenantId={user?.tenantId} />)}
                  </CardContent>
                </Card>
              );
            })}
            </div>
          </div>
        )}
      </div>

      {/* Manage-clients Modal (tenant admin) */}
      <Dialog open={!!manageFor} onOpenChange={(open) => { if (!open) setManageFor(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign Clients{manageFor ? ` — ${manageFor.name}` : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              Select the client sub-tenants this recruiter admin manages. They will
              see only the work orders and candidates belonging to these clients.
            </p>
            {availableClients.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No client sub-tenants exist yet. Create clients first under Clients.
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto space-y-1.5">
                {availableClients.map((c: any) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg border border-border/60 hover:bg-muted/40 cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedClientIds.includes(c.id)}
                      onCheckedChange={() => toggleClient(c.id)}
                    />
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm flex-1">{c.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManageFor(null)}>Cancel</Button>
            <Button
              disabled={saveClients.isPending}
              onClick={() => manageFor && saveClients.mutate({ userId: manageFor.id, clientTenantIds: selectedClientIds })}
            >
              {saveClients.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage-managers Modal (tenant admin) */}
      <Dialog open={!!manageManagersFor} onOpenChange={(open) => { if (!open) setManageManagersFor(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Reporting Structure{manageManagersFor ? ` for ${manageManagersFor.name}` : ""}</DialogTitle>
          </DialogHeader>

          {availableRecruiterAdmins.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No recruiter admins exist yet. Invite a recruiter admin first.
            </p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto space-y-5 py-1 pr-1">
              {/* Default reporting (applies to every work order not customised) */}
              <div className="space-y-2">
                <p className="text-sm font-semibold">Default — all work orders</p>
                <p className="text-[11px] text-muted-foreground">
                  Used for any work order below that has no specific managers set.
                </p>
                <div className="space-y-1.5">
                  {availableRecruiterAdmins.map((a: any) => (
                    <label
                      key={a.id}
                      className="flex items-center gap-3 p-2 rounded-lg border border-border/60 hover:bg-muted/40 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedManagerIds.includes(a.id)}
                        onCheckedChange={() => toggleManager(a.id)}
                      />
                      <UserCog className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm flex-1">
                        {a.name || a.email}
                        {a.name && a.email && (
                          <span className="text-xs text-muted-foreground ml-1.5">{a.email}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Per-work-order overrides */}
              {(manageManagersFor?.workOrders ?? []).length > 0 && (
                <div className="space-y-3 border-t border-border/60 pt-4">
                  <p className="text-sm font-semibold">Per work order</p>
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Override reporting for a specific work order. Leave all unticked to use the default above.
                  </p>
                  {(manageManagersFor?.workOrders ?? []).map((w: any) => {
                    // Admins assigned to this work order's client are the preferred
                    // choices; fall back to all admins if the client has none.
                    const choices = (w.availableAdmins ?? []).length > 0 ? w.availableAdmins : availableRecruiterAdmins.map((a: any) => ({ recruiterAdminUserId: a.id, name: a.name, email: a.email }));
                    const sel = perWoSelected[w.jobId] ?? [];
                    return (
                      <div key={w.jobId} className="rounded-lg border border-border/60 p-3 space-y-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{w.title}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {w.workOrderNumber ? `${w.workOrderNumber} · ` : ""}{w.clientName ?? "Client"}
                          </p>
                        </div>
                        <div className="space-y-1">
                          {choices.map((a: any) => (
                            <label
                              key={a.recruiterAdminUserId}
                              className="flex items-center gap-2.5 p-1.5 rounded-md hover:bg-muted/40 cursor-pointer"
                            >
                              <Checkbox
                                checked={sel.includes(a.recruiterAdminUserId)}
                                onCheckedChange={() => toggleWoManager(w.jobId, a.recruiterAdminUserId)}
                              />
                              <UserCog className="w-3 h-3 text-muted-foreground shrink-0" />
                              <span className="text-xs flex-1">{a.name || a.email}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setManageManagersFor(null)} disabled={saveManagers.isPending}>Cancel</Button>
            {availableRecruiterAdmins.length > 0 && (
              <Button onClick={saveAllManagers} disabled={saveManagers.isPending}>
                {saveManagers.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                Save
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite Modal */}
      <Dialog open={showInvite} onOpenChange={(open) => { if (!open) { setShowInvite(false); setInviteResult(null); } }}>
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
                  value={form.name}
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div>
                <Label className="mb-1.5 block">Email Address</Label>
                <Input
                  type="email"
                  placeholder="jane@company.com"
                  value={form.email}
                  onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div>
                <Label className="mb-1.5 block">Role</Label>
                <Select value={form.role} onValueChange={(v) => setForm(f => ({ ...f, role: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {inviteRoleOptions.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
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
            </div>
          )}
          <DialogFooter>
            {!inviteResult ? (
              <>
                <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
                <Button onClick={handleInvite} disabled={inviting}>
                  {inviting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Send Invite
                </Button>
              </>
            ) : (
              <Button onClick={() => { setShowInvite(false); setInviteResult(null); }}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
