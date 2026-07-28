/**
 * components/team/OrgChart.tsx — top-down org / assignment tree.
 *
 * Renders the agency hierarchy so admins can see "who is assigned to whom":
 *   Tenant Admin → Recruiter Admins → assigned Clients, plus grouped
 *   Recruiters / Hiring Managers / Interviewers.
 *
 * Pure presentational component — all data is passed in via props.
 */
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Shield, User, UserCog, Building2, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import "./org-chart.css";

type Member = { id?: string; name?: string; email?: string; role?: string };
type RecruiterAdmin = {
  id?: string;
  name?: string;
  email?: string;
  clients?: { clientTenantId?: string; clientName?: string }[];
  // Recruiters reporting to this admin (recruiter_managers links).
  recruiters?: { id?: string; name?: string; email?: string }[];
};

type TreeNodeData = {
  key: string;
  type: string;
  name: string;
  email?: string;
  count?: number;
  id?: string;
  children?: TreeNodeData[];
};

// A node is clickable when the parent wires onSelect and the node maps to a
// person with a management dialog (recruiter → reporting, admin → clients).
type SelectArg = { type: string; id: string };
function isActionable(node: TreeNodeData, onSelect?: (s: SelectArg) => void) {
  return !!onSelect && !!node.id && (node.type === "recruiter" || node.type === "recruiter_admin");
}

// Per-node visual config (icon + accent colours) keyed by node type.
const nodeStyle: Record<string, { icon: any; ring: string; chip: string; label: string }> = {
  agency:          { icon: Building2, ring: "border-primary/40",       chip: "bg-primary/10 text-primary",            label: "Agency" },
  platform_admin:  { icon: Shield,    ring: "border-red-500/40",       chip: "bg-red-500/10 text-red-300",            label: "Platform Admin" },
  tenant_admin:    { icon: Shield,    ring: "border-violet-500/40",    chip: "bg-violet-500/10 text-violet-300",      label: "Admin" },
  recruiter_admin: { icon: UserCog,   ring: "border-amber-500/40",     chip: "bg-amber-500/10 text-amber-300",        label: "Recruiter Admin" },
  recruiter:       { icon: User,      ring: "border-blue-500/40",      chip: "bg-blue-500/10 text-blue-300",          label: "Recruiter" },
  hiring_manager:  { icon: UserCog,   ring: "border-emerald-500/40",   chip: "bg-emerald-500/10 text-emerald-300",    label: "Hiring Manager" },
  interviewer:     { icon: UserCog,   ring: "border-cyan-500/40",      chip: "bg-cyan-500/10 text-cyan-300",          label: "Interviewer" },
  client:          { icon: Building2, ring: "border-amber-500/30",     chip: "bg-amber-500/10 text-amber-300",        label: "Client" },
  group:           { icon: Users,     ring: "border-border",           chip: "bg-muted text-muted-foreground",        label: "" },
  team:            { icon: Users,     ring: "border-border",           chip: "bg-muted text-muted-foreground",        label: "" },
};

const PERSON_TYPES = new Set(["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager", "interviewer"]);

function initials(name?: string, email?: string) {
  return (name || email || "?")
    .split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function NodeBox({ node, onSelect }: { node: TreeNodeData; onSelect?: (s: SelectArg) => void }) {
  const cfg = nodeStyle[node.type] || nodeStyle.group;
  const Icon = cfg.icon;
  const isPerson = PERSON_TYPES.has(node.type);
  const actionable = isActionable(node, onSelect);
  const activate = () => { if (actionable) onSelect!({ type: node.type, id: node.id! }); };
  return (
    <div
      role={actionable ? "button" : undefined}
      tabIndex={actionable ? 0 : undefined}
      onClick={actionable ? activate : undefined}
      onKeyDown={actionable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } } : undefined}
      title={actionable ? (node.type === "recruiter" ? "Manage reporting structure" : "Manage client assignments") : undefined}
      className={cn(
        "org-node inline-flex flex-col items-center gap-1.5 rounded-xl border bg-card px-3 py-2.5 shadow-sm",
        "min-w-[150px] max-w-[190px] align-top",
        cfg.ring,
        actionable && "cursor-pointer transition-shadow hover:shadow-md hover:border-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
      )}
    >
      {isPerson ? (
        <Avatar className="w-9 h-9 border border-border">
          <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
            {initials(node.name, node.email)}
          </AvatarFallback>
        </Avatar>
      ) : (
        <div className={cn("w-9 h-9 rounded-full flex items-center justify-center", cfg.chip)}>
          <Icon className="w-4 h-4" />
        </div>
      )}
      <p className="font-medium text-sm leading-tight truncate max-w-full">{node.name}</p>
      {node.email && (
        <p className="text-[11px] text-muted-foreground truncate max-w-full">{node.email}</p>
      )}
      <Badge variant="outline" className={cn("text-[10px] gap-1 border-transparent", cfg.chip)}>
        {!isPerson && <Icon className="w-2.5 h-2.5" />}
        {node.type === "group" ? `${node.count} ${node.name}` : node.type === "team" ? node.name : cfg.label}
      </Badge>
    </div>
  );
}

