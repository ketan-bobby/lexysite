/**
 * pages/recruiter/verify.tsx — Candidate Verification Dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Cross-job view of all candidate verification records. Lets recruiters
 * triage candidates by verification status and take action on flagged records.
 *
 * ─── Verification states ─────────────────────────────────────────────────────
 *   unverified  — no verification has been run yet
 *   in_progress — Verification Agent is currently running
 *   verified    — all checks passed; green badge
 *   flagged     — one or more risk flags detected; red badge with flag list
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   StatusFilter     — tabs: All / Flagged / Verified / Pending
 *   CandidateCard    — name, current role, risk score badge, flag list,
 *                      identity / duplicate / resume-consistency indicators
 *   RiskDetailPanel  — expandable accordion with per-flag explanations and
 *                      recruiter review notes
 *
 * ─── Actions ─────────────────────────────────────────────────────────────────
 *   "Re-verify"      — triggers the Verification Agent for one candidate
 *   "Override"       — recruiter manually marks as verified (with notes)
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/candidates?includeVerification=true — candidates + verification status
 *   PUT /api/verify/:candidateId                 — update verification record
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/verify
 */
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  ShieldCheck, ShieldAlert, ShieldX, ChevronDown, ChevronUp,
  Linkedin, FileText, Clock, Mail, Phone, Zap, CheckSquare, XSquare, AlertTriangle, RotateCcw
} from "lucide-react";

type CheckResult = "pass" | "fail" | "warn" | "pending";

interface IdentityChecks {
  linkedinMatch: CheckResult;
  resumeMatch: CheckResult;
  linkedinProfileAge: CheckResult;
  disposableEmail: CheckResult;
  burnerPhone: CheckResult;
}

interface Candidate {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  checks: IdentityChecks;
  notes: Partial<Record<keyof IdentityChecks, string>>;
}

// Demo dataset illustrating the verification UI across the full risk spectrum
// (clean pass → mixed warnings → fully flagged). Real records come from the
// candidates API with includeVerification=true.
const candidates: Candidate[] = [
  {
    id: "1",
    name: "Sarah Chen",
    role: "Senior Software Engineer",
    email: "sarah.chen@gmail.com",
    phone: "+1 415 555 0182",
    linkedinUrl: "linkedin.com/in/sarahchen-eng",
    checks: {
      linkedinMatch: "pass",
      resumeMatch: "pass",
      linkedinProfileAge: "pass",
      disposableEmail: "pass",
      burnerPhone: "pass",
    },
    notes: {
      linkedinProfileAge: "Profile created 6 years ago",
    },
  },
  {
    id: "2",
    name: "Marcus Johnson",
    role: "Product Manager",
    email: "mjohnson_temp@mailnull.com",
    phone: "+1 888 555 0193",
    linkedinUrl: "linkedin.com/in/marcusjohnson-pm",
    checks: {
      linkedinMatch: "pass",
      resumeMatch: "warn",
      linkedinProfileAge: "pass",
      disposableEmail: "fail",
      burnerPhone: "warn",
    },
    notes: {
      resumeMatch: "Job title differs slightly from LinkedIn",
      disposableEmail: "mailnull.com is a known disposable provider",
      burnerPhone: "Number flagged as VoIP / virtual",
    },
  },
  {
    id: "3",
    name: "Alex Rivera",
    role: "Data Scientist",
    email: "alex.rivera@proton.me",
    phone: "+1 312 555 0047",
    linkedinUrl: "linkedin.com/in/alex-rivera-data",
    checks: {
      linkedinMatch: "fail",
      resumeMatch: "fail",
      linkedinProfileAge: "warn",
      disposableEmail: "pass",
      burnerPhone: "pass",
    },
    notes: {
      linkedinMatch: "No LinkedIn profile found matching this name + email",
      resumeMatch: "Claimed PhD — LinkedIn and external sources show MSc",
      linkedinProfileAge: "Profile created 4 months ago",
    },
  },
  {
    id: "4",
    name: "Priya Patel",
    role: "UX Designer",
    email: "priya.patel@outlook.com",
    phone: "+44 7911 123456",
    linkedinUrl: "linkedin.com/in/priyapatel-ux",
    checks: {
      linkedinMatch: "pass",
      resumeMatch: "pass",
      linkedinProfileAge: "pass",
      disposableEmail: "pass",
      burnerPhone: "pass",
    },
    notes: {
      linkedinProfileAge: "Profile active for 4 years",
    },
  },
  {
    id: "5",
    name: "Tom Williams",
    role: "DevOps Engineer",
    email: "twilliams99@guerrillamail.com",
    phone: "+1 555 555 5555",
    linkedinUrl: "—",
    checks: {
      linkedinMatch: "fail",
      resumeMatch: "fail",
      linkedinProfileAge: "fail",
      disposableEmail: "fail",
      burnerPhone: "fail",
    },
    notes: {
      linkedinMatch: "No verifiable LinkedIn presence found",
      resumeMatch: "Resume company names could not be corroborated online",
      linkedinProfileAge: "No LinkedIn profile exists",
      disposableEmail: "guerrillamail.com is a throwaway provider",
      burnerPhone: "Sequential pattern — likely fictitious number",
    },
  },
];

