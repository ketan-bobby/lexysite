import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useRef } from "react";

export function InterviewAnswerReview({
  answer,
  onChange,
  onConfirm,
  onRetry,
  pending,
  onShown,
}: {
  answer: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onRetry: () => void;
  pending: boolean;
  onShown?: (inViewport: boolean) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    onShown?.(
      Boolean(
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0,
      ),
    );
  }, [onShown]);
  return (
    <section
      ref={panelRef}
      aria-label="Review captured answer"
      className="rounded-xl border border-amber-400/40 bg-amber-400/5 p-4 space-y-3"
    >
      <h2 className="font-bold text-foreground">Please check what we captured</h2>
      <p className="text-sm text-muted-foreground">
        The microphone evidence was unclear. This answer has not been submitted or scored. Correct
        the text and confirm it, or record your answer again. Short answers are welcome.
      </p>
      <Textarea
        aria-label="Captured answer to confirm"
        value={answer}
        disabled={pending}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
      />
      <div className="flex flex-wrap gap-2">
        <Button onClick={onConfirm} disabled={pending || !answer.trim()}>
          {pending ? "Submitting…" : "Confirm this answer"}
        </Button>
        <Button variant="outline" onClick={onRetry} disabled={pending}>
          Record again
        </Button>
      </div>
    </section>
  );
}
