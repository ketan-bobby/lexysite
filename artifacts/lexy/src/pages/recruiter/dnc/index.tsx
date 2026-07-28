/**
 * pages/recruiter/dnc/index.tsx — Do-Not-Contact List Manager
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * View and manage the tenant's Do-Not-Contact list. Shows all candidates who
 * have opted out (via unsubscribe link or recruiter action) and allows
 * removing candidates from the list if they later re-consent.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   DNC Table        — candidate name, email, how they were added (self-opt-out /
 *                      recruiter-flagged / bulk-import), date added
 *   Search + Filter  — search by name/email; filter by reason
 *   "Remove from DNC" — DELETE /api/dnc/:candidateId (re-enables outreach)
 *   "Bulk Add"       — paste or upload a list of emails to add in one action
 *
 * ─── Opt-out reason icons ────────────────────────────────────────────────────
 *   Bot icon          — auto-flagged by DNC action in outreach reply
 *   User icon         — manually added by a recruiter
 *   MessageSquareX    — candidate clicked unsubscribe link in email
 *   Shield icon       — added via bulk-import or compliance upload
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET    /api/dnc          — list DNC candidates
 *   DELETE /api/dnc/:id      — remove from DNC
 *   POST   /api/dnc/bulk     — bulk add
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/dnc
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow, parseISO } from "date-fns";
import {
  ShieldOff, Search, UserX, Trash2, RotateCcw, AlertTriangle,
  CheckCircle2, RefreshCw, Bot, User, MessageSquareX, Shield,
  ChevronDown, ChevronUp, ExternalLink,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@workspace/react-hooks/use-toast";
import { cn } from "@/lib/utils";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `API ${res.status}`);
  }
  return res.json();
}

interface DNCCandidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  currentTitle: string | null;
  currentCompany: string | null;
  doNotContact: boolean;
  dncAt: string | null;
  dncReason: string | null;
  dncSetBy: string | null;
  dataErasedAt: string | null;
}

const REASON_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  manual:           { label: "Manually flagged",       icon: User,           color: "text-blue-400" },
  ai_unsubscribe:   { label: "AI: unsubscribe detected", icon: Bot,          color: "text-purple-400" },
  reply_sentiment:  { label: "Reply: do not contact",  icon: MessageSquareX, color: "text-orange-400" },
  gdpr_erasure:     { label: "GDPR erasure",           icon: ShieldOff,      color: "text-red-400" },
};

function getReason(dncReason: string | null) {
  if (!dncReason) return REASON_CONFIG.manual;
  const key = Object.keys(REASON_CONFIG).find(k => dncReason.startsWith(k));
  return key ? REASON_CONFIG[key] : { label: dncReason, icon: AlertTriangle, color: "text-muted-foreground" };
}

export default function DNCManagerPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  // Dialogs
  const [removeDlg, setRemoveDlg] = useState<DNCCandidate | null>(null);
  const [removeDlgJustification, setRemoveDlgJustification] = useState("");
  const [eraseDlg, setEraseDlg] = useState<DNCCandidate | null>(null);
  const [eraseConfirmText, setEraseConfirmText] = useState("");

  // Add DNC dialog
  const [addDlg, setAddDlg] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addSearchResult, setAddSearchResult] = useState<any>(null);
  const [addSearching, setAddSearching] = useState(false);
  const [addReason, setAddReason] = useState("");

  const { data: dncList = [], isLoading } = useQuery<DNCCandidate[]>({
    queryKey: ["dnc-list"],
    queryFn: () => apiFetch("/dnc"),
    refetchInterval: 60_000,
  });

  const removeMut = useMutation({
    mutationFn: ({ id, justification }: { id: string; justification: string }) =>
      apiFetch(`/dnc/${id}`, { method: "DELETE", body: JSON.stringify({ justification }) }),
    onSuccess: () => {
      toast({ title: "DNC flag removed", description: "The candidate can now be contacted again." });
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      qc.invalidateQueries({ queryKey: ["/api/candidates"] });
      qc.invalidateQueries({ queryKey: ["pipeline-stages"] });
      setRemoveDlg(null);
      setRemoveDlgJustification("");
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const eraseMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/dnc/${id}/data`, { method: "DELETE" }),
    onSuccess: (data: any) => {
      toast({ title: "Data erased", description: data.message });
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      qc.invalidateQueries({ queryKey: ["/api/candidates"] });
      qc.invalidateQueries({ queryKey: ["pipeline-stages"] });
      setEraseDlg(null);
      setEraseConfirmText("");
    },
    onError: (err: any) => toast({ title: "Erasure failed", description: err.message, variant: "destructive" }),
  });

  const flagMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch(`/dnc/${id}`, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      toast({ title: "Candidate flagged as Do Not Contact" });
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      qc.invalidateQueries({ queryKey: ["/api/candidates"] });
      qc.invalidateQueries({ queryKey: ["pipeline-stages"] });
      setAddDlg(false);
      setAddEmail("");
      setAddSearchResult(null);
      setAddReason("");
      setSearch("");
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  async function searchByEmail(): Promise<any | null> {
    if (!addEmail.trim()) return null;
    setAddSearching(true);
    try {
      const result = await apiFetch<any>(`/candidates?email=${encodeURIComponent(addEmail.trim())}`);
      const cands = Array.isArray(result) ? result : result.candidates ?? [];
      const first = cands[0] ?? null;
      setAddSearchResult(first);
      if (!first) toast({ title: "No candidate found with that email" });
      return first;
    } catch {
      toast({ title: "Search failed", variant: "destructive" });
      return null;
    } finally {
      setAddSearching(false);
    }
  }

  async function handleFlagClick() {
    let target = addSearchResult;
    if (!target) target = await searchByEmail();
    if (!target) return;
    flagMut.mutate({ id: target.id, reason: addReason || "manual" });
  }

  const filtered = dncList.filter(c => {
    const q = search.toLowerCase();
    if (!q) return true;
    return (
      c.firstName.toLowerCase().includes(q) ||
      c.lastName.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.currentCompany ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <AppLayout>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start gap-4 mb-6">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <ShieldOff className="w-6 h-6 text-primary" />
            Do Not Contact List
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Candidates who have opted out or been flagged DNC. No outreach or nurture will be sent to them.
          </p>
        </div>
        <Button className="gap-2" onClick={() => setAddDlg(true)}>
          <UserX className="w-4 h-4" /> Add to DNC List
        </Button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Card>
          <CardContent className="p-3 flex items-center gap-2">
            <div className="p-1.5 rounded-lg text-red-400 bg-red-500/10"><UserX className="w-3.5 h-3.5" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Total DNC</p>
              <p className="text-xl font-bold">{dncList.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-2">
            <div className="p-1.5 rounded-lg text-purple-400 bg-purple-500/10"><Bot className="w-3.5 h-3.5" /></div>
            <div>
              <p className="text-xs text-muted-foreground">AI-Detected</p>
              <p className="text-xl font-bold">{dncList.filter(c => c.dncReason === "ai_unsubscribe").length}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-2">
            <div className="p-1.5 rounded-lg text-red-300 bg-red-600/10"><ShieldOff className="w-3.5 h-3.5" /></div>
            <div>
              <p className="text-xs text-muted-foreground">Data Erased</p>
              <p className="text-xl font-bold">{dncList.filter(c => c.dataErasedAt).length}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, email, or company…"
          className="pl-9"
        />
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 flex flex-col items-center gap-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted/40 flex items-center justify-center">
              <Shield className="w-8 h-8 text-muted-foreground/40" />
            </div>
            <div>
              <p className="font-semibold">
                {search ? "No results match your search" : "No candidates on the DNC list"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {search ? "Try a different name or email." : "Candidates who opt out or are flagged will appear here."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(c => {
            const reasonCfg = getReason(c.dncReason);
            const ReasonIcon = reasonCfg.icon;
            const isErased = !!c.dataErasedAt;
            return (
              <Card key={c.id} className={cn("border", isErased ? "opacity-60 border-dashed" : "border-border/60")}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    <div className="p-2 rounded-full bg-red-500/10 flex-shrink-0">
                      <UserX className="w-4 h-4 text-red-400" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <p className="font-semibold text-sm">
                            {c.firstName} {c.lastName}
                            {isErased && <span className="ml-2 text-xs text-muted-foreground">(data erased)</span>}
                          </p>
                          <p className="text-xs text-muted-foreground">{c.email}</p>
                          {(c.currentTitle || c.currentCompany) && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {[c.currentTitle, c.currentCompany].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-1">
                          <div className={cn("flex items-center gap-1 text-xs", reasonCfg.color)}>
                            <ReasonIcon className="w-3 h-3" />
                            {reasonCfg.label}
                          </div>
                          {c.dncAt && (
                            <p className="text-[10px] text-muted-foreground">
                              {formatDistanceToNow(parseISO(c.dncAt), { addSuffix: true })}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      {!isErased && (
                        <div className="flex items-center gap-2 mt-3 flex-wrap">
                          <Button
                            size="sm" variant="outline"
                            className="h-7 text-xs gap-1 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                            onClick={() => { setRemoveDlg(c); setRemoveDlgJustification(""); }}
                          >
                            <RotateCcw className="w-3 h-3" /> Remove Flag
                          </Button>
                          <Button
                            size="sm" variant="outline"
                            className="h-7 text-xs gap-1 text-red-400 border-red-500/30 hover:bg-red-500/10"
                            onClick={() => { setEraseDlg(c); setEraseConfirmText(""); }}
                          >
                            <Trash2 className="w-3 h-3" /> Erase Data (GDPR)
                          </Button>
                        </div>
                      )}
                      {isErased && (
                        <Badge className="mt-2 text-[10px] bg-red-600/20 text-red-400 border-red-500/30">
                          All personal data anonymised
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Remove DNC dialog ─────────────────────────────────────────────────── */}
      <Dialog open={!!removeDlg} onOpenChange={open => { if (!open) setRemoveDlg(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-emerald-400" /> Remove DNC Flag
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              You're about to re-enable contact with{" "}
              <span className="font-medium text-foreground">
                {removeDlg?.firstName} {removeDlg?.lastName}
              </span>. This is logged for compliance.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Justification <span className="text-red-400">*</span></Label>
              <Textarea
                value={removeDlgJustification}
                onChange={e => setRemoveDlgJustification(e.target.value)}
                placeholder="e.g. Candidate re-subscribed via career portal / Confirmed by candidate in call on [date]"
                className="resize-none text-sm"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveDlg(null)}>Cancel</Button>
            <Button
              className="gap-1.5"
              disabled={!removeDlgJustification.trim() || removeMut.isPending}
              onClick={() => removeDlg && removeMut.mutate({ id: removeDlg.id, justification: removeDlgJustification })}
            >
              {removeMut.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              Confirm Removal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── GDPR Erase dialog ─────────────────────────────────────────────────── */}
      <Dialog open={!!eraseDlg} onOpenChange={open => { if (!open) setEraseDlg(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-400">
              <Trash2 className="w-4 h-4" /> GDPR Right-to-Erasure
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300 space-y-1">
              <p className="font-semibold">This action cannot be undone.</p>
              <p>All personal data for this candidate will be permanently anonymised: name, email, phone, location, LinkedIn, resume, and skills will be wiped. Application records are retained for audit purposes only.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Type <span className="font-mono text-red-400">ERASE</span> to confirm
              </Label>
              <Input
                value={eraseConfirmText}
                onChange={e => setEraseConfirmText(e.target.value)}
                placeholder="ERASE"
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEraseDlg(null)}>Cancel</Button>
            <Button
              variant="destructive"
              className="gap-1.5"
              disabled={eraseConfirmText !== "ERASE" || eraseMut.isPending}
              onClick={() => eraseDlg && eraseMut.mutate(eraseDlg.id)}
            >
              {eraseMut.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Erase All Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add to DNC dialog ─────────────────────────────────────────────────── */}
      <Dialog open={addDlg} onOpenChange={(open) => { setAddDlg(open); if (open) setSearch(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserX className="w-4 h-4 text-red-400" /> Add Candidate to DNC List
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Candidate Email</Label>
              <div className="flex gap-2">
                <Input
                  value={addEmail}
                  onChange={e => setAddEmail(e.target.value)}
                  placeholder="candidate@example.com"
                  onKeyDown={e => e.key === "Enter" && searchByEmail()}
                  className="text-sm"
                  autoComplete="new-password"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  name={`dnc-email-${Math.random().toString(36).slice(2)}`}
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                />
                <Button size="sm" variant="outline" onClick={searchByEmail} disabled={addSearching}>
                  {addSearching ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                </Button>
              </div>
            </div>

            {addSearchResult && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border text-sm space-y-1">
                <p className="font-medium">{addSearchResult.firstName} {addSearchResult.lastName}</p>
                <p className="text-xs text-muted-foreground">{addSearchResult.email}</p>
                {addSearchResult.currentTitle && (
                  <p className="text-xs text-muted-foreground">{addSearchResult.currentTitle}</p>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">Reason (optional)</Label>
              <Input
                value={addReason}
                onChange={e => setAddReason(e.target.value)}
                placeholder="e.g. Candidate requested removal via LinkedIn"
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddDlg(false); setAddSearchResult(null); setAddEmail(""); }}>
              Cancel
            </Button>
            <Button
              className="gap-1.5"
              disabled={!addEmail.trim() || flagMut.isPending || addSearching}
              onClick={handleFlagClick}
            >
              {flagMut.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <UserX className="w-3.5 h-3.5" />}
              Flag as DNC
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
