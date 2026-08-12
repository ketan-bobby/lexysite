/**
 * pages/recruiter/admin.tsx — Platform Admin Panel
 *
 * platform_admin-only page for managing tenants and users across the entire
 * platform. Tenant + user CRUD wired to /api/tenants and /api/users.
 */
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useListTenants,
  useListUsers,
  getListUsersQueryKey,
  useCreateTenant,
  useUpdateTenant,
  useCreateUser,
  customFetch,
} from "@workspace/api-client-react";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { Redirect } from "wouter";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Settings, Building2, Users, Plus, Shield, CheckCircle, XCircle, Sparkles } from "lucide-react";
import { BrandProfilePanel } from "@/components/ai-intel/BrandProfilePanel";
import { format, parseISO } from "date-fns";

const planColors: Record<string, string> = {
  starter: "bg-slate-100 text-slate-700 border-slate-200",
  growth: "bg-blue-100 text-blue-700 border-blue-200",
  enterprise: "bg-purple-100 text-purple-700 border-purple-200",
};

const roleColors: Record<string, string> = {
  platform_admin: "bg-red-100 text-red-700 border-red-200",
  tenant_admin: "bg-orange-100 text-orange-700 border-orange-200",
  recruiter: "bg-blue-100 text-blue-700 border-blue-200",
  candidate: "bg-green-100 text-green-700 border-green-200",
};

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/* Mirrors the server's password policy (api-server lib/password-policy.ts):
   12+ chars with upper/lower/number/symbol. Same helper as trial-setup.tsx. */
