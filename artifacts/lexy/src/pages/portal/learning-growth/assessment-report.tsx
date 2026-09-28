import { useEffect } from "react";
import { useRoute, Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  ArrowLeft,
  RefreshCw,
  BarChart,
  BookOpen,
  Info,
  TrendingUp,
  Compass,
  Target,
  ExternalLink,
} from "lucide-react";
import {
  useGetLearningAssessmentReport,
  LearningAssessmentDimension,
} from "@/lib/use-learning-assessments";

export default function AssessmentReport() {
  const [, params] = useRoute("/portal/learning-growth/assessments/:assessmentId/report");
  const assessmentId = params?.assessmentId;
  const {
    data: report,
    isLoading,
    error,
    refetch,
  } = useGetLearningAssessmentReport(assessmentId || "");

  useEffect(() => {
    document.title = `Assessment Report | Lexy`;
  }, []);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="mx-auto max-w-5xl space-y-8 py-8 animate-pulse">
          <Skeleton className="h-12 w-1/3" />
          <Skeleton className="h-48 w-full" />
          <div className="grid md:grid-cols-2 gap-6">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!report || !assessmentId) {
    return (
      <AppLayout>
        <div className="mx-auto mt-8 max-w-3xl">
          <Button asChild variant="ghost" className="mb-4 -ml-4 text-muted-foreground">
            <Link href="/portal/learning-growth">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Learning & Growth
            </Link>
          </Button>
          <Card className="border-primary/20">
            <CardHeader>
              <CardTitle>Unable to load report</CardTitle>
              <CardDescription>
                {error?.message || "We encountered an error loading this report."}
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button variant="outline" onClick={() => refetch()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </CardFooter>
          </Card>
        </div>
      </AppLayout>
    );
  }

  const { summary, overallSummary, comparison, dimensions, recommendations } = report;

  return (
    <AppLayout>
      <div className="mx-auto max-w-5xl space-y-8 py-8 px-4 sm:px-6">
        <div>
          <Button asChild variant="ghost" className="mb-4 -ml-4 text-muted-foreground">
            <Link href="/portal/learning-growth">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Learning & Growth
            </Link>
          </Button>
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
            Private Reassessment
          </p>
          <h1 className="text-3xl font-bold tracking-tight">Your Progress Report</h1>
          <p className="mt-4 text-lg text-muted-foreground">
            This report summarizes the skills you demonstrated in your recent practice assessment.
          </p>
        </div>

        <Alert className="bg-primary/5 border-primary/20">
          <Info className="h-4 w-4 text-primary" />
          <AlertTitle className="text-primary font-semibold">
            Developmental Baseline Only
          </AlertTitle>
          <AlertDescription className="text-foreground/90 mt-1 space-y-2">
            <p>
              This report identifies currently observed evidence for skills covered in your course (
              {summary.path === "voice" ? "Voice Track" : "Chat & Email Track"}).
            </p>
            <p>
              <strong>This is not a hiring score.</strong> It is not shared with employers, and
              there is no pass/fail grade. The observation levels describe the consistency of
              evidence in this specific session, not your overall professional proficiency.
            </p>
          </AlertDescription>
        </Alert>

        {/* Overall Summary */}
        <Card className="border-primary/10 shadow-md">
          <CardHeader className="bg-muted/30 border-b pb-4">
            <CardTitle className="text-xl flex items-center gap-2">
              <BarChart className="w-5 h-5 text-primary" /> Overall Observation
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <p className="text-base leading-relaxed text-foreground/90">{overallSummary}</p>

            {/* Comparison Logic */}
            <div className="mt-6 pt-6 border-t border-dashed">
              <h4 className="font-semibold text-sm mb-2 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-muted-foreground" /> Progress Comparison
              </h4>
              {comparison.available ? (
                <p className="text-sm text-muted-foreground">
                  Comparisons with previous assessments will appear here.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {comparison.reason ||
                    "Comparison unavailable. Since this is your first structured assessment for this course, there is no previous baseline to compare against."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Dimensions */}
        <div>
          <h3 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Compass className="w-6 h-6 text-primary" /> Skill Dimensions
          </h3>
          <div className="grid md:grid-cols-2 gap-6">
            {dimensions.map((dim, i) => (
              <DimensionCard key={i} dimension={dim} />
            ))}
          </div>
        </div>

        {/* Recommendations */}
        {recommendations.length > 0 && (
          <div className="mt-12 pt-8 border-t">
            <h3 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <Target className="w-6 h-6 text-primary" /> Recommended Review
            </h3>
            <p className="text-muted-foreground mb-6">
              Based on your recent assessment, revisiting these lessons may help reinforce your
              skills.
            </p>

            <div className="grid sm:grid-cols-2 gap-4">
              {recommendations.map((rec, i) => (
                <Card key={i} className="flex flex-col hover:border-primary/30 transition-colors">
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2 text-primary mb-2">
                      <BookOpen className="w-4 h-4" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider">
                        Lesson Review
                      </span>
                    </div>
                    <CardTitle className="text-base">{rec.lessonTitle}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1 pb-4">
                    <p className="text-sm text-muted-foreground">{rec.reason}</p>
                  </CardContent>
                  <CardFooter className="pt-0">
                    <Button
                      asChild
                      variant="outline"
                      className="w-full text-primary hover:bg-primary/5 group"
                    >
                      <Link href={`/portal/learning-growth/courses/${rec.courseId}`}>
                        Open Course{" "}
                        <ExternalLink className="w-3.5 h-3.5 ml-2 group-hover:scale-110 transition-transform" />
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function DimensionCard({ dimension }: { dimension: LearningAssessmentDimension }) {
  const getLevelColor = (level: string) => {
    switch (level) {
      case "consistent":
        return "bg-signal-green/15 text-signal-green border-signal-green/20";
      case "developing":
        return "bg-primary/10 text-primary border-primary/20";
      case "emerging":
        return "bg-signal-amber/15 text-signal-amber border-signal-amber/20";
      case "not_observed":
      default:
        return "bg-muted text-muted-foreground border-transparent";
    }
  };

  return (
    <Card className="flex flex-col h-full overflow-hidden border-border/60">
      <div
        className={`h-1.5 w-full ${dimension.level === "consistent" ? "bg-signal-green" : dimension.level === "developing" ? "bg-primary" : dimension.level === "emerging" ? "bg-signal-amber" : "bg-muted"}`}
      />
      <CardHeader className="pb-3 border-b bg-muted/10">
        <div className="flex justify-between items-start gap-4">
          <CardTitle className="text-lg leading-tight">{dimension.label}</CardTitle>
          <Badge
            variant="outline"
            className={`shrink-0 capitalize ${getLevelColor(dimension.level)}`}
          >
            {dimension.level.replace(/_/g, " ")}
          </Badge>
        </div>
        <CardDescription className="text-xs text-foreground/80 font-medium mt-2">
          {dimension.levelLabel}
        </CardDescription>
      </CardHeader>

      <CardContent className="pt-4 flex-1 flex flex-col">
        <div className="flex-1 space-y-4">
          <div>
            <h5 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">
              Observed Evidence
            </h5>
            <ul className="space-y-2">
              {dimension.evidence.length > 0 ? (
                dimension.evidence.map((ev: string, i: number) => (
                  <li key={i} className="text-sm flex items-start gap-2">
                    <span className="text-primary mt-1">•</span>
                    <span className="text-foreground/90">{ev}</span>
                  </li>
                ))
              ) : (
                <li className="text-sm text-muted-foreground italic">
                  No specific evidence observed for this dimension in the current tasks.
                </li>
              )}
            </ul>
          </div>
        </div>

        {dimension.observed !== undefined && dimension.possible !== undefined && (
          <div className="mt-6 pt-4 border-t border-dashed flex justify-between items-center text-xs text-muted-foreground">
            <span>Evidence Frequency</span>
            <span className="font-medium bg-muted/50 px-2 py-1 rounded-md">
              {dimension.observed} of {dimension.possible} opportunities
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
