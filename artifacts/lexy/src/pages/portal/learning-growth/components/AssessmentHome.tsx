import { Link } from "wouter";
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
import { PlayCircle, RefreshCw, BarChart } from "lucide-react";
import {
  useGetLearningAssessments,
  useStartLearningAssessment,
  LearningAssessmentSummary,
} from "@/lib/use-learning-assessments";
import { useLocation } from "wouter";

export function AssessmentHome() {
  const { data: home, isLoading, isError, refetch } = useGetLearningAssessments();
  const start = useStartLearningAssessment();
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="space-y-4 mt-8 pt-8 border-t">
        <h3 className="font-semibold text-lg border-b pb-2">Progress Reassessment</h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError || !home) {
    return (
      <div className="space-y-4 mt-8 pt-8 border-t">
        <h3 className="font-semibold text-lg border-b pb-2">Progress Reassessment</h3>
        <Card className="border-destructive/20">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Failed to load assessments</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!home.available && home.unlockedCourses.length === 0) {
    return null; // hide entirely if no completed course options exist yet
  }

  return (
    <div className="space-y-4 mt-8 pt-8 border-t">
      <div className="flex justify-between items-end border-b pb-4 mb-4">
        <div>
          <h3 className="font-semibold text-lg">Progress Reassessment</h3>
          <div className="text-sm text-muted-foreground mt-1 space-y-1">
            <p>
              Completing a course unlocks its related assessment. This assesses only course-covered
              skills to show your progress.
            </p>
            <p>
              <strong>Note:</strong> There is no pass/fail, hiring score, readiness label or
              employer sharing. This is a private baseline for your own development.
            </p>
          </div>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {home.assessments.map((assessment) => (
          <AssessmentCard key={assessment.id} assessment={assessment} />
        ))}
        {home.unlockedCourses
          .filter((cid) => !home.assessments.some((a) => a.courseId === cid))
          .map((courseId) => (
            <UnlockedAssessmentCard
              key={courseId}
              courseId={courseId}
              onStart={() =>
                start.mutate(
                  { courseId },
                  {
                    onSuccess: (data) =>
                      navigate(`/portal/learning-growth/assessments/${data.summary.id}`),
                  },
                )
              }
              starting={start.isPending}
            />
          ))}
      </div>
    </div>
  );
}

function AssessmentCard({ assessment }: { assessment: LearningAssessmentSummary }) {
  const isCompleted = assessment.status === "completed";

  return (
    <Card className="flex flex-col relative overflow-hidden transition-all hover:border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start gap-2">
          <CardTitle className="text-base font-semibold leading-tight">
            {assessment.title}
          </CardTitle>
          {isCompleted ? (
            <Badge
              variant="secondary"
              className="bg-signal-green/10 text-signal-green hover:bg-signal-green/20 shrink-0"
            >
              Completed
            </Badge>
          ) : (
            <Badge
              variant="default"
              className="shrink-0 bg-primary/10 text-primary hover:bg-primary/20"
            >
              In Progress
            </Badge>
          )}
        </div>
        <CardDescription className="text-xs line-clamp-2 mt-1">
          {assessment.path === "voice" ? "Voice Track Assessment" : "Chat & Email Track Assessment"}
        </CardDescription>
      </CardHeader>

      <CardContent className="pb-4 flex-1">
        {!isCompleted && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground uppercase tracking-wider">
              <span>
                {assessment.completedTasks} of {assessment.totalTasks} tasks completed
              </span>
            </div>
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-500"
                style={{
                  width: `${Math.round(((assessment.completedTasks || 0) / (assessment.totalTasks || 1)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-0">
        {isCompleted ? (
          <Button asChild variant="outline" className="w-full">
            <Link href={`/portal/learning-growth/assessments/${assessment.id}/report`}>
              <BarChart className="w-4 h-4 mr-2" /> Review Report
            </Link>
          </Button>
        ) : (
          <Button asChild className="w-full group">
            <Link href={`/portal/learning-growth/assessments/${assessment.id}`}>
              <PlayCircle className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />
              {assessment.resumeTaskKey ? "Resume Assessment" : "Start Assessment"}
            </Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function UnlockedAssessmentCard({
  onStart,
  starting,
}: {
  courseId: string;
  onStart: () => void;
  starting: boolean;
}) {
  return (
    <Card className="flex flex-col relative overflow-hidden transition-all border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start gap-2">
          <CardTitle className="text-base font-semibold leading-tight">
            Assessment Unlocked
          </CardTitle>
          <Badge variant="outline" className="shrink-0">
            New
          </Badge>
        </div>
        <CardDescription className="text-xs mt-1">
          You have completed a course and can now assess your progress.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-4 flex-1">
        <p className="text-sm text-muted-foreground">Ready when you are.</p>
      </CardContent>
      <CardFooter className="pt-0">
        <Button onClick={onStart} disabled={starting} className="w-full group">
          {starting ? (
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <PlayCircle className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />
          )}
          Start Assessment
        </Button>
      </CardFooter>
    </Card>
  );
}