function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters.";
  if (pw.length > 128) return "Password must be no more than 128 characters.";
  if (!/[A-Z]/.test(pw)) return "Password must include an uppercase letter.";
  if (!/[a-z]/.test(pw)) return "Password must include a lowercase letter.";
  if (!/[0-9]/.test(pw)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password must include a symbol (e.g. ! @ # $ %).";
  return null;
}

/* Server policy failures come back as { error: CODE, message: human }. The
   generated client's ApiError exposes the parsed body as `data` — prefer its
   human `message` so an ALL_CAPS code (or "HTTP 400 …"-prefixed string) is
   never shown to the admin. */
function createUserErrorMessage(e: any): string {
  const data = e?.data;
  if (typeof data?.message === "string" && data.message) return data.message;
  const err = data?.error;
  if (typeof err === "string" && err && !/^[A-Z0-9_]+$/.test(err)) return err;
  return e?.message ?? "Unknown error";
}

export default function Admin() {
  const { user } = useAuth() as any;
  const isPlatformAdmin = user?.role === "platform_admin";

  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: tenantsData, isLoading: tenantsLoading, error: tenantsError } = useListTenants();
  // Users management is platform-admin only — skip the fetch entirely for tenant_admin.
  const { data: usersData,   isLoading: usersLoading,   error: usersError   } = useListUsers(undefined, { query: { queryKey: getListUsersQueryKey(), enabled: isPlatformAdmin } });

  const tenants: any[] = Array.isArray(tenantsData) ? tenantsData : ((tenantsData as any)?.tenants ?? []);
  const users:   any[] = Array.isArray(usersData)   ? usersData   : ((usersData   as any)?.users   ?? []);

  // ── Dialog state ─────────────────────────────────────────────────────────
  const [addTenantOpen, setAddTenantOpen] = useState(false);
  const [brandTenantId, setBrandTenantId] = useState("");
  // tenant_admin defaults to their own tenant; platform_admin to the first tenant in the list.
  const defaultBrandTenantId = isPlatformAdmin ? undefined : user?.tenantId;
  const [editTenant, setEditTenant] = useState<any | null>(null);
  const [addUserOpen, setAddUserOpen] = useState(false);

  // ── Add Tenant form ──────────────────────────────────────────────────────
  const [newTenant, setNewTenant] = useState({ name: "", slug: "", plan: "growth" as "starter" | "growth" | "enterprise" });
  const createTenant = useCreateTenant({
    mutation: {
      onSuccess: () => {
        toast({ title: "Tenant created" });
        qc.invalidateQueries({ queryKey: ["/api/tenants"] });
        setAddTenantOpen(false);
        setNewTenant({ name: "", slug: "", plan: "growth" });
      },
      onError: (e: any) => toast({ title: "Failed to create tenant", description: e?.message ?? "Unknown error", variant: "destructive" }),
    },
  });

  // ── Edit Tenant ──────────────────────────────────────────────────────────
  // Name goes through PUT /tenants/:id; plan + status go through the
  // platform-admin-only PATCH /tenants/:id/billing endpoint (the regular PUT
  // intentionally ignores those fields for audit-trail reasons).
  const updateTenant = useUpdateTenant();
  const updateTenantBilling = useMutation({
    mutationFn: async (args: { tenantId: string; plan?: string; status?: string }) => {
      const body: Record<string, string> = {};
      if (args.plan)   body.plan   = args.plan;
      if (args.status) body.status = args.status;
      return customFetch(`/api/tenants/${args.tenantId}/billing`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
  });

  // ── Suspend / Activate user ──────────────────────────────────────────────
  const updateUserStatus = useMutation({
    mutationFn: async (args: { userId: string; status: "active" | "suspended" }) => {
      return customFetch(`/api/users/${args.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: args.status }),
      });
    },
    onSuccess: (_d, vars) => {
      toast({ title: vars.status === "suspended" ? "User suspended" : "User reactivated" });
      qc.invalidateQueries({ queryKey: ["/api/users"] });
    },
    onError: (e: any) => toast({ title: "Failed to update user", description: e?.message ?? "Unknown error", variant: "destructive" }),
  });

  // ── Add User form ────────────────────────────────────────────────────────
  const [newUser, setNewUser] = useState({ email: "", name: "", role: "recruiter", password: "", tenantId: "" });
  const createUser = useCreateUser({
    mutation: {
      onSuccess: () => {
        toast({ title: "User created" });
        qc.invalidateQueries({ queryKey: ["/api/users"] });
        setAddUserOpen(false);
        setNewUser({ email: "", name: "", role: "recruiter", password: "", tenantId: "" });
      },
      onError: (e: any) => toast({ title: "Failed to create user", description: createUserErrorMessage(e), variant: "destructive" }),
    },
  });

  // ── Access guard ─────────────────────────────────────────────────────────
  // platform_admin manages every tenant/user; tenant_admin only gets the AI
  // Brand Profile for their own tenant (subtree). Anyone else is bounced. This
  // MUST run after all hooks above so hook order stays stable across renders.
  if (user && user.role !== "platform_admin" && user.role !== "tenant_admin") {
    return <Redirect to="/recruiter/dashboard" />;
  }

  function handleAddTenantSubmit() {
    const name = newTenant.name.trim();
    if (!name) { toast({ title: "Name is required", variant: "destructive" }); return; }
    const slug = (newTenant.slug.trim() || slugify(name));
    createTenant.mutate({ data: { name, slug, plan: newTenant.plan } });
  }

  async function handleEditTenantSubmit() {
    if (!editTenant) return;
    const id = editTenant.id;
    try {
      const tasks: Promise<unknown>[] = [];
      if (editTenant.name?.trim()) {
        tasks.push(updateTenant.mutateAsync({ tenantId: id, data: { name: editTenant.name.trim() } }));
      }
      if (editTenant.plan || editTenant.status) {
        tasks.push(updateTenantBilling.mutateAsync({ tenantId: id, plan: editTenant.plan, status: editTenant.status }));
      }
      await Promise.all(tasks);
      toast({ title: "Tenant updated" });
      qc.invalidateQueries({ queryKey: ["/api/tenants"] });
      setEditTenant(null);
    } catch (e: any) {
      toast({ title: "Failed to update tenant", description: e?.message ?? "Unknown error", variant: "destructive" });
    }
  }

  function handleAddUserSubmit() {
    const email = newUser.email.trim();
    const name = newUser.name.trim();
    if (!email || !name || !newUser.password) {
      toast({ title: "Email, name, and password are required", variant: "destructive" });
      return;
    }
    const pwProblem = passwordProblem(newUser.password);
    if (pwProblem) {
      toast({ title: pwProblem, variant: "destructive" });
      return;
    }
    createUser.mutate({
      data: {
        email,
        name,
        role: newUser.role,
        password: newUser.password,
        ...(newUser.tenantId ? { tenantId: newUser.tenantId } : {}),
      } as any,
    });
  }

  return (
    <AppLayout>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <Shield className="w-7 h-7 text-primary" /> {isPlatformAdmin ? "Platform Admin" : "Tenant Admin"}
          </h1>
          <p className="text-muted-foreground mt-1">
            {isPlatformAdmin
              ? "Manage tenants, users, and platform settings."
              : "Configure your organization's AI brand profile."}
          </p>
        </div>
      </div>

      {isPlatformAdmin && (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Card className="hover-elevate">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-primary/10 text-primary rounded-xl"><Building2 className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">Total Tenants</p><p className="text-2xl font-bold">{tenants.length}</p></div>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-green-100 text-green-700 rounded-xl"><CheckCircle className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">Active</p><p className="text-2xl font-bold">{tenants.filter((t: any) => t.status === "active").length}</p></div>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-blue-100 text-blue-700 rounded-xl"><Users className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">Total Users</p><p className="text-2xl font-bold">{users.length}</p></div>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-purple-100 text-purple-700 rounded-xl"><Settings className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">Enterprise Plans</p><p className="text-2xl font-bold">{tenants.filter((t: any) => t.plan === "enterprise").length}</p></div>
          </CardContent>
        </Card>
      </div>
      )}

      <Tabs defaultValue={isPlatformAdmin ? "tenants" : "ai-brand"}>
        <TabsList className="mb-6">
          {isPlatformAdmin && <TabsTrigger value="tenants" className="gap-2"><Building2 className="w-4 h-4" /> Tenants</TabsTrigger>}
          {isPlatformAdmin && <TabsTrigger value="users" className="gap-2"><Users className="w-4 h-4" /> Users</TabsTrigger>}
          <TabsTrigger value="ai-brand" className="gap-2"><Sparkles className="w-4 h-4" /> AI Brand</TabsTrigger>
        </TabsList>

        <TabsContent value="tenants">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Tenants</CardTitle>
              <Button size="sm" className="gap-1.5" onClick={() => setAddTenantOpen(true)}>
                <Plus className="w-4 h-4" /> Add Tenant
              </Button>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left font-medium text-muted-foreground py-3 px-2">Name</th>
                      <th className="text-left font-medium text-muted-foreground py-3 px-2">Plan</th>
                      <th className="text-left font-medium text-muted-foreground py-3 px-2">Status</th>
                      <th className="text-right font-medium text-muted-foreground py-3 px-2">Users</th>
                      <th className="text-right font-medium text-muted-foreground py-3 px-2">Jobs</th>
                      <th className="text-right font-medium text-muted-foreground py-3 px-2">Created</th>
                      <th className="py-3 px-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {tenantsLoading && (
                      <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">Loading tenants…</td></tr>
                    )}
                    {!tenantsLoading && tenantsError && (
                      <tr><td colSpan={7} className="py-8 text-center text-red-500">Failed to load tenants.</td></tr>
                    )}
                    {!tenantsLoading && !tenantsError && tenants.length === 0 && (
                      <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">No tenants yet.</td></tr>
                    )}
                    {tenants.map((t: any) => (
                      <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-3.5 px-2 font-semibold">{t.name}</td>
                        <td className="py-3.5 px-2"><Badge className={`text-[10px] border capitalize ${planColors[t.plan] || planColors.starter}`}>{t.plan}</Badge></td>
                        <td className="py-3.5 px-2">
                          <span className={`flex items-center gap-1.5 text-xs font-medium ${t.status === "active" ? "text-green-600" : "text-red-500"}`}>
                            {t.status === "active" ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                            {t.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-2 text-right text-muted-foreground">{t.userCount}</td>
                        <td className="py-3.5 px-2 text-right text-muted-foreground">{t.jobCount}</td>
                        <td className="py-3.5 px-2 text-right text-muted-foreground">{t.createdAt ? format(parseISO(t.createdAt), "MMM d, yyyy") : "—"}</td>
                        <td className="py-3.5 px-2 text-right">
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditTenant({ ...t })}>Edit</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Users</CardTitle>
              <Button size="sm" className="gap-1.5" onClick={() => setAddUserOpen(true)}>
                <Plus className="w-4 h-4" /> Add User
              </Button>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left font-medium text-muted-foreground py-3 px-2">User</th>
                      <th className="text-left font-medium text-muted-foreground py-3 px-2">Role</th>
                      <th className="text-left font-medium text-muted-foreground py-3 px-2">Tenant</th>
                      <th className="text-left font-medium text-muted-foreground py-3 px-2">Status</th>
                      <th className="text-right font-medium text-muted-foreground py-3 px-2">Joined</th>
                      <th className="py-3 px-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {usersLoading && (
                      <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">Loading users…</td></tr>
                    )}
                    {!usersLoading && usersError && (
                      <tr><td colSpan={6} className="py-8 text-center text-red-500">Failed to load users.</td></tr>
                    )}
                    {!usersLoading && !usersError && users.length === 0 && (
                      <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">No users yet.</td></tr>
                    )}
                    {users.map((u: any) => {
                      const tenantName = u.tenantName || tenants.find((t: any) => t.id === u.tenantId)?.name || u.tenantId;
                      const status = u.status || "active";
                      return (
                        <tr key={u.id} className="hover:bg-muted/30 transition-colors">
                          <td className="py-3.5 px-2">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs">{u.name?.charAt(0)}</div>
                              <div>
                                <p className="font-medium">{u.name}</p>
                                <p className="text-xs text-muted-foreground">{u.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-3.5 px-2"><Badge className={`text-[10px] border ${roleColors[u.role] || roleColors.recruiter}`}>{u.role?.replace(/_/g, " ")}</Badge></td>
                          <td className="py-3.5 px-2 text-muted-foreground">{tenantName}</td>
                          <td className="py-3.5 px-2">
                            <span className={`text-xs font-medium ${status === "active" ? "text-green-600" : "text-red-500"}`}>{status}</span>
                          </td>
                          <td className="py-3.5 px-2 text-right text-muted-foreground">{u.createdAt ? format(parseISO(u.createdAt), "MMM d, yyyy") : "—"}</td>
                          <td className="py-3.5 px-2 text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7"
                              disabled={updateUserStatus.isPending || u.id === user?.id}
                              onClick={() => updateUserStatus.mutate({ userId: u.id, status: status === "active" ? "suspended" : "active" })}
                            >
                              {status === "active" ? "Suspend" : "Activate"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ai-brand">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <div>
                <CardTitle>AI Brand Profile</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">The brand voice, values, and documents every AI-generated message draws from.</p>
              </div>
              {tenants.length > 0 && (
                <select
                  value={brandTenantId || defaultBrandTenantId || tenants[0]?.id || ""}
                  onChange={(e) => setBrandTenantId(e.target.value)}
                  className="text-sm bg-transparent border border-border/60 rounded-lg px-2 py-1.5 focus:outline-none focus:border-primary"
                >
                  {tenants.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
            </CardHeader>
            <CardContent>
              {tenants.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8">Create a tenant first to configure its AI brand profile.</p>
              ) : (
                <BrandProfilePanel tenantId={brandTenantId || defaultBrandTenantId || tenants[0].id} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Add Tenant Dialog ──────────────────────────────────────────── */}
      <Dialog open={addTenantOpen} onOpenChange={setAddTenantOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Tenant</DialogTitle>
            <DialogDescription>Create a new tenant organization on the platform.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="t-name">Name</Label>
              <Input
                id="t-name"
                value={newTenant.name}
                onChange={(e) => setNewTenant((s) => ({ ...s, name: e.target.value, slug: s.slug || slugify(e.target.value) }))}
                placeholder="Acme Corp"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-slug">Slug</Label>
              <Input
                id="t-slug"
                value={newTenant.slug}
                onChange={(e) => setNewTenant((s) => ({ ...s, slug: slugify(e.target.value) }))}
                placeholder="acme-corp"
              />
              <p className="text-xs text-muted-foreground">URL-safe identifier. Auto-generated from name; edit if needed.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-plan">Plan</Label>
              <Select value={newTenant.plan} onValueChange={(v) => setNewTenant((s) => ({ ...s, plan: v as any }))}>
                <SelectTrigger id="t-plan"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="growth">Growth</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddTenantOpen(false)}>Cancel</Button>
            <Button onClick={handleAddTenantSubmit} disabled={createTenant.isPending}>
              {createTenant.isPending ? "Creating…" : "Create Tenant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Tenant Dialog ─────────────────────────────────────────── */}
      <Dialog open={!!editTenant} onOpenChange={(o) => !o && setEditTenant(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Tenant</DialogTitle>
            <DialogDescription>Update tenant name, plan, or status.</DialogDescription>
          </DialogHeader>
          {editTenant && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="et-name">Name</Label>
                <Input
                  id="et-name"
                  value={editTenant.name ?? ""}
                  onChange={(e) => setEditTenant((s: any) => ({ ...s, name: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="et-plan">Plan</Label>
                  <Select value={editTenant.plan ?? "growth"} onValueChange={(v) => setEditTenant((s: any) => ({ ...s, plan: v }))}>
                    <SelectTrigger id="et-plan"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="starter">Starter</SelectItem>
                      <SelectItem value="growth">Growth</SelectItem>
                      <SelectItem value="enterprise">Enterprise</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="et-status">Status</Label>
                  <Select value={editTenant.status ?? "active"} onValueChange={(v) => setEditTenant((s: any) => ({ ...s, status: v }))}>
                    <SelectTrigger id="et-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="trial">Trial</SelectItem>
                      <SelectItem value="suspended">Suspended</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditTenant(null)}>Cancel</Button>
            <Button onClick={handleEditTenantSubmit} disabled={updateTenant.isPending}>
              {updateTenant.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add User Dialog ────────────────────────────────────────────── */}
      <Dialog open={addUserOpen} onOpenChange={setAddUserOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>Invite a new user to a tenant.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="u-name">Name</Label>
                <Input id="u-name" value={newUser.name} onChange={(e) => setNewUser((s) => ({ ...s, name: e.target.value }))} placeholder="Jane Doe" autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-email">Email</Label>
                <Input id="u-email" type="email" value={newUser.email} onChange={(e) => setNewUser((s) => ({ ...s, email: e.target.value }))} placeholder="jane@acme.com" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-password">Temporary password</Label>
              <Input id="u-password" type="password" minLength={12} value={newUser.password} onChange={(e) => setNewUser((s) => ({ ...s, password: e.target.value }))} placeholder="At least 12 characters" />
              <p className="text-xs text-muted-foreground">
                At least 12 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="u-role">Role</Label>
                <Select value={newUser.role} onValueChange={(v) => setNewUser((s) => ({ ...s, role: v }))}>
                  <SelectTrigger id="u-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="platform_admin">Platform Admin</SelectItem>
                    <SelectItem value="tenant_admin">Tenant Admin</SelectItem>
                    <SelectItem value="recruiter">Recruiter</SelectItem>
                    <SelectItem value="hiring_manager">Hiring Manager</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-tenant">Tenant</Label>
                <Select value={newUser.tenantId} onValueChange={(v) => setNewUser((s) => ({ ...s, tenantId: v }))}>
                  <SelectTrigger id="u-tenant"><SelectValue placeholder="Select a tenant" /></SelectTrigger>
                  <SelectContent>
                    {tenants.map((t: any) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddUserOpen(false)}>Cancel</Button>
            <Button onClick={handleAddUserSubmit} disabled={createUser.isPending}>
              {createUser.isPending ? "Creating…" : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
