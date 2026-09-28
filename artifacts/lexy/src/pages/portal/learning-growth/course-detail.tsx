import { useEffect, useRef, useState, useCallback } from "react";
import { useRoute, useLocation, Link, useSearch } from "wouter";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  ChevronRight,
  RefreshCw,
  MessageSquare,
  Mic,
  AlertTriangle,
  BookOpen,
} from "lucide-react";
import {
  useGetLearningCourse,
  useEnrollLearningCourse,
  useSubmitLearningLesson,
  LearningCourseLesson,
  LearningCoursePath,
} from "@/lib/use-learning-courses";
import {
  useGetLearningVoiceTrainingReview,
  getGetLearningVoiceTrainingReviewQueryKey,
  useReviewLearningVoiceTrainingLesson,
  useVoiceProgressInvalidation,
} from "@/lib/use-learning-voice-progress";
import { useLearningAchievementsInvalidation } from "@/lib/use-learning-achievements";

export default function CourseDetail() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/portal/learning-growth/courses/:courseId");
  const searchString = useSearch();
  const voiceCycle = new URLSearchParams(searchString).get("voiceCycle");
  const courseId = params?.courseId;
  const { data: detail, isLoading, error, refetch } = useGetLearningCourse(courseId || "");
  const enroll = useEnrollLearningCourse(courseId || "");

  const { data: reviewAttempt, isLoading: reviewLoading } = useGetLearningVoiceTrainingReview(
    voiceCycle || "",
    {
      query: {
        enabled: !!voiceCycle,
        queryKey: getGetLearningVoiceTrainingReviewQueryKey(voiceCycle || ""),
      },
    },
  );
  const [selectedPath, setSelectedPath] = useState<LearningCoursePath>("chat_email");
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const busy = isPending || enroll.isPending;
  useEffect(() => {
    document.title = `${detail?.course.title ?? "Learning course"} | Lexy`;
  }, [detail?.course.title]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty && !busy) return;
      event.preventDefault();
      event.returnValue = "";
    };
    // Covers shell navigation as well as this page's Back link.
    const guardLink = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!anchor || (!isDirty && !busy)) return;
      if (busy || !window.confirm("You have unsaved changes in this lesson. Discard them?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLink, true);
    };
  }, [isDirty, busy]);

  useEffect(() => {
    if (
      detail &&
      detail.course.enrollment &&
      (!activeLessonId || !detail.lessons.some((lesson) => lesson.id === activeLessonId))
    ) {
      setActiveLessonId(detail.course.enrollment.resumeLessonId || detail.lessons[0]?.id);
    }
  }, [detail, activeLessonId]);

  if (isLoading || (!!voiceCycle && reviewLoading)) {
    return (
      <AppLayout>
        <div className="mx-auto max-w-5xl space-y-8 py-8 animate-pulse">
          <Skeleton className="h-12 w-1/3" />
          <div className="flex gap-8">
            <Skeleton className="h-96 w-64 shrink-0" />
            <Skeleton className="h-[600px] flex-1" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!detail || !courseId) {
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
              <CardTitle>Unable to load course details</CardTitle>
              <CardDescription>
                {error?.message || "We encountered an error loading this course."}
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

  const { course, lessons } = detail;
  const isEnrolled = !!course.enrollment;

  if (!isEnrolled) {
    return (
      <AppLayout>
        <div className="mx-auto max-w-3xl space-y-8 py-8">
          <div>
            <Button asChild variant="ghost" className="mb-4 -ml-4 text-muted-foreground">
              <Link href="/portal/learning-growth">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to Learning & Growth
              </Link>
            </Button>
            <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
              Course Pilot
            </p>
            <h1 className="text-3xl font-bold tracking-tight">{course.title}</h1>
            <p className="mt-4 text-lg text-muted-foreground">{course.description}</p>
          </div>

          <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
            <CardHeader>
              <CardTitle>Choose your track</CardTitle>
              <CardDescription>
                Select the communication channel you want to practice. This course is for private
                practice and is not an assessment or hiring qualification. Your track is fixed after
                enrolment in this pilot.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                value={selectedPath}
                disabled={enroll.isPending}
                onValueChange={(val) => setSelectedPath(val as LearningCoursePath)}
                className={`space-y-4 ${enroll.isPending ? "pointer-events-none opacity-60" : ""}`}
              >
                <div
                  className={`flex items-center space-x-2 border rounded-lg p-4 cursor-pointer transition-colors ${selectedPath === "chat_email" ? "border-primary bg-primary/5" : "hover:border-primary/30"}`}
                  onClick={() => setSelectedPath("chat_email")}
                >
                  <RadioGroupItem value="chat_email" id="chat_email" />
                  <Label htmlFor="chat_email" className="flex-1 cursor-pointer">
                    <div className="flex items-center gap-2 font-semibold">
                      <MessageSquare className="w-4 h-4 text-primary" /> Chat & Email
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 font-normal">
                      Practice written communication scenarios with text-based exercises.
                    </p>
                  </Label>
                </div>
                <div
                  className={`flex items-center space-x-2 border rounded-lg p-4 cursor-pointer transition-colors ${selectedPath === "voice" ? "border-primary bg-primary/5" : "hover:border-primary/30"}`}
                  onClick={() => setSelectedPath("voice")}
                >
                  <RadioGroupItem value="voice" id="voice" />
                  <Label htmlFor="voice" className="flex-1 cursor-pointer">
                    <div className="flex items-center gap-2 font-semibold">
                      <Mic className="w-4 h-4 text-primary" /> Voice
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 font-normal">
                      Practice speaking aloud followed by written reflection. (No audio recording
                      required)
                    </p>
                  </Label>
                </div>
              </RadioGroup>
              {enroll.error && (
                <div className="mt-4 text-sm text-destructive flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{enroll.error.message}</span>
                </div>
              )}
            </CardContent>
            <CardFooter>
              <Button
                onClick={() => enroll.mutate({ path: selectedPath })}
                disabled={enroll.isPending}
                className="w-full sm:w-auto"
              >
                {enroll.isPending && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />}
                Enroll & Start Practice
              </Button>
            </CardFooter>
          </Card>
        </div>
      </AppLayout>
    );
  }

  const activeLesson = lessons.find((l: any) => l.id === activeLessonId) || lessons[0];

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl space-y-6 py-8 px-4 sm:px-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <Button asChild variant="ghost" className="mb-2 -ml-4 text-muted-foreground">
              <Link href="/portal/learning-growth">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to Learning & Growth
              </Link>
            </Button>
            <h1 className="text-2xl font-bold tracking-tight">{course.title}</h1>
            <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
              <Badge variant="outline" className="bg-primary/5">
                {course.enrollment?.path === "voice" ? "Voice Track" : "Chat & Email Track"}
              </Badge>
              <span>
                {course.enrollment?.completedLessons} of {course.enrollment?.totalLessons} completed
              </span>
            </div>
          </div>
        </div>

        {error && (
          <Alert>
            <AlertTitle>Could not refresh this course</AlertTitle>
            <AlertDescription>
              {error.message} Your current answers are still here.{" "}
              <button className="underline" onClick={() => refetch()}>
                Retry
              </button>
            </AlertDescription>
          </Alert>
        )}
        {course.enrollment?.status === "completed" && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Course practice completed</AlertTitle>
            <AlertDescription>
              Your completed lessons are saved for private review. This is not a proficiency
              assessment or hiring qualification.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col md:flex-row gap-8 items-start">
          {/* Sidebar */}
          <div className="w-full md:w-64 shrink-0 space-y-2 md:sticky md:top-24">
            <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-4">
              Lessons
            </h3>
            {lessons.map((lesson) => {
              const isCompleted = lesson.progress?.status === "completed";
              const isActive = activeLessonId === lesson.id;

              return (
                <button
                  key={lesson.id}
                  disabled={isPending}
                  onClick={() => {
                    if (isActive || isPending) return;
                    if (
                      isDirty &&
                      !window.confirm("You have unsaved changes in this lesson. Discard them?")
                    )
                      return;
                    setIsDirty(false);
                    setActiveLessonId(lesson.id);
                  }}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : isPending
                        ? "opacity-50 cursor-not-allowed hover:bg-transparent"
                        : "hover:bg-muted/50"
                  }`}
                >
                  {isCompleted ? (
                    <CheckCircle2
                      className={`w-5 h-5 shrink-0 ${isActive ? "text-primary-foreground" : "text-signal-green"}`}
                    />
                  ) : (
                    <Circle
                      className={`w-5 h-5 shrink-0 ${isActive ? "text-primary-foreground" : "text-muted-foreground"}`}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-sm font-medium truncate ${isActive ? "text-primary-foreground" : "text-foreground"}`}
                    >
                      {lesson.title}
                    </p>
                    <p
                      className={`text-[10px] ${isActive ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                    >
                      {lesson.estimatedMinutes} mins
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Main Content */}
          <div className="flex-1 min-w-0 bg-card border rounded-xl shadow-sm overflow-hidden">
            {activeLesson && (
              <LessonContent
                key={`${courseId}:${activeLesson.id}`}
                courseId={courseId}
                lesson={activeLesson}
                onAdvance={() => {
                  const currentIndex = lessons.findIndex((l) => l.id === activeLesson.id);
                  if (currentIndex < lessons.length - 1) {
                    setActiveLessonId(lessons[currentIndex + 1].id);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  } else {
                    navigate("/portal/learning-growth");
                  }
                }}
                onDirtyChange={setIsDirty}
                onPendingChange={setIsPending}
                voiceCycle={voiceCycle}
                reviewAttempt={reviewAttempt}
              />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function LessonContent({
  courseId,
  lesson,
  onAdvance,
  onDirtyChange,
  onPendingChange,
  voiceCycle,
  reviewAttempt,
}: {
  courseId: string;
  lesson: LearningCourseLesson;
  onAdvance: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  voiceCycle: string | null;
  reviewAttempt: any;
}) {
  const [, navigate] = useLocation();
  const submit = useSubmitLearningLesson(courseId, lesson.id);
  const reviewLesson = useReviewLearningVoiceTrainingLesson();
  const { invalidateHome, invalidateReview } = useVoiceProgressInvalidation();
  const { invalidateAchievements } = useLearningAchievementsInvalidation();
  const { refetch } = useGetLearningCourse(courseId);
  // Pin completion and feedback too, so another tab cannot lock a local draft.
  const [progress, setProgress] = useState(lesson.progress);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const isCompleted = progress?.status === "completed";

  // Track answers and revision tied to the loaded progress
  const [answers, setAnswers] = useState<Record<string, string>>(progress?.answers || {});
  const currentRevision = useRef<number>(progress?.revision ?? 0);
  const initialAnswers = useRef<Record<string, string>>(progress?.answers || {});
  const dirty = JSON.stringify(answers) !== JSON.stringify(initialAnswers.current);
  const blocked = submit.isPending || reloading;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onPendingChange(blocked);
  }, [blocked, onPendingChange]);

  const reloadLatest = async () => {
    setReloading(true);
    setReloadError("");
    try {
      const result = await refetch();
      const latest = result.data?.lessons.find((item) => item.id === lesson.id)?.progress;
      if (result.error || !latest) {
        setReloadError(
          result.error?.message ?? "Could not reload this lesson. Your draft is still here.",
        );
        return;
      }
      currentRevision.current = latest.revision;
      initialAnswers.current = latest.answers;
      setAnswers(latest.answers);
      setProgress(latest);
      onDirtyChange(false);
      submit.reset();
    } finally {
      setReloading(false);
    }
  };

  const handleSaveDraft = useCallback(() => {
    if (isCompleted || blocked) return;
    submit.mutate(
      {
        revision: currentRevision.current,
        answers,
        action: "save_draft",
      },
      {
        onSuccess: (data) => {
          // Update our local revision to the newly saved one from the server response
          const updatedLesson = data.lessons.find((l: any) => l.id === lesson.id);
          if (updatedLesson?.progress) {
            currentRevision.current = updatedLesson.progress.revision;
            initialAnswers.current = updatedLesson.progress.answers;
            setAnswers(updatedLesson.progress.answers);
            setProgress(updatedLesson.progress);
            onDirtyChange(false);
          }
        },
      },
    );
  }, [answers, isCompleted, blocked, submit, lesson.id, onDirtyChange]);

  const handleSubmit = useCallback(() => {
    if (isCompleted || blocked) return;
    submit.mutate(
      {
        revision: currentRevision.current,
        answers,
        action: "submit",
      },
      {
        onSuccess: (data) => {
          const updatedLesson = data.lessons.find((l: any) => l.id === lesson.id);
          if (updatedLesson?.progress) {
            currentRevision.current = updatedLesson.progress.revision;
            initialAnswers.current = updatedLesson.progress.answers;
            setAnswers(updatedLesson.progress.answers);
            setProgress(updatedLesson.progress);
            onDirtyChange(false);
          }
        },
      },
    );
  }, [answers, isCompleted, blocked, submit, lesson.id, onDirtyChange]);

  const hasConflict = submit.error?.message?.includes("newer version");

  return (
    <div className="flex flex-col h-full animate-in fade-in duration-300">
      <div className="p-6 md:p-8 border-b bg-muted/20">
        <div className="flex items-center gap-2 text-primary mb-3">
          <BookOpen className="w-4 h-4" />
          <span className="text-xs font-semibold uppercase tracking-wider">Lesson Content</span>
        </div>
        <h2 className="text-2xl font-bold mb-4">{lesson.title}</h2>

        {lesson.objectives?.length > 0 && (
          <div className="bg-background border rounded-lg p-4 mt-6">
            <h4 className="font-semibold text-sm mb-2">Learning Objectives</h4>
            <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
              {lesson.objectives.map((obj, i) => (
                <li key={i}>{obj}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="p-6 md:p-8 space-y-10">
        {/* Sections */}
        {lesson.sections?.map((section, i) => (
          <section key={i} className="prose prose-sm md:prose-base dark:prose-invert max-w-none">
            <h3 className="text-xl font-semibold mb-3 text-foreground">{section.heading}</h3>
            <div className="text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {section.body}
            </div>
          </section>
        ))}

        {/* Worked Example */}
        {lesson.example && (
          <section>
            <h3 className="text-xl font-semibold mb-4">Worked Example</h3>
            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="p-6 space-y-4">
                <div>
                  <h4 className="font-semibold text-sm text-primary uppercase tracking-wider mb-1">
                    Scenario
                  </h4>
                  <p className="text-sm">{lesson.example.scenario}</p>
                </div>
                <div className="pl-4 border-l-2 border-primary/30">
                  <h4 className="font-semibold text-sm text-primary uppercase tracking-wider mb-1">
                    Response
                  </h4>
                  <p className="text-sm italic">"{lesson.example.response}"</p>
                </div>
                <div>
                  <h4 className="font-semibold text-sm text-primary uppercase tracking-wider mb-1">
                    Why it works
                  </h4>
                  <p className="text-sm text-muted-foreground">{lesson.example.whyItWorks}</p>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        <div className="space-y-8">
          <p className="text-sm text-muted-foreground">
            Save a draft whenever you need a break. Uncompleted exercises have unlimited, free
            retries. Completed responses are saved read-only for review; completion does not assess
            proficiency.
          </p>

          {hasConflict && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Conflict Detected</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                A newer version of this draft was saved on another device.
                <Button
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  onClick={reloadLatest}
                  className="w-fit bg-background text-foreground"
                >
                  Discard my edits & reload
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {reloadError && (
            <p role="alert" className="text-destructive">
              {reloadError}
            </p>
          )}

          {submit.error && !hasConflict && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{submit.error.message}</AlertDescription>
            </Alert>
          )}

          {voiceCycle && (
            <div className="space-y-4 pt-6 border-t mt-8">
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-6">
                <h3 className="text-lg font-semibold flex items-center gap-2 mb-2">
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                  Course Review
                </h3>
                <p className="text-sm text-muted-foreground mb-6">
                  You are reviewing this course after your voice baseline. Please carefully review
                  the material above. Once you're finished, mark this lesson as reviewed to proceed.
                </p>

                {reviewLesson.error && (
                  <Alert variant="destructive" className="mb-4">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{reviewLesson.error.message}</AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="text-sm font-medium">
                    {reviewAttempt?.lessons?.find((l: any) => l.id === lesson.id)?.reviewedAt ? (
                      <span className="flex items-center gap-1 text-signal-green">
                        <CheckCircle2 className="w-4 h-4" /> Reviewed
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Review pending</span>
                    )}
                  </div>

                  {!reviewAttempt?.lessons?.find((l: any) => l.id === lesson.id)?.reviewedAt ? (
                    <Button
                      onClick={() => {
                        reviewLesson.mutate(
                          { cycleId: voiceCycle, lessonId: lesson.id, data: {} },
                          {
                            onSuccess: (data) => {
                              invalidateReview(voiceCycle);
                              invalidateAchievements();

                              const isFinal = data.reviewedCount >= data.totalLessons;
                              if (isFinal) {
                                invalidateHome();
                                alert("You have completed the course review!");
                                navigate("/portal/learning-growth");
                              } else {
                                onAdvance();
                              }
                            },
                          },
                        );
                      }}
                      disabled={reviewLesson.isPending || blocked}
                      className="w-full sm:w-auto"
                    >
                      {reviewLesson.isPending ? (
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        "Mark Lesson as Reviewed"
                      )}
                    </Button>
                  ) : (
                    <Button onClick={onAdvance} disabled={blocked} className="w-full sm:w-auto">
                      Continue <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {lesson.exercises.length > 0 && (
            <div className="space-y-4 pt-6 border-t mt-8">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-primary" />
                Knowledge Check {voiceCycle && "(Read-only History)"}
              </h3>
              {lesson.exercises.map((exercise) => {
                const value = answers[exercise.id] || "";
                const feedback = progress?.feedback?.find((f) => f.exerciseId === exercise.id);

                return (
                  <Card key={exercise.id} className="border shadow-sm">
                    <CardContent className="p-4 sm:p-6">
                      <p className="text-sm font-medium mb-4 whitespace-pre-wrap">
                        {exercise.prompt}
                      </p>

                      {exercise.type === "choice" && exercise.options ? (
                        <RadioGroup
                          value={value}
                          onValueChange={(val) =>
                            setAnswers((prev) => ({ ...prev, [exercise.id]: val }))
                          }
                          disabled={isCompleted || blocked || !!voiceCycle}
                          className="space-y-3"
                          aria-label={exercise.prompt}
                        >
                          {exercise.options.map((opt) => (
                            <div key={opt.id} className="flex items-start space-x-3">
                              <RadioGroupItem
                                value={opt.id}
                                id={`${exercise.id}-${opt.id}`}
                                className="mt-1"
                              />
                              <Label
                                htmlFor={`${exercise.id}-${opt.id}`}
                                className="text-sm font-normal leading-tight cursor-pointer"
                              >
                                {opt.label}
                              </Label>
                            </div>
                          ))}
                        </RadioGroup>
                      ) : (
                        <div>
                          <Textarea
                            aria-label={`Your response: ${exercise.prompt}`}
                            maxLength={4000}
                            placeholder="Type your response here... (Minimum 20 non-space characters)"
                            className="min-h-[120px] resize-y"
                            value={value}
                            onChange={(e) =>
                              setAnswers((prev) => ({ ...prev, [exercise.id]: e.target.value }))
                            }
                            disabled={isCompleted || blocked || !!voiceCycle}
                          />
                          {exercise.checklist && exercise.checklist.length > 0 && (
                            <div className="mt-4 space-y-2">
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                                Self-Check (review only, not saved)
                              </p>
                              {exercise.checklist.map((item, i) => (
                                <div key={i} className="flex items-start gap-2">
                                  <Checkbox id={`check-${exercise.id}-${i}`} disabled={blocked} />
                                  <Label
                                    htmlFor={`check-${exercise.id}-${i}`}
                                    className="text-sm font-normal leading-tight mt-0.5 text-muted-foreground cursor-pointer"
                                  >
                                    {item}
                                  </Label>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {feedback && (
                        <div
                          className={`mt-6 p-4 rounded-lg border ${
                            feedback.correct === false
                              ? "bg-destructive/5 border-destructive/20"
                              : "bg-primary/5 border-primary/20"
                          }`}
                        >
                          <h4
                            className={`text-sm font-semibold mb-1 ${
                              feedback.correct === false ? "text-destructive" : "text-primary"
                            }`}
                          >
                            {feedback.correct === false ? "Feedback" : "Coach Note"}
                          </h4>
                          <p className="text-sm text-foreground whitespace-pre-wrap">
                            {feedback.message}
                          </p>

                          {feedback.modelAnswer && (
                            <div className="mt-3 pt-3 border-t border-primary/10">
                              <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                                Model Example
                              </h5>
                              <p className="text-sm italic">"{feedback.modelAnswer}"</p>
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              {!voiceCycle && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t">
                  {!isCompleted ? (
                    <>
                      <div className="text-sm text-muted-foreground">
                        {dirty ? (
                          <span role="status">Unsaved changes</span>
                        ) : (
                          progress?.status === "draft" && (
                            <span role="status" className="flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Draft saved
                            </span>
                          )
                        )}
                      </div>
                      <div className="flex w-full sm:w-auto gap-3">
                        <Button
                          variant="outline"
                          onClick={handleSaveDraft}
                          disabled={blocked}
                          className="flex-1 sm:flex-none"
                        >
                          Save Draft
                        </Button>
                        <Button
                          onClick={handleSubmit}
                          disabled={blocked}
                          className="flex-1 sm:flex-none"
                        >
                          {submit.isPending ? (
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            "Submit for Feedback"
                          )}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-signal-green">
                        <CheckCircle2 className="w-5 h-5" />
                        <span className="font-medium text-sm">Lesson Completed</span>
                      </div>
                      <Button disabled={blocked} onClick={onAdvance} className="w-full sm:w-auto">
                        Continue <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
