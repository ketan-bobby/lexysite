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
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useGetLearningVoiceProgressCycle,
  useSaveLearningVoiceProgressTurn,
  useVoiceProgressInvalidation,
} from "@/lib/use-learning-voice-progress";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useAuth } from "@/lib/auth-context";
import type { LearningVoiceProgressTurn } from "@workspace/api-client-react";

export default function VoiceProgressCycleDetail() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/portal/learning-growth/voice-progress/:cycleId");
  const cycleId = params?.cycleId;
  const { user } = useAuth();
  const userId = user?.id || "guest";

  const {
    data: detail,
    isLoading,
    error,
    refetch,
  } = useGetLearningVoiceProgressCycle(cycleId || "");
  const [activeTaskKey, setActiveTaskKey] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    document.title = "Voice Progress | Lexy";
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
      if (isPending || !window.confirm("You have unsaved changes. Discard them?")) {
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
    if (detail && (!activeTaskKey || !detail.turns.some((t) => t.key === activeTaskKey))) {
      const nextIncomplete = detail.turns.find((t) => t.progress.status !== "submitted");
      setActiveTaskKey(nextIncomplete?.key || detail.turns[0]?.key);
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

  if (!detail || !cycleId) {
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
              <CardTitle>Unable to load cycle</CardTitle>
              <CardDescription>
                {error?.message || "We encountered an error loading this cycle."}
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

  const { summary, turns, privacy } = detail;
  const activeTurn = turns.find((t) => t.key === activeTaskKey) || turns[0];

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
            <h1 className="text-2xl font-bold tracking-tight">Voice Progress Cycle</h1>
            <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
              <Badge variant="outline" className="bg-primary/5">
                {summary.state === "baseline_draft"
                  ? "Baseline"
                  : summary.state === "progress_draft"
                    ? "Progress"
                    : summary.state === "training_required"
                      ? "Training Required"
                      : "Completed"}
              </Badge>
              <span>
                {summary.completedTurns} of {summary.totalTurns} turns completed
              </span>
            </div>
            {privacy && (
              <p className="mt-2 text-xs text-muted-foreground max-w-xl">
                Privacy disclosure: {privacy.audioStorage}. Browser speech services may process
                speech under browser settings.
              </p>
            )}
          </div>
        </div>

        {error && (
          <Alert>
            <AlertTitle>Could not refresh this cycle</AlertTitle>
            <AlertDescription>
              {error.message}{" "}
              <button className="underline" onClick={() => refetch()}>
                Retry
              </button>
            </AlertDescription>
          </Alert>
        )}

        {summary.state === "completed" && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Cycle completed</AlertTitle>
            <AlertDescription>
              Your cycle is complete. Review your private report.{" "}
              <Button asChild variant="link" className="px-0 ml-2 h-auto text-primary">
                <Link href={`/portal/learning-growth/voice-progress/${cycleId}/report`}>
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
              Conversation
            </h3>
            {turns.map((turn, index) => {
              const isCompleted = turn.progress.status === "submitted";
              const isActive = activeTaskKey === turn.key;

              return (
                <button
                  key={turn.key}
                  disabled={
                    isPending || (!isCompleted && !isActive && summary.state === "completed")
                  }
                  aria-current={isActive ? "step" : undefined}
                  onClick={() => {
                    if (isActive || isPending) return;
                    if (isDirty && !window.confirm("You have unsaved changes. Discard them?"))
                      return;
                    setIsDirty(false);
                    setActiveTaskKey(turn.key);
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
                    Turn {index + 1} ({turn.phase})
                  </span>
                </button>
              );
            })}
          </div>

          {/* Main Content */}
          <div className="flex-1 min-w-0 bg-card border rounded-xl shadow-sm overflow-hidden w-full">
            {activeTurn && (
              <TurnContent
                key={`${cycleId}:${activeTurn.key}`}
                userId={userId}
                cycleId={cycleId}
                turn={activeTurn}
                onAdvance={() => {
                  const currentIndex = turns.findIndex((t) => t.key === activeTurn.key);
                  if (currentIndex < turns.length - 1) {
                    setActiveTaskKey(turns[currentIndex + 1].key);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  } else {
                    if (summary.state === "completed") {
                      navigate(`/portal/learning-growth/voice-progress/${cycleId}/report`);
                    } else {
                      refetch().then((result) => {
                        const updatedSummary = result.data?.summary;
                        if (updatedSummary?.state === "completed") {
                          navigate(`/portal/learning-growth/voice-progress/${cycleId}/report`);
                        } else {
                          const nextIncomplete = result.data?.turns.find(
                            (t) => t.progress.status !== "submitted",
                          );
                          if (nextIncomplete) {
                            setActiveTaskKey(nextIncomplete.key);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          } else {
                            navigate(`/portal/learning-growth`);
                          }
                        }
                      });
                    }
                  }
                }}
                onDirtyChange={setIsDirty}
                onPendingChange={setIsPending}
                refetchCycle={refetch}
              />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function TurnContent({
  userId,
  cycleId,
  turn,
  onAdvance,
  onDirtyChange,
  onPendingChange,
  refetchCycle,
}: {
  userId: string;
  cycleId: string;
  turn: LearningVoiceProgressTurn;
  onAdvance: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  refetchCycle: () => Promise<any>;
}) {
  const [, navigate] = useLocation();
  const submit = useSaveLearningVoiceProgressTurn();
  const { invalidateHome, invalidateCycle, setCycleData } = useVoiceProgressInvalidation();
  const [progress, setProgress] = useState(turn.progress);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const isCompleted = progress.status === "submitted";

  const storageKey = `lexy-voice-progress-${userId}-${cycleId}-${turn.phase}-${turn.key}`;

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

  // TTS State
  const [isSpeaking, setIsSpeaking] = useState(false);

  const blocked = submit.isPending || reloading || isSpeaking;

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
    setResponse((prev) => prev + text);
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
    onPendingChange(blocked || isListening || isSpeaking);
  }, [blocked, isListening, isSpeaking, onPendingChange]);

  // Clean up TTS when component unmounts or turn changes
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (isListening) stopListening();
    };
  }, [isListening, stopListening]);

  const handleSpeak = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    // Cancel any ongoing speech and dictation
    if (isListening) stopListening();
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(turn.prompt);
    utterance.lang = "en-US";

    let fallbackTimer: any;

    utterance.onstart = () => {
      setIsSpeaking(true);
      clearTimeout(fallbackTimer);
      // Fallback in case onend never fires
      fallbackTimer = setTimeout(() => {
        setIsSpeaking(false);
      }, 60000);
    };

    utterance.onend = () => {
      setIsSpeaking(false);
      clearTimeout(fallbackTimer);
    };

    utterance.onerror = () => {
      setIsSpeaking(false);
      clearTimeout(fallbackTimer);
    };

    // Sometimes onstart doesn't fire immediately or at all in some browsers
    fallbackTimer = setTimeout(() => {
      setIsSpeaking(false);
    }, 2000);

    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, [turn.prompt, isListening, stopListening]);

  const handleStopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, []);

  const handleStartListening = useCallback(() => {
    if (isSpeaking) {
      handleStopSpeaking();
    }
    startListening();
  }, [isSpeaking, handleStopSpeaking, startListening]);

  const reloadLatest = async () => {
    setReloading(true);
    setReloadError("");
    try {
      const result = await refetchCycle();
      const latest = result.data?.turns.find((t: any) => t.key === turn.key)?.progress;
      if (result.error || !latest) {
        setReloadError(
          result.error?.message ?? "Could not reload this turn. Your draft is still here.",
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
        cycleId,
        taskKey: turn.key,
        data: {
          revision: currentRevision.current,
          response,
          action: "save_draft",
        },
      },
      {
        onSuccess: (data) => {
          setCycleData(cycleId, data);
          clearLocalDraft();
          onDirtyChange(false);
          const updatedTurn = data.turns.find((t) => t.key === turn.key);
          if (updatedTurn?.progress) {
            currentRevision.current = updatedTurn.progress.revision;
            initialResponse.current = updatedTurn.progress.response;
            setResponse(updatedTurn.progress.response);
            setProgress(updatedTurn.progress);
          }
        },
      },
    );
  }, [
    cycleId,
    turn.key,
    response,
    isCompleted,
    blocked,
    submit,
    onDirtyChange,
    isListening,
    stopListening,
    clearLocalDraft,
    setCycleData,
  ]);

  const handleSubmit = useCallback(() => {
    if (isListening) stopListening();
    if (isCompleted || blocked) return;
    const nonSpaceLength = response.replace(/\s/g, "").length;
    if (nonSpaceLength < turn.minimumNonSpaceCharacters) {
      alert(
        `Your response must be at least ${turn.minimumNonSpaceCharacters} non-space characters.`,
      );
      return;
    }
    if (!window.confirm("Are you sure you want to submit? This cannot be undone.")) return;

    submit.mutate(
      {
        cycleId,
        taskKey: turn.key,
        data: {
          revision: currentRevision.current,
          response,
          action: "submit",
        },
      },
      {
        onSuccess: (data) => {
          setCycleData(cycleId, data);
          clearLocalDraft();
          onDirtyChange(false);
          invalidateHome();

          const updatedTurn = data.turns.find((t) => t.key === turn.key);
          if (updatedTurn?.progress) {
            currentRevision.current = updatedTurn.progress.revision;
            initialResponse.current = updatedTurn.progress.response;
            setResponse(updatedTurn.progress.response);
            setProgress(updatedTurn.progress);
          } else {
            invalidateCycle(cycleId);
            // Branch on summary state since the turn is gone
            if (data.summary.state === "training_required") {
              navigate("/portal/learning-growth");
            } else if (data.summary.state === "completed") {
              navigate(`/portal/learning-growth/voice-progress/${cycleId}/report`);
            }
          }
        },
      },
    );
  }, [
    cycleId,
    turn.key,
    response,
    isCompleted,
    blocked,
    submit,
    onDirtyChange,
    turn.minimumNonSpaceCharacters,
    isListening,
    stopListening,
    clearLocalDraft,
    setCycleData,
    invalidateHome,
    invalidateCycle,
    navigate,
  ]);

  const hasConflict = Boolean(
    submit.error &&
    ((submit.error as any).response?.status === 409 ||
      (submit.error as any).code === "revision_conflict" ||
      submit.error.message?.toLowerCase().includes("newer version") ||
      submit.error.message?.toLowerCase().includes("changed") ||
      submit.error.message?.toLowerCase().includes("reload")),
  );

  return (
    <div className="flex flex-col h-full animate-in fade-in duration-300">
      <div className="p-6 md:p-8 border-b bg-muted/20">
        <h2 className="text-xl font-semibold mb-4 text-foreground">Lexy says:</h2>
        <div className="text-lg text-foreground whitespace-pre-wrap leading-relaxed p-4 bg-background rounded-lg border shadow-sm">
          {turn.prompt}
        </div>

        <div className="mt-4 flex gap-2">
          {typeof window !== "undefined" && !!window.speechSynthesis ? (
            isSpeaking ? (
              <Button variant="secondary" size="sm" onClick={handleStopSpeaking}>
                <VolumeX className="w-4 h-4 mr-2" /> Stop Speaking
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={handleSpeak}>
                <Volume2 className="w-4 h-4 mr-2" /> Listen to Prompt
              </Button>
            )
          ) : (
            <Badge variant="outline" className="text-muted-foreground border-dashed">
              Speech synthesis not supported
            </Badge>
          )}
        </div>
      </div>

      <div className="p-6 md:p-8 space-y-8">
        <section>
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
            {!isCompleted && (
              <div className="bg-muted/50 p-4 rounded-md mb-2 border">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <Mic className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        Respond with Voice
                        <span className="font-normal text-muted-foreground ml-2">(Optional)</span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Use the mic to dictate your answer naturally. Lexy processes the text, but
                        your audio is never stored. If you prefer or if your mic is unheard, you can
                        safely type your answer below instead.
                      </p>
                    </div>
                  </div>
                  {isSupported ? (
                    <Button
                      variant={isListening ? "destructive" : "secondary"}
                      size="sm"
                      onClick={isListening ? stopListening : handleStartListening}
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
                      Speech recognition not supported
                    </Badge>
                  )}
                </div>
                {isListening && (
                  <div className="mt-3 text-xs text-primary animate-pulse flex items-center gap-2 font-medium">
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
                aria-label={`Your response for turn in phase ${turn.phase}`}
                maxLength={6000}
                placeholder={
                  isListening
                    ? "Listening... your words will appear here."
                    : `Type your response here... (Minimum ${turn.minimumNonSpaceCharacters} non-space characters)`
                }
                className="min-h-[200px] resize-y text-base p-4"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                disabled={isCompleted || blocked || isListening}
              />
              {!isCompleted && (
                <div className="flex justify-between items-center mt-2">
                  <p className="text-xs text-muted-foreground">
                    {response.replace(/\s/g, "").length} / {turn.minimumNonSpaceCharacters}{" "}
                    non-space chars required
                  </p>
                  <p className="text-xs text-muted-foreground">{response.length} / 6000 chars</p>
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
                      blocked || response.replace(/\s/g, "").length < turn.minimumNonSpaceCharacters
                    }
                    className="flex-1 sm:flex-none"
                  >
                    {submit.isPending ? (
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      "Submit Response"
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-signal-green">
                  <CheckCircle2 className="w-5 h-5" />
                  <span className="font-medium text-sm">Response Submitted (Read-only)</span>
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
