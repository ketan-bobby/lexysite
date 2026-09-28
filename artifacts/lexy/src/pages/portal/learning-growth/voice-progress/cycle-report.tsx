import { useEffect } from "react";
import { useRoute, Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  RefreshCw,
  BarChart,
  ArrowUpRight,
  ArrowRight,
  ArrowDownRight,
  HelpCircle,
} from "lucide-react";
import { useGetLearningVoiceProgressReport } from "@/lib/use-learning-voice-progress";
import type { LearningVoiceProgressReportComparisonDimensionsItemObservedDifference } from "@workspace/api-client-react";

export default function VoiceProgressReport() {
  const [, params] = useRoute("/portal/learning-growth/voice-progress/:cycleId/report");
  const cycleId = params?.cycleId;

  const {
    data: report,
    isLoading,
    error,
    refetch,
  } = useGetLearningVoiceProgressReport(cycleId || "");

  useEffect(() => {
    document.title = "Growth Report | Lexy";
  }, []);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="mx-auto max-w-4xl space-y-8 py-8 animate-pulse">
          <Skeleton className="h-12 w-1/3" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppLayout>
    );
  }

  if (error || !report) {
    return (
      <AppLayout>
        <div className="mx-auto mt-8 max-w-3xl">
          <Button asChild variant="ghost" className="mb-4 -ml-4 text-muted-foreground">
            <Link href="/portal/learning-growth">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Learning & Growth
            </Link>
          </Button>
          <Card className="border-destructive/20">
            <CardHeader>
              <CardTitle>Unable to load report</CardTitle>
              <CardDescription>
                {error?.message || "We encountered an error loading this report."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => refetch()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  const { summary, comparison, recommendations } = report;

  return (
    <AppLayout>
      <div className="mx-auto max-w-4xl space-y-8 py-8 px-4 sm:px-6">
        <header>
          <Button asChild variant="ghost" className="mb-4 -ml-4 text-muted-foreground">
            <Link href="/portal/learning-growth">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Learning & Growth
            </Link>
          </Button>
          <h1 className="text-3xl font-bold tracking-tight">Voice Growth Report</h1>
          <p className="mt-2 text-muted-foreground max-w-2xl">
            This private report compares your conversational baseline with your later progress. It
            shows observed differences in your responses. We do not claim that training caused these
            differences, only that a difference was observed.
          </p>
        </header>

        {summary.state !== "completed" && (
          <Alert variant="destructive">
            <AlertTitle>Incomplete Cycle</AlertTitle>
            <AlertDescription>
              This cycle is not fully complete. The report may be partial or unavailable.
            </AlertDescription>
          </Alert>
        )}

        <Card className="border-primary/20 bg-card">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <BarChart className="w-5 h-5 text-primary" />
              <CardTitle className="text-xl">Observed Comparison</CardTitle>
            </div>
            {!comparison.comparable && (
              <CardDescription className="text-sm font-medium text-amber-600 mt-2 break-words whitespace-normal">
                Note: {comparison.reason}
              </CardDescription>
            )}
            {comparison.comparable && comparison.reason && (
              <CardDescription className="text-sm mt-2 break-words whitespace-normal">
                {comparison.reason}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            {comparison.dimensions.map((dim, idx) => (
              <div key={idx} className="p-4 rounded-xl border bg-muted/20">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-4 border-b pb-4">
                  <div className="min-w-0 max-w-full">
                    <h3 className="font-semibold text-lg break-words whitespace-normal">
                      {dim.dimension}
                    </h3>
                    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 mt-2">
                      <Badge
                        variant="outline"
                        className="font-normal text-muted-foreground whitespace-normal text-left h-auto py-1"
                      >
                        Baseline: {dim.baselineLevel}
                      </Badge>
                      <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0 hidden sm:block" />
                      <Badge
                        variant="secondary"
                        className="font-normal whitespace-normal text-left h-auto py-1"
                      >
                        Progress: {dim.progressLevel}
                      </Badge>
                    </div>
                  </div>
                  <DifferenceBadge diff={dim.observedDifference} />
                </div>

                {dim.evidence && dim.evidence.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Evidence
                    </h4>
                    <ul className="space-y-2">
                      {dim.evidence.map((ev, i) => (
                        <li
                          key={i}
                          className="text-sm text-foreground/90 pl-4 relative before:absolute before:left-0 before:top-2 before:w-1.5 before:h-1.5 before:rounded-full before:bg-primary/40 break-words whitespace-normal"
                        >
                          {ev}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {recommendations && recommendations.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Development Recommendations</CardTitle>
              <CardDescription>Suggested next steps for your personal growth plan.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {recommendations.map((rec, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <div className="mt-0.5 shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold text-[10px]">
                      {i + 1}
                    </div>
                    <span className="text-foreground/90 leading-relaxed break-words whitespace-normal flex-1 min-w-0">
                      {rec}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}

function DifferenceBadge({
  diff,
}: {
  diff: LearningVoiceProgressReportComparisonDimensionsItemObservedDifference;
}) {
  if (diff === "higher") {
    return (
      <Badge className="bg-signal-green/10 text-signal-green hover:bg-signal-green/20 border-signal-green/20 shrink-0 gap-1">
        <ArrowUpRight className="w-3.5 h-3.5" /> Higher
      </Badge>
    );
  }
  if (diff === "lower") {
    return (
      <Badge className="bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 border-amber-500/20 shrink-0 gap-1">
        <ArrowDownRight className="w-3.5 h-3.5" /> Lower
      </Badge>
    );
  }
  if (diff === "same") {
    return (
      <Badge variant="outline" className="text-muted-foreground shrink-0 gap-1">
        <ArrowRight className="w-3.5 h-3.5" /> Same
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-muted-foreground shrink-0 gap-1">
      <HelpCircle className="w-3.5 h-3.5" /> Not Comparable
    </Badge>
  );
}