function TreeNode({ node, onSelect }: { node: TreeNodeData; onSelect?: (s: SelectArg) => void }) {
  return (
    <li>
      <NodeBox node={node} onSelect={onSelect} />
      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.key} node={c} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgChart({
  members,
  recruiterAdmins,
  tenantName,
  onSelect,
}: {
  members: Member[];
  recruiterAdmins: RecruiterAdmin[];
  tenantName?: string;
  onSelect?: (s: SelectArg) => void;
}) {
  const safeMembers = Array.isArray(members) ? members : [];
  const tenantAdmins = safeMembers.filter((m) => m.role === "tenant_admin" || m.role === "platform_admin");
  const recruiters = safeMembers.filter((m) => m.role === "recruiter");
  const hiringManagers = safeMembers.filter((m) => m.role === "hiring_manager");
  const interviewers = safeMembers.filter((m) => m.role === "interviewer");

  // Recruiter Admins (with their assigned client sub-tenants + reporting
  // recruiters) form the middle tier.
  const raNodes: TreeNodeData[] = (recruiterAdmins ?? []).map((ra, i) => ({
    key: ra.id || `ra-${i}`,
    type: "recruiter_admin",
    name: ra.name || ra.email || "Recruiter Admin",
    email: ra.email,
    id: ra.id,
    children: [
      ...(ra.clients ?? []).map((c, j) => ({
        key: `${ra.id || i}-client-${c.clientTenantId || j}`,
        type: "client",
        name: c.clientName || c.clientTenantId || "Client",
      })),
      ...(ra.recruiters ?? []).map((r, j) => ({
        key: `${ra.id || i}-recruiter-${r.id || j}`,
        type: "recruiter",
        name: r.name || r.email || "Recruiter",
        email: r.email,
        id: r.id,
      })),
    ],
  }));

  // Recruiters who report to at least one admin are shown under that admin; the
  // grouped "Recruiters" bucket holds only those reporting to no one.
  const assignedRecruiterIds = new Set<string>();
  for (const ra of recruiterAdmins ?? []) {
    for (const r of ra.recruiters ?? []) {
      if (r.id) assignedRecruiterIds.add(r.id);
    }
  }
  const unassignedRecruiters = recruiters.filter((m) => !m.id || !assignedRecruiterIds.has(m.id));

  // Recruiters with no recruiter-admin reporting line stand on their own at the
  // recruiting tier (individual nodes, NOT bucketed under a "Recruiters" group).
  const unassignedRecruiterNodes: TreeNodeData[] = unassignedRecruiters.map((m, i) => ({
    key: m.id || `recruiter-${i}`,
    type: "recruiter",
    name: m.name || m.email || "Recruiter",
    email: m.email,
    id: m.id,
  }));

  // Grouped line staff (no per-recruiter-admin reporting line exists in the model).
  function groupNode(type: string, label: string, list: Member[]): TreeNodeData | null {
    if (list.length === 0) return null;
    return {
      key: `group-${type}`,
      type: "group",
      name: label,
      count: list.length,
      children: list.map((m, i) => ({
        key: m.id || `${type}-${i}`,
        type,
        name: m.name || m.email || label,
        email: m.email,
        id: m.id,
      })),
    };
  }

  const subtree: TreeNodeData[] = [
    ...raNodes,
    ...unassignedRecruiterNodes,
    groupNode("hiring_manager", "Hiring Managers", hiringManagers),
    groupNode("interviewer", "Interviewers", interviewers),
  ].filter(Boolean) as TreeNodeData[];

  // Root composition keeps the tenant-admin layer ABOVE recruiter admins:
  //   • exactly one admin → that admin is the top node, recruiting subtree below.
  //   • multiple admins   → an "Agency" root holds the admins, and the recruiting
  //     subtree hangs off a synthetic "Recruiting" node one tier lower (we can't
  //     attribute a recruiter admin to a specific tenant admin).
  //   • no admins         → the "Agency" root holds the recruiting subtree directly.
  const recruitingNode: TreeNodeData | null = subtree.length > 0
    ? { key: "recruiting", type: "team", name: "Recruiting", children: subtree }
    : null;

  let root: TreeNodeData;
  if (tenantAdmins.length === 1) {
    const a = tenantAdmins[0];
    root = {
      key: a.id || "root-admin",
      type: a.role || "tenant_admin",
      name: a.name || a.email || "Admin",
      email: a.email,
      children: subtree,
    };
  } else {
    root = {
      key: "agency",
      type: "agency",
      name: tenantName || "Agency",
      children: [
        ...tenantAdmins.map((a, i) => ({
          key: a.id || `admin-${i}`,
          type: a.role || "tenant_admin",
          name: a.name || a.email || "Admin",
          email: a.email,
        })),
        ...(recruitingNode ? [recruitingNode] : []),
      ],
    };
  }

  return (
    <div>
      <div className="overflow-x-auto pb-2">
        <div className="org-tree">
          <ul>
            <TreeNode node={root} onSelect={onSelect} />
          </ul>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground mt-3 text-center">
        Recruiter Admins show their assigned clients and reporting recruiters.
        Recruiters without a manager appear on their own. Hiring Managers and Interviewers are grouped by role.
      </p>
    </div>
  );
}
