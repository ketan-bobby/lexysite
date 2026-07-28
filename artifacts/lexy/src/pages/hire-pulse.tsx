/**
 * pages/hire-pulse.tsx — Quality-of-Hire Pulse (hiring manager)
 *
 * Landing page for the 30/90-day post-hire pulse email. The hiring manager
 * arrives via `/hire-pulse/:applicationId?phase=30` (or 90), answers three
 * 1–5 questions about how the hire is working out, and submits. The answers
 * feed `hire_quality_score` — the "did this hire actually work?" signal the
 * learning loop needs beyond a binary hired/not-hired label.
 *
 * Data:
 *   GET  /api/outcomes/:applicationId/pulse  — questions + current state
 *   PUT  /api/outcomes/:applicationId/pulse  — { phase, ratings[], comment? }
 */
import { authHeaders } from "@/lib/api";
import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@workspace/react-hooks/use-toast";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, Loader2, Star, ClipboardCheck } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type PulseData = {
  questions: string[];
  outcome: {
    applicationId: string;
    hireDate: string | null;
    hireQualityScore: number | null;
    pulse30RespondedAt: string | null;
    pulse90RespondedAt: string | null;
    pulseResponses: Record<string, { ratings: number[]; comment: string | null }> | null;
  };
};

function getPhase(): "30" | "90" {
  const p = new URLSearchParams(window.location.search).get("phase");
  return p === "90" ? "90" : "30";
}

function RatingRow({
  question, value, onChange,
}: { question: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{question}</p>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-md border transition-colors",
              value >= n
                ? "border-amber-400 bg-amber-50 text-amber-600"
                : "border-border bg-background text-muted-foreground hover:border-amber-300",
            )}
            aria-label={`${n} of 5`}
          >
            <Star className={cn("h-5 w-5", value >= n && "fill-amber-400")} />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function HirePulse() {
  const [, params] = useRoute("/hire-pulse/:applicationId");
  const applicationId = params?.applicationId ?? "";
  const phase = getPhase();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [ratings, setRatings] = useState<number[]>([0, 0, 0]);
  const [comment, setComment] = useState("");

  const { data, isLoading, error } = useQuery<PulseData>({
    queryKey: ["hire-pulse", applicationId],
    enabled: !!applicationId,
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/outcomes/${applicationId}/pulse`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to load");
      return res.json();
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/outcomes/${applicationId}/pulse`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          phase,
          ratings: ratings.map((r) => r || 1),
          comment: comment.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to submit");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hire-pulse", applicationId] });
      toast({ title: "Thank you", description: "Your feedback was recorded." });
    },
    onError: (e: any) => toast({ title: "Could not submit", description: e?.message ?? "Try again.", variant: "destructive" }),
  });

  const alreadyResponded = phase === "30"
    ? !!data?.outcome.pulse30RespondedAt
    : !!data?.outcome.pulse90RespondedAt;
  const questions = data?.questions ?? [];
  const allRated = ratings.slice(0, questions.length).every((r) => r >= 1);

  return (
    <AppLayout>
      <div className="mx-auto max-w-2xl py-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-primary" />
              {phase}-Day Quality-of-Hire Check-in
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {isLoading && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            )}

            {error && !isLoading && (
              <p className="text-sm text-destructive">
                {(error as Error).message || "This pulse is unavailable."}
              </p>
            )}

            {!isLoading && !error && (alreadyResponded || submit.isSuccess) && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                <p className="text-base font-medium">Thank you — your {phase}-day feedback is recorded.</p>
                <p className="text-sm text-muted-foreground">
                  This helps us measure quality of hire and improve who we surface for your future roles.
                </p>
              </div>
            )}

            {!isLoading && !error && !alreadyResponded && !submit.isSuccess && (
              <>
                <p className="text-sm text-muted-foreground">
                  It's been about {phase} days. A quick check-in (under a minute) helps us learn
                  what a great hire looks like for you.
                </p>
                {questions.map((q, i) => (
                  <RatingRow
                    key={i}
                    question={`${i + 1}. ${q}`}
                    value={ratings[i] ?? 0}
                    onChange={(n) => setRatings((prev) => prev.map((v, idx) => (idx === i ? n : v)))}
                  />
                ))}
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Anything else? (optional)</p>
                  <Textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Any context on how this hire is working out…"
                    maxLength={2000}
                    rows={3}
                  />
                </div>
                <Button onClick={() => submit.mutate()} disabled={!allRated || submit.isPending} className="w-full">
                  {submit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Submit feedback
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
