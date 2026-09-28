import { useEffect, useRef, useState, useCallback } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  ChevronRight,
  RefreshCw,
  Mic,
  AlertTriangle,
  MicOff,
} from "lucide-react";
import {
  useGetLearningAssessmentDetail,
  useSubmitLearningAssessmentTask,
  LearningAssessmentTask,
} from "@/lib/use-learning-assessments";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";

import { useAuth } from "@/lib/auth-context";

export default function AssessmentDetail() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/portal/learning-growth/assessments/:assessmentId");
  const assessmentId = params?.assessmentId;
  const { user } = useAuth();
  const userId = user?.id || "guest";
  const {
    data: detail,
    isLoading,
    error,
    refetch,
  } = useGetLearningAssessmentDetail(assessmentId || "");
  const [activeTaskKey, setActiveTaskKey] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    document.title = `Assessment | Lexy`;
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty && !isPending) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const guardLink = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!anchor || (!isDirty && !isPending)) return;
      if (isPending || !window.confirm("You have unsaved changes in this task. Discard them?")) {
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
  }, [isDirty, isPending]);

  useEffect(() => {
    if (detail && (!activeTaskKey || !detail.tasks.some((t) => t.key === activeTaskKey))) {
      setActiveTaskKey(detail.summary.resumeTaskKey || detail.tasks[0]?.key);
    }
  }, [detail, activeTaskKey]);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="mx-auto max-w-5xl space-y-8 py-8 animate-pulse">
          <Skeleton className="h-12 w-1/3" />
          <div className="flex flex-col md:flex-row gap-8">
            <Skeleton className="h-32 md:h-96 w-full md:w-64 shrink-0" />
            <Skeleton className="h-[600px] flex-1" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!detail || !assessmentId) {
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
              <CardTitle>Unable to load assessment</CardTitle>
              <CardDescription>
                {error?.message || "We encountered an error loading this assessment."}
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

  const { summary, tasks } = detail;
  const activeTask = tasks.find((t) => t.key === activeTaskKey) || tasks[0];

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
            <h1 className="text-2xl font-bold tracking-tight">{summary.title}</h1>
            <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
              <Badge variant="outline" className="bg-primary/5">
                {summary.path === "voice" ? "Voice Track" : "Chat & Email Track"}
              </Badge>
              <span>
                {summary.completedTasks} of {summary.totalTasks} completed
              </span>
            </div>
          </div>
        </div>

        {error && (
          <Alert>
            <AlertTitle>Could not refresh this assessment</AlertTitle>
            <AlertDescription>
              {error.message} Your current answers are still here.{" "}
              <button className="underline" onClick={() => refetch()}>
                Retry
              </button>
            </AlertDescription>
          </Alert>
        )}

        {summary.status === "completed" && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Assessment completed</AlertTitle>
            <AlertDescription>
              Your assessment is complete. Review your private report.{" "}
              <Button asChild variant="link" className="px-0 ml-2 h-auto text-primary">
                <Link href={`/portal/learning-growth/assessments/${assessmentId}/report`}>
                  View Report
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col md:flex-row gap-8 items-start">
          {/* Navigation */}
          <div className="w-full md:w-64 shrink-0 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-visible pb-2 md:pb-0 md:sticky md:top-24">
            <h3 className="hidden md:block font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-2">
              Tasks
            </h3>
            {tasks.map((task) => {
              const isCompleted = task.progress.status === "submitted";
              const isActive = activeTaskKey === task.key;

              return (
                <button
                  key={task.key}
                  disabled={isPending}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`${task.title}${isCompleted ? " (Submitted)" : ""}`}
                  onClick={() => {
                    if (isActive || isPending) return;
                    if (
                      isDirty &&
                      !window.confirm("You have unsaved changes in this task. Discard them?")
                    )
                      return;
                    setIsDirty(false);
                    setActiveTaskKey(task.key);
                  }}
                  className={`flex items-center gap-2 p-3 rounded-lg text-left transition-colors whitespace-nowrap md:whitespace-normal ${
                    isActive
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : isPending
                        ? "opacity-50 cursor-not-allowed hover:bg-transparent"
                        : "hover:bg-muted/50 border md:border-transparent"
                  }`}
                >
                  {isCompleted ? (
                    <CheckCircle2
                      className={`w-4 h-4 shrink-0 ${isActive ? "text-primary-foreground" : "text-signal-green"}`}
                    />
                  ) : (
                    <Circle
                      className={`w-4 h-4 shrink-0 ${isActive ? "text-primary-foreground" : "text-muted-foreground"}`}
                    />
                  )}
                  <span
                    className={`text-sm font-medium ${isActive ? "text-primary-foreground" : "text-foreground"}`}
                  >
                    {task.title}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Main Content */}
          <div className="flex-1 min-w-0 bg-card border rounded-xl shadow-sm overflow-hidden w-full">
            {activeTask && (
              <TaskContent
                key={`${assessmentId}:${activeTask.key}`}
                userId={userId}
                assessmentId={assessmentId}
                task={activeTask}
                onAdvance={() => {
                  const currentIndex = tasks.findIndex((t) => t.key === activeTask.key);
                  if (currentIndex < tasks.length - 1) {
                    setActiveTaskKey(tasks[currentIndex + 1].key);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  } else {
                    if (detail.summary.status === "completed") {
                      navigate(`/portal/learning-growth/assessments/${assessmentId}/report`);
                    } else {
                      const nextIncomplete = tasks.find((t) => t.progress.status !== "submitted");
                      if (nextIncomplete) {
                        setActiveTaskKey(nextIncomplete.key);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      } else {
                        navigate(`/portal/learning-growth/assessments/${assessmentId}/report`);
                      }
                    }
                  }
                }}
                onDirtyChange={setIsDirty}
                onPendingChange={setIsPending}
                refetchAssessment={refetch}
              />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function TaskContent({
  userId,
  assessmentId,
  task,
  onAdvance,
  onDirtyChange,
  onPendingChange,
  refetchAssessment,
}: {
  userId: string;
  assessmentId: string;
  task: LearningAssessmentTask;
  onAdvance: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  refetchAssessment: () => Promise<any>;
}) {
  const submit = useSubmitLearningAssessmentTask(assessmentId, task.key);
  const [progress, setProgress] = useState(task.progress);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const isCompleted = progress.status === "submitted";

  const storageKey = `lexy-assessment-draft-${userId}-${assessmentId}-${task.key}`;

  const [response, setResponse] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem(storageKey);
      if (saved !== null && progress.status !== "submitted") {
        return saved;
      }
    }
    return progress.response || "";
  });

  const currentRevision = useRef<number>(progress.revision);
  const initialResponse = useRef<string>(progress.response || "");
  const dirty = response !== initialResponse.current;
  const blocked = submit.isPending || reloading;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (dirty && !isCompleted) {
      sessionStorage.setItem(storageKey, response);
    } else {
      sessionStorage.removeItem(storageKey);
    }
  }, [response, dirty, isCompleted, storageKey]);

  const clearLocalDraft = useCallback(() => {
    sessionStorage.removeItem(storageKey);
  }, [storageKey]);

  const handleSpeechResult = useCallback((text: string) => {
    setResponse((prev: string) => prev + text);
  }, []);

  const {
    isSupported,
    isListening,
    startListening,
    stopListening,
    error: speechError,
    clearError: clearSpeechError,
  } = useSpeechRecognition({
    onResult: handleSpeechResult,
  });

  useEffect(() => {
    onPendingChange(blocked || isListening);
  }, [blocked, isListening, onPendingChange]);

  const reloadLatest = async () => {
    setReloading(true);
    setReloadError("");
    try {
      const result = await refetchAssessment();
      const latest = result.data?.tasks.find((t: any) => t.key === task.key)?.progress;
      if (result.error || !latest) {
        setReloadError(
          result.error?.message ?? "Could not reload this task. Your draft is still here.",
        );
        return;
      }
      currentRevision.current = latest.revision;
      initialResponse.current = latest.response;
      setResponse(latest.response);
      setProgress(latest);
      onDirtyChange(false);
      submit.reset();
    } finally {
      setReloading(false);
    }
  };

  const handleSaveDraft = useCallback(() => {
    if (isListening) stopListening();
    if (isCompleted || blocked) return;
    submit.mutate(
      {
        revision: currentRevision.current,
        response,
        action: "save_draft",
      },
      {
        onSuccess: (data) => {
          const updatedTask = data.tasks.find((t) => t.key === task.key);
          if (updatedTask?.progress) {
            clearLocalDraft();
            currentRevision.current = updatedTask.progress.revision;
            initialResponse.current = updatedTask.progress.response;
            setResponse(updatedTask.progress.response);
            setProgress(updatedTask.progress);
            onDirtyChange(false);
          }
        },
      },
    );
  }, [
    response,
    isCompleted,
    blocked,
    submit,
    task.key,
    onDirtyChange,
    isListening,
    stopListening,
    clearLocalDraft,
  ]);

  const handleSubmit = useCallback(() => {
    if (isListening) stopListening();
    if (isCompleted || blocked) return;
    const nonSpaceLength = response.replace(/\s/g, "").length;
    if (nonSpaceLength < task.minimumNonSpaceCharacters) {
      alert(
        `Your response must be at least ${task.minimumNonSpaceCharacters} non-space characters.`,
      );
      return;
    }
    if (!window.confirm("Are you sure you want to submit? This cannot be undone.")) return;

    submit.mutate(
      {
        revision: currentRevision.current,
        response,
        action: "submit",
      },
      {
        onSuccess: (data) => {
          const updatedTask = data.tasks.find((t) => t.key === task.key);
          if (updatedTask?.progress) {
            clearLocalDraft();
            currentRevision.current = updatedTask.progress.revision;
            initialResponse.current = updatedTask.progress.response;
            setResponse(updatedTask.progress.response);
            setProgress(updatedTask.progress);
            onDirtyChange(false);
          }
        },
      },
    );
  }, [
    response,
    isCompleted,
    blocked,
    submit,
    task.key,
    onDirtyChange,
    task.minimumNonSpaceCharacters,
    isListening,
    stopListening,
    clearLocalDraft,
  ]);

  const hasConflict = submit.error?.message?.includes("newer version");

  return (
    <div className="flex flex-col h-full animate-in fade-in duration-300">
      <div className="p-6 md:p-8 border-b bg-muted/20">
        <h2 className="text-2xl font-bold mb-4">{task.title}</h2>
        <div className="bg-background border rounded-lg p-4 mt-4">
          <h4 className="font-semibold text-sm mb-2 text-primary">Instructions</h4>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{task.instructions}</p>
        </div>
        {task.coveredDimensions?.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider py-1">
              Assessing:
            </span>
            {task.coveredDimensions.map((dim) => (
              <Badge
                key={dim}
                variant="secondary"
                className="bg-muted text-muted-foreground font-normal"
              >
                {dim}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="p-6 md:p-8 space-y-8">
        <section className="prose prose-sm md:prose-base dark:prose-invert max-w-none">
          <h3 className="text-xl font-semibold mb-3 text-foreground">Scenario</h3>
          <div className="text-muted-foreground whitespace-pre-wrap leading-relaxed p-4 bg-muted/30 rounded-lg border">
            {task.scenario}
          </div>
        </section>

        <section className="border-t pt-8">
          <h3 className="text-lg font-semibold mb-4">Your Response</h3>

          {hasConflict && (
            <Alert variant="destructive" className="mb-4">
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
            <p role="alert" className="text-destructive mb-4">
              {reloadError}
            </p>
          )}

          {submit.error && !hasConflict && (
            <Alert variant="destructive" className="mb-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{submit.error.message}</AlertDescription>
            </Alert>
          )}

          {speechError && (
            <Alert variant="destructive" className="mb-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Dictation Error</AlertTitle>
              <AlertDescription>
                {speechError}
                <Button
                  variant="link"
                  onClick={clearSpeechError}
                  className="px-0 h-auto text-destructive underline ml-2"
                >
                  Dismiss
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-4">
            {task.responseMode === "spoken_or_typed" && !isCompleted && (
              <div className="bg-muted p-4 rounded-md mb-2 border">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <Mic className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">
                        Voice Dictation{" "}
                        <span className="font-normal text-muted-foreground">
                          (Optional Convenience)
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Lexy does not receive or store audio. Your browser's speech service may
                        process it under your browser settings. A typed response is always
                        available.
                      </p>
                    </div>
                  </div>
                  {isSupported ? (
                    <Button
                      variant={isListening ? "destructive" : "secondary"}
                      size="sm"
                      onClick={isListening ? stopListening : startListening}
                      disabled={blocked}
                    >
                      {isListening ? (
                        <>
                          <MicOff className="w-4 h-4 mr-2" /> Stop Listening
                        </>
                      ) : (
                        <>
                          <Mic className="w-4 h-4 mr-2" /> Start Dictation
                        </>
                      )}
                    </Button>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground border-dashed">
                      Not supported in this browser
                    </Badge>
                  )}
                </div>
                {isListening && (
                  <div className="mt-3 text-xs text-primary animate-pulse flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                    </span>
                    Listening... Speak now.
                  </div>
                )}
              </div>
            )}

            <div>
              <Textarea
                aria-label={`Your response for task: ${task.title}`}
                maxLength={6000}
                placeholder={`Type your response here... (Minimum ${task.minimumNonSpaceCharacters} non-space characters)`}
                className="min-h-[240px] resize-y"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                disabled={isCompleted || blocked || isListening}
              />
              {!isCompleted && (
                <div className="flex justify-between items-center mt-2">
                  <p className="text-xs text-muted-foreground">
                    {response.replace(/\s/g, "").length} / {task.minimumNonSpaceCharacters}{" "}
                    non-space characters required
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {response.length} / 6000 characters
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-8 pt-6 border-t">
            {!isCompleted ? (
              <>
                <div className="text-sm text-muted-foreground">
                  {dirty ? (
                    <span role="status">Unsaved changes</span>
                  ) : (
                    progress.status === "draft" && (
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
                    disabled={
                      blocked || response.replace(/\s/g, "").length < task.minimumNonSpaceCharacters
                    }
                    className="flex-1 sm:flex-none"
                  >
                    {submit.isPending ? (
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      "Submit Task"
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-signal-green">
                  <CheckCircle2 className="w-5 h-5" />
                  <span className="font-medium text-sm">Task Submitted (Read-only)</span>
                </div>
                <Button disabled={blocked} onClick={onAdvance} className="w-full sm:w-auto">
                  Continue <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