// Per-check display config (icon + pass/warn/fail copy) driving each row.
const checkMeta: {
  key: keyof IdentityChecks;
  label: string;
  icon: React.ElementType;
  passLabel: string;
  failLabel: string;
  warnLabel: string;
}[] = [
  {
    key: "linkedinMatch",
    label: "LinkedIn Match",
    icon: Linkedin,
    passLabel: "Profile verified",
    failLabel: "No match found",
    warnLabel: "Partial match",
  },
  {
    key: "resumeMatch",
    label: "Resume Match",
    icon: FileText,
    passLabel: "Consistent",
    failLabel: "Discrepancy detected",
    warnLabel: "Minor mismatch",
  },
  {
    key: "linkedinProfileAge",
    label: "LinkedIn Profile Age",
    icon: Clock,
    passLabel: "Established profile",
    failLabel: "Profile missing / new",
    warnLabel: "Profile < 6 months old",
  },
  {
    key: "disposableEmail",
    label: "Disposable Email",
    icon: Mail,
    passLabel: "Legitimate email",
    failLabel: "Throwaway address detected",
    warnLabel: "Unusual domain",
  },
  {
    key: "burnerPhone",
    label: "Burner Phone",
    icon: Phone,
    passLabel: "Real number",
    failLabel: "VoIP / burner detected",
    warnLabel: "VoIP possible",
  },
];

// Weighted risk score: fail counts 2, warn/pending 1, pass 0. Higher = riskier.
function resultScore(checks: IdentityChecks): number {
  const vals: Record<CheckResult, number> = { pass: 0, warn: 1, pending: 1, fail: 2 };
  return Object.values(checks).reduce((sum, v) => sum + vals[v as CheckResult], 0);
}

// Roll the individual checks into one overall verdict. Any pending check keeps
// the whole record pending; otherwise severity is driven by fails + total score.
function overallStatus(checks: IdentityChecks): "verified" | "flagged" | "failed" | "pending" {
  const score = resultScore(checks);
  const hasFail = Object.values(checks).some(v => v === "fail");
  const hasPending = Object.values(checks).some(v => v === "pending");
  if (hasPending) return "pending";
  if (hasFail && score >= 4) return "failed";
  if (hasFail || score >= 2) return "flagged";
  return "verified";
}

