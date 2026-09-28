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
import { PlayCircle, RefreshCw, BarChart, Mic } from "lucide-react";
import { useLocation } from "wouter";
import {
  useGetLearningVoiceProgressHome,
  useStartLearningVoiceProgressCycle,
  useStartLearningVoiceProgress,
  useStartLearningVoiceTrainingReview,
  useVoiceProgressInvalidation,
} from "@/lib/use-learning-voice-progress";
import type { LearningVoiceProgressSummary } from "@workspace/api-client-react";

export function VoiceProgressHome() {
  const { data: home, isLoading, isError, refetch } = useGetLearningVoiceProgressHome();
  const start = useStartLearningVoiceProgressCycle();
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="space-y-4 mt-8 pt-8 border-t">
        <h3 className="font-semibold text-lg border-b pb-2 flex items-center gap-2">
          <Mic className="w-5 h-5 text-primary/70" /> Voice Progress Interview
        </h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError || !home) {
    return (
      <div className="space-y-4 mt-8 pt-8 border-t">
        <h3 className="font-semibold text-lg border-b pb-2 flex items-center gap-2">
          <Mic className="w-5 h-5 text-primary/70" /> Voice Progress Interview
        </h3>
        <Card className="border-destructive/20">
          <CardHeader>
            <CardTitle className="text-base text-destructive">
              Failed to load voice progress
            </CardTitle>
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

  if (home.cycles.length === 0 && (!home.eligibleCourses || home.eligibleCourses.length === 0)) {
    return null;
  }

  return (
    <div className="space-y-4 mt-8 pt-8 border-t">
      <div className="flex justify-between items-end border-b pb-4 mb-4">
        <div>
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <Mic className="w-5 h-5 text-primary/70" /> Voice Progress Interview
          </h3>
          <div className="text-sm text-muted-foreground mt-1 space-y-1">
            <p>
              A private, conversational cycle to measure your growth. Start with a baseline,
              complete related training, and return for a post-training interview.
            </p>
            <p>
              <strong>Note:</strong> We compare evidence from before and after training to show your
              honest progress. No percentages, pass/fail, or employer sharing.
            </p>
          </div>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {home.cycles.map((cycle) => (
          <CycleCard key={cycle.id} cycle={cycle} />
        ))}
        {home.eligibleCourses
          .filter((cid) => !home.cycles.some((c) => c.courseId === cid))
          .map((courseId) => (
            <UnlockedCycleCard
              key={courseId}
              courseId={courseId}
              onStart={() =>
                start.mutate(
                  { data: { courseId } },
                  {
                    onSuccess: (data) =>
                      navigate(`/portal/learning-growth/voice-progress/${data.summary.id}`),
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

function CycleCard({ cycle }: { cycle: LearningVoiceProgressSummary }) {
  const startProgress = useStartLearningVoiceProgress();
  const startReview = useStartLearningVoiceTrainingReview();
  const { invalidateHome, invalidateCycle } = useVoiceProgressInvalidation();
  const [, navigate] = useLocation();

  const isCompleted = cycle.state === "completed";
  const needsTraining = cycle.state === "training_required";
  const isStartReview = cycle.action === "start_training_review";
  const isContinueReview = cycle.action === "continue_training_review";

  const startProgressActive = needsTraining && cycle.action === "start_progress";

  return (
    <Card className="flex flex-col relative overflow-hidden transition-all hover:border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start gap-2">
          <CardTitle className="text-base font-semibold leading-tight">
            Voice Progress Cycle
          </CardTitle>
          {isCompleted ? (
            <Badge
              variant="secondary"
              className="bg-signal-green/10 text-signal-green hover:bg-signal-green/20 shrink-0"
            >
              Completed
            </Badge>
          ) : needsTraining ? (
            <Badge variant="outline" className="text-muted-foreground shrink-0 border-dashed">
              Training Required
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
          {cycle.reason || (
            <>
              {cycle.state === "baseline_draft" && "Start your structured baseline."}
              {cycle.state === "training_required" &&
                cycle.action === "review_training" &&
                "Review the course material to prepare for your progress interview."}
              {cycle.state === "training_required" &&
                cycle.action !== "review_training" &&
                "Baseline complete. Finish your course to unlock the final interview."}
              {cycle.state === "progress_draft" && "Ready for your post-training interview."}
              {cycle.state === "completed" && "Cycle completed. See your growth report."}
            </>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="pb-4 flex-1"></CardContent>

      <CardFooter className="pt-0">
        {isCompleted ? (
          <Button asChild variant="outline" className="w-full">
            <Link href={`/portal/learning-growth/voice-progress/${cycle.id}/report`}>
              <BarChart className="w-4 h-4 mr-2" /> Review Report
            </Link>
          </Button>
        ) : startProgressActive ? (
          <div className="w-full">
            {startProgress.error && (
              <p className="text-xs text-destructive text-center mb-2">
                {startProgress.error.message}
              </p>
            )}
            <Button
              onClick={() => {
                startProgress.mutate(
                  { cycleId: cycle.id, data: {} },
                  {
                    onSuccess: (data) => {
                      invalidateHome();
                      invalidateCycle(cycle.id);
                      navigate(`/portal/learning-growth/voice-progress/${data.summary.id}`);
                    },
                  },
                );
              }}
              disabled={startProgress.isPending}
              className="w-full group"
            >
              {startProgress.isPending ? (
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <PlayCircle className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />
              )}
              Start progress interview
            </Button>
          </div>
        ) : isStartReview || isContinueReview ? (
          <div className="w-full space-y-2">
            {startReview.error && (
              <p className="text-xs text-destructive text-center mb-2">
                {startReview.error.message}
              </p>
            )}
            {isStartReview ? (
              <Button
                onClick={() => {
                  startReview.mutate(
                    { cycleId: cycle.id, data: {} },
                    {
                      onSuccess: () => {
                        invalidateHome();
                        navigate(
                          `/portal/learning-growth/courses/${cycle.courseId}?voiceCycle=${cycle.id}`,
                        );
                      },
                    },
                  );
                }}
                disabled={startReview.isPending}
                className="w-full"
              >
                {startReview.isPending ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
                Start Course Review
              </Button>
            ) : (
              <Button asChild className="w-full">
                <Link
                  href={`/portal/learning-growth/courses/${cycle.courseId}?voiceCycle=${cycle.id}`}
                >
                  Continue Course Review ({cycle.reviewedCount}/{cycle.totalReviewLessons})
                </Link>
              </Button>
            )}
          </div>
        ) : needsTraining ? (
          <Button disabled variant="outline" className="w-full">
            {cycle.action === "complete_training" ? "Complete Course First" : "Training Required"}
          </Button>
        ) : (
          <Button asChild className="w-full group">
            <Link href={`/portal/learning-growth/voice-progress/${cycle.id}`}>
              <PlayCircle className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />
              {cycle.completedTurns > 0 ? "Resume Cycle" : "Start Cycle"}
            </Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function UnlockedCycleCard({
  onStart,
  starting,
}: {
  courseId: string;
  onStart: () => void;
  starting: boolean;
}) {
  return (
    <Card className="flex flex-col relative overflow-hidden transition-all border-primary/20 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start gap-2">
          <CardTitle className="text-base font-semibold leading-tight">New Voice Cycle</CardTitle>
          <Badge variant="outline" className="shrink-0 border-primary text-primary">
            Available
          </Badge>
        </div>
        <CardDescription className="text-xs mt-1">
          You have an eligible course. Start a voice cycle to track your conversational progress.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-4 flex-1" />
      <CardFooter className="pt-0">
        <Button onClick={onStart} disabled={starting} className="w-full group">
          {starting ? (
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <PlayCircle className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />
          )}
          Start Baseline
        </Button>
      </CardFooter>
    </Card>
  );
}
