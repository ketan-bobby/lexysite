/**
 * OverrideDialog.tsx — Recruiter manual decision override modal.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Opens a modal that lets a recruiter override the AI's recommendation for a
 * candidate×job pair.  The recruiter selects an action (Advance, Schedule
 * Interview, Review, Re-engage, Verify Identity, Reject, Hold), picks a reason
 * category, and adds an optional free-text rationale.  On submit the override is
 * written to the intelligence record and the change is audit-logged.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  VALID_ACTIONS[]      Action options with colour tokens
 *  REASON_CATEGORIES[]  Structured reason list for the dropdown
 *  <OverrideDialog>     Root: controlled dialog, form state, submit mutation
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  POST /api/intelligence/:candidateId/:jobId/override
 *       Body: { action, reasonCategory, rationale }
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  components/intelligence/CandidateIntelligenceCard.tsx   "Override" button
 *  pages/recruiter/decision-queue.tsx                      Decision queue rows
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiBase } from "@/lib/api";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, UserCheck, Loader2, ThumbsUp, ThumbsDown } from "lucide-react";
import { cn } from "@/lib/utils";

const VALID_ACTIONS = [
  { value: "advance",             label: "Advance",             color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  { value: "schedule",            label: "Schedule Interview",  color: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30" },
  { value: "recruiter_review",    label: "Review",              color: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  { value: "re_engage",           label: "Re-engage",           color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  { value: "manual_verification", label: "Verify Identity",     color: "bg-violet-500/15 text-violet-400 border-violet-500/30" },
  { value: "reject",              label: "Reject",              color: "bg-rose-500/15 text-rose-400 border-rose-500/30" },
  { value: "hold",                label: "Hold",                color: "bg-slate-500/15 text-slate-400 border-slate-500/30" },
] as const;

const REASON_CATEGORIES = [
  { value: "data_inaccuracy",       label: "Data inaccuracy — AI used incorrect or outdated information" },
  { value: "client_preference",     label: "Client or hiring manager preference" },
  { value: "prior_relationship",    label: "Prior relationship or referral context" },
  { value: "timeline_change",       label: "Hiring timeline has changed" },
  { value: "risk_acceptable",       label: "Risk is acceptable given the context" },
  { value: "better_candidate",      label: "Better candidate available in pipeline" },
  { value: "human_judgement",       label: "Human judgement overrides model signal" },
  { value: "other",                 label: "Other" },
];

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId: string;
  candidateId: string;
  currentDecision: string;
  candidateName?: string;
  onSuccess?: () => void;
}

export function OverrideDialog({ open, onOpenChange, jobId, candidateId, currentDecision, candidateName, onSuccess }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [reasonCategory, setReasonCategory] = useState<string>("");
  const [reasonDetail, setReasonDetail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<"positive" | "negative" | null>(null);

  const combinedReason = reasonCategory
    ? `[${REASON_CATEGORIES.find(r => r.value === reasonCategory)?.label ?? reasonCategory}]${reasonDetail ? " — " + reasonDetail : ""}`
    : reasonDetail;

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`${apiBase}/intelligence/${jobId}/${candidateId}/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalDecision: currentDecision,
          recruiterDecision: selected,
          recruiterReason: combinedReason,
          reasonDetail: reasonDetail.trim(),
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Failed to record override");
      }
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ["intelligence"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to record override", description: err.message, variant: "destructive" });
    },
  });

  const handleFeedback = async (rating: "positive" | "negative") => {
    setFeedbackRating(rating);
    try {
      await apiFetch(`${apiBase}/intelligence/${jobId}/${candidateId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
    } catch { /* silent */ }
    toast({
      title: "Override recorded",
      description: `Decision changed to "${VALID_ACTIONS.find(a => a.value === selected)?.label}" and logged for learning.`,
    });
    onOpenChange(false);
    setSubmitted(false);
    setSelected(null);
    setReasonCategory("");
    setReasonDetail("");
    setFeedbackRating(null);
    onSuccess?.();
  };

  const originalConfig = VALID_ACTIONS.find(a => a.value === currentDecision);
  const isValid = !!selected && !!reasonCategory && reasonDetail.trim().length >= 10;

  /* ── Submitted state — ask for feedback ── */
  if (submitted) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center">Override Recorded</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              Was the original AI recommendation helpful, even if you disagreed with it?
            </p>
            <div className="flex gap-3 justify-center">
              <Button
                variant="outline"
                className="gap-2 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                onClick={() => handleFeedback("positive")}
              >
                <ThumbsUp className="w-4 h-4" /> Yes, helpful
              </Button>
              <Button
                variant="outline"
                className="gap-2 text-rose-400 border-rose-500/30 hover:bg-rose-500/10"
                onClick={() => handleFeedback("negative")}
              >
                <ThumbsDown className="w-4 h-4" /> Not useful
              </Button>
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline"
              onClick={() => handleFeedback("positive")}
            >
              Skip feedback
            </button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-primary" />
            Override AI Recommendation
          </DialogTitle>
          <DialogDescription>
            {candidateName && <span>Recording your decision for <strong>{candidateName}</strong>. </span>}
            This override is logged and improves future recommendations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* AI recommendation */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">AI recommended</p>
              {originalConfig ? (
                <Badge variant="outline" className={cn("text-xs mt-0.5", originalConfig.color)}>
                  {originalConfig.label}
                </Badge>
              ) : (
                <span className="text-sm font-medium capitalize">{currentDecision.replace(/_/g, " ")}</span>
              )}
            </div>
          </div>

          {/* Your decision */}
          <div className="space-y-2">
            <Label className="text-sm">Your decision <span className="text-destructive">*</span></Label>
            <div className="grid grid-cols-2 gap-2">
              {VALID_ACTIONS.map(action => (
                <button
                  key={action.value}
                  type="button"
                  onClick={() => setSelected(action.value)}
                  disabled={action.value === currentDecision}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium text-left transition-all",
                    action.value === currentDecision && "opacity-30 cursor-not-allowed",
                    selected === action.value
                      ? cn("ring-2 ring-primary ring-offset-1 ring-offset-background", action.color)
                      : "border-border/50 hover:border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>

          {/* Reason category */}
          <div className="space-y-2">
            <Label className="text-sm">Override reason <span className="text-destructive">*</span></Label>
            <Select value={reasonCategory} onValueChange={setReasonCategory}>
              <SelectTrigger className="text-sm h-9">
                <SelectValue placeholder="Select a reason category…" />
              </SelectTrigger>
              <SelectContent>
                {REASON_CATEGORIES.map(r => (
                  <SelectItem key={r.value} value={r.value} className="text-xs">
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Rationale — mandatory (EU AI Act Art. 14 human-oversight audit trail) */}
          <div className="space-y-2">
            <Label htmlFor="override-detail" className="text-sm">Your rationale <span className="text-destructive">*</span></Label>
            <Textarea
              id="override-detail"
              placeholder="In your own words, why are you making this decision? (required — this becomes part of the audit trail)"
              value={reasonDetail}
              onChange={e => setReasonDetail(e.target.value)}
              className="resize-none h-20 text-sm"
            />
            {reasonDetail.trim().length > 0 && reasonDetail.trim().length < 10 && (
              <p className="text-xs text-muted-foreground">Please write at least a short sentence (10+ characters).</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!isValid || mutation.isPending}>
            {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Record Override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
