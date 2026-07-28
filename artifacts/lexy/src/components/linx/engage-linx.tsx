/**
 * components/linx/engage-linx.tsx — client-side LINX engagement UI.
 *
 * LINX is a separate tenant that can be asked to help fill a role. Both
 * client entry points (work-order wizard + Market Intelligence) share the
 * form here so the fields stay identical: job (pre-filled or picked),
 * contact name + email, optional note.
 *
 * BOUNDARY: only job metadata + contact info ever leaves the client tenant.
 * No candidate data appears anywhere in this flow by design.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiBase, apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Handshake, Loader2 } from "lucide-react";

export interface LinxRequest {
  id: string;
  jobId: string;
  status: "pending" | "accepted" | "declined" | "filled" | "closed";
  contactName: string;
  contactEmail: string;
  note: string | null;
  declineReason: string | null;
  requestedAt: string;
}

/* Status → label + badge styling. Copy per spec. */
export function linxStatusLabel(r: Pick<LinxRequest, "status" | "declineReason">): string {
  switch (r.status) {
    case "pending": return "LINX request pending";
    case "accepted": return "LINX engaged";
    case "declined": return r.declineReason ? `LINX declined: ${r.declineReason}` : "LINX declined";
    case "filled": return "Filled by LINX";
    case "closed": return "Closed — not filled";
    default: return "";
  }
}

const STATUS_BADGE_CLASS: Record<LinxRequest["status"], string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  accepted: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  declined: "border-destructive/40 bg-destructive/10 text-destructive",
  filled: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  closed: "border-border bg-muted/40 text-muted-foreground",
};

/** Latest LINX request for a job (null when none). */
export function useLinxRequest(jobId: string | null | undefined) {
  return useQuery<{ request: LinxRequest | null }>({
    queryKey: ["/api/jobs", jobId, "linx-request"],
    enabled: Boolean(jobId),
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/jobs/${jobId}/linx-request`);
      if (!res.ok) throw new Error("Failed to load LINX status");
      return res.json();
    },
  });
}

/** Small status badge for anywhere the work order is shown. Renders nothing
 *  when the job has no LINX request. */
export function LinxStatusBadge({ jobId }: { jobId: string | null | undefined }) {
  const { data } = useLinxRequest(jobId);
  const r = data?.request;
  if (!r) return null;
  return (
    <Badge
      variant="outline"
      className={`gap-1 text-[11px] font-medium ${STATUS_BADGE_CLASS[r.status] ?? ""}`}
      data-testid={`badge-linx-status-${r.status}`}
      title={linxStatusLabel(r)}
    >
      <Handshake className="w-3 h-3" />
      {linxStatusLabel(r)}
    </Badge>
  );
}

/** POST the engagement request. Throws Error with a user-facing message. */
export async function createLinxRequest(payload: {
  jobId: string; contactName: string; contactEmail: string; note?: string;
}): Promise<LinxRequest> {
  const res = await apiFetch(`${apiBase}/linx-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Failed to send the LINX request");
  return data.request;
}

/**
 * The shared engagement dialog. Pass `jobId` to pre-fill the role (job-detail /
 * post-create surfaces); omit it to show a job picker (Market Intelligence).
 */
export function EngageLinxDialog({
  open, onClose, jobId, jobTitle,
}: {
  open: boolean;
  onClose: () => void;
  jobId?: string;
  jobTitle?: string;
}) {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [pickedJobId, setPickedJobId] = useState("");
  const [contactName, setContactName] = useState(user?.name || "");
  const [contactEmail, setContactEmail] = useState(user?.email || "");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const needsPicker = !jobId;
  const effectiveJobId = jobId || pickedJobId;

  /* Job picker source — only fetched when the picker is actually shown. */
  const { data: jobsData } = useQuery<any>({
    queryKey: ["/api/jobs", "linx-picker"],
    enabled: open && needsPicker,
    queryFn: () => apiFetch(`${apiBase}/jobs?limit=100`).then((r) => r.json()),
  });
  const jobs: any[] = Array.isArray(jobsData) ? jobsData : jobsData?.jobs ?? [];

  const reset = () => {
    setPickedJobId(""); setNote(""); setSubmitting(false);
    setContactName(user?.name || ""); setContactEmail(user?.email || "");
  };

  const submit = async () => {
    if (!effectiveJobId || !contactName.trim() || !contactEmail.trim()) return;
    setSubmitting(true);
    try {
      await createLinxRequest({
        jobId: effectiveJobId,
        contactName: contactName.trim(),
        contactEmail: contactEmail.trim(),
        note: note.trim() || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", effectiveJobId, "linx-request"] });
      toast({ title: "LINX request sent", description: "LINX will review the role and respond." });
      reset();
      onClose();
    } catch (e: any) {
      toast({ title: "Couldn't send LINX request", description: e?.message, variant: "destructive" });
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Handshake className="w-4 h-4" />
            </div>
            Engage LINX
          </DialogTitle>
          <DialogDescription>
            Ask LINX to help fill this role. Only the role details and your
            contact info are shared — never candidate data.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {needsPicker ? (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Role</Label>
              <Select value={pickedJobId} onValueChange={setPickedJobId}>
                <SelectTrigger data-testid="select-linx-job">
                  <SelectValue placeholder="Select a work order" />
                </SelectTrigger>
                <SelectContent>
                  {jobs.map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.title}{j.workOrderNumber ? ` · ${j.workOrderNumber}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Role: </span>
              <span className="font-medium">{jobTitle || "This work order"}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Contact name</Label>
              <Input value={contactName} onChange={(e) => setContactName(e.target.value)} data-testid="input-linx-contact-name" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Contact email</Label>
              <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} data-testid="input-linx-contact-email" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Note to LINX <span className="text-muted-foreground font-normal">· optional</span></Label>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything LINX should know about this role…" data-testid="input-linx-note" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
            <Button
              type="button"
              onClick={submit}
              disabled={submitting || !effectiveJobId || !contactName.trim() || !contactEmail.trim()}
              className="gap-2"
              data-testid="button-send-linx-request"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Send request to LINX
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