const statusConfig = {
  verified: { label: "Verified", icon: ShieldCheck, color: "text-green-600", badge: "bg-green-100 text-green-700 border-green-200" },
  flagged: { label: "Flagged", icon: ShieldAlert, color: "text-orange-500", badge: "bg-orange-100 text-orange-700 border-orange-200" },
  failed: { label: "Failed", icon: ShieldX, color: "text-red-600", badge: "bg-red-100 text-reded-700 border-red-200" },
  pending: { label: "Pending", icon: ShieldAlert, color: "text-blue-500", badge: "bg-blue-100 text-blue-700 border-blue-200" },
};

// One verification check line: icon, label, status pill, and optional note.
function CheckRow({ meta, result, note }: {
  meta: typeof checkMeta[number];
  result: CheckResult;
  note?: string;
}) {
  const Icon = meta.icon;
  const isPass = result === "pass";
  const isFail = result === "fail";
  const isWarn = result === "warn";

  return (
    <div className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
      isPass ? "bg-green-50/60 border-green-200/70 dark:bg-green-900/10 dark:border-green-800/40" :
      isFail ? "bg-red-50/60 border-red-200/70 dark:bg-red-900/10 dark:border-red-800/40" :
      isWarn ? "bg-orange-50/60 border-orange-200/70 dark:bg-orange-900/10" :
      "bg-muted/40 border-border/40"
    }`}>
      <div className="flex-shrink-0 mt-0.5">
        {isPass ? <CheckSquare className="w-5 h-5 text-green-600" /> :
         isFail ? <XSquare className="w-5 h-5 text-red-500" /> :
         isWarn ? <AlertTriangle className="w-5 h-5 text-orange-500" /> :
         <div className="w-5 h-5 rounded border-2 border-blue-400 border-t-transparent animate-spin" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Icon className={`w-3.5 h-3.5 ${isPass ? "text-green-600" : isFail ? "text-red-500" : "text-orange-500"}`} />
          <span className="text-sm font-semibold text-foreground">{meta.label}</span>
        </div>
        <p className={`text-xs mt-0.5 ${isPass ? "text-green-700 dark:text-green-400" : isFail ? "text-red-600" : isWarn ? "text-orange-600" : "text-muted-foreground"}`}>
          {note || (isPass ? meta.passLabel : isFail ? meta.failLabel : isWarn ? meta.warnLabel : "Checking…")}
        </p>
      </div>
    </div>
  );
}

export default function Verify() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const handleRun = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRunning(id);
    setTimeout(() => setRunning(null), 2000);
  };

  const totals = {
    verified: candidates.filter(c => overallStatus(c.checks) === "verified").length,
    flagged: candidates.filter(c => overallStatus(c.checks) === "flagged").length,
    failed: candidates.filter(c => overallStatus(c.checks) === "failed").length,
  };

  return (
    <AppLayout>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="page-title">Identity Verification</h1>
          <p className="text-muted-foreground mt-1">
            Digital signal checks — LinkedIn, resume consistency, profile age, disposable email &amp; burner phone detection.
          </p>
        </div>
        <Button className="gap-2 hover-elevate">
          <Zap className="w-4 h-4" /> Run Batch Check
        </Button>
      </div>

      {/* Summary pills */}
      <div className="flex flex-wrap gap-3 mb-8">
        <div className="flex items-center gap-2 bg-green-100 dark:bg-green-900/20 border border-green-200 dark:border-green-800/40 rounded-full px-4 py-2">
          <ShieldCheck className="w-4 h-4 text-green-600" />
          <span className="text-sm font-semibold text-green-700 dark:text-green-400">{totals.verified} Verified</span>
        </div>
        <div className="flex items-center gap-2 bg-orange-100 dark:bg-orange-900/20 border border-orange-200 rounded-full px-4 py-2">
          <ShieldAlert className="w-4 h-4 text-orange-500" />
          <span className="text-sm font-semibold text-orange-700">{totals.flagged} Flagged</span>
        </div>
        <div className="flex items-center gap-2 bg-red-100 dark:bg-red-900/20 border border-red-200 rounded-full px-4 py-2">
          <ShieldX className="w-4 h-4 text-red-600" />
          <span className="text-sm font-semibold text-red-700">{totals.failed} Failed</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 border border-border/60 rounded-full px-4 py-2">
          <CheckSquare className="w-3.5 h-3.5" />
          5 checks per candidate · No criminal record lookups
        </div>
      </div>

      {/* Candidate list */}
      <div className="space-y-3">
        {candidates.map((c) => {
          const status = overallStatus(c.checks);
          const cfg = statusConfig[status];
          const StatusIcon = cfg.icon;
          const isExpanded = expanded === c.id;
          const isRunning = running === c.id;
          const passCount = Object.values(c.checks).filter(v => v === "pass").length;

          return (
            <Card key={c.id} className={`hover-elevate border transition-all duration-200 ${
              status === "verified" ? "border-green-200/60 dark:border-green-900/40" :
              status === "failed" ? "border-red-200/60 dark:border-red-900/40" :
              status === "flagged" ? "border-orange-200/60" : "border-border/60"
            }`}>
              <CardContent className="p-5">
                {/* Row header */}
                <div
                  className="flex items-center justify-between gap-4 cursor-pointer select-none"
                  onClick={() => setExpanded(isExpanded ? null : c.id)}
                >
                  <div className="flex items-center gap-4">
                    <StatusIcon className={`w-6 h-6 flex-shrink-0 ${cfg.color}`} />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{c.name}</p>
                        <Badge className={`text-[10px] border ${cfg.badge}`}>{cfg.label}</Badge>
                        <span className="text-[10px] text-muted-foreground font-medium">
                          {passCount}/5 checks passed
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">{c.role}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 flex-shrink-0">
                    {/* Mini indicator dots */}
                    <div className="hidden md:flex items-center gap-1">
                      {checkMeta.map(m => {
                        const r = c.checks[m.key];
                        return (
                          <div key={m.key} className={`w-2.5 h-2.5 rounded-full ${
                            r === "pass" ? "bg-green-500" :
                            r === "fail" ? "bg-red-500" :
                            r === "warn" ? "bg-orange-400" : "bg-blue-400"
                          }`} title={m.label} />
                        );
                      })}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-muted-foreground hover:text-foreground"
                      onClick={(e) => handleRun(c.id, e)}
                      aria-label={`Re-run verification for ${c.name}`}
                    >
                      <RotateCcw className={`w-3.5 h-3.5 ${isRunning ? "animate-spin" : ""}`} />
                    </Button>
                    {isExpanded ? <ChevronUp className="w-5 h-5 text-muted-foreground" /> : <ChevronDown className="w-5 h-5 text-muted-foreground" />}
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="mt-5 pt-5 border-t border-border/40 animate-in fade-in slide-in-from-top-2 duration-200">
                    {/* Contact info */}
                    <div className="flex flex-wrap gap-4 mb-5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" /> {c.email}</span>
                      <span className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> {c.phone}</span>
                      <span className="flex items-center gap-1.5"><Linkedin className="w-3.5 h-3.5" /> {c.linkedinUrl}</span>
                    </div>

                    {/* 5 check rows */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-5">
                      {checkMeta.map(meta => (
                        <CheckRow
                          key={meta.key}
                          meta={meta}
                          result={c.checks[meta.key]}
                          note={c.notes[meta.key]}
                        />
                      ))}
                    </div>

                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="outline" onClick={(e) => handleRun(c.id, e)}>
                        <RotateCcw className={`w-3.5 h-3.5 mr-1.5 ${isRunning ? "animate-spin" : ""}`} />
                        Re-run Checks
                      </Button>
                      {status === "verified" && (
                        <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white">
                          <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Mark Complete
                        </Button>
                      )}
                      {(status === "flagged" || status === "failed") && (
                        <Button size="sm" variant="destructive">
                          <ShieldX className="w-3.5 h-3.5 mr-1.5" /> Escalate to HR
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </AppLayout>
  );
}
