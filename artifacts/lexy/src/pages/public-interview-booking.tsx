import { useCallback, useEffect, useRef, useState } from "react";
import { TimeChangeRequest } from "@/components/scheduling/TimeChangeRequest";
import type {
  CandidateOfferedTimes,
  CandidateTimeConfirmationReceipt,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { apiBase } from "@/lib/api";
import { parseBookingToken } from "@/lib/booking-link";
import { readCandidateConfirmationReceipt } from "@/lib/candidate-time-confirmation";
import { parseCandidateOfferedTimes } from "@/lib/offered-times";
import { formatInterviewInstant as fmt } from "@/lib/interview-time-display";

type View =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "error"; message: string }
  | { kind: "offered"; proposal: CandidateOfferedTimes; expiresAt: string }
  | { kind: "confirmed"; receipt: CandidateTimeConfirmationReceipt };

type ReadResult = Exclude<View, { kind: "loading" }>;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${apiBase}/public/interview-booking/${path}`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readBooking(token: string): Promise<ReadResult> {
  let res: Response;
  try {
    res = await post("read", { token });
  } catch {
    return {
      kind: "error",
      message: "Lexy could not be reached. Check your connection and try again.",
    };
  }
  if (res.status === 404) return { kind: "invalid" };
  if (res.status === 503)
    return { kind: "error", message: "Booking is temporarily unavailable. Try again shortly." };
  if (!res.ok)
    return { kind: "error", message: "The booking page could not be loaded. Try again." };
  try {
    const b: unknown = await res.json();
    if (!b || typeof b !== "object") throw new Error();
    const v = b as Record<string, unknown>;
    if (v.state === "confirmed") {
      const r = v.receipt as Record<string, unknown> | null;
      if (!r) throw new Error();
      const receipt = readCandidateConfirmationReceipt(r, {
        id: String(r.scheduleId),
        scheduledAt: String(r.scheduledAt),
        duration: r.durationMinutes as number,
      });
      return { kind: "confirmed", receipt };
    }
    const p = v.proposal as Record<string, unknown> | null;
    if (v.state !== "offered" || !p || typeof v.expiresAt !== "string") throw new Error();
    const proposal = parseCandidateOfferedTimes(p, String(p.scheduleId));
    return { kind: "offered", proposal, expiresAt: v.expiresAt };
  } catch {
    return { kind: "error", message: "The reply could not be verified. Try again." };
  }
}

function useHeadMeta() {
  useEffect(() => {
    const added: HTMLMetaElement[] = [];
    const set = (name: string, content: string) => {
      const existing = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (existing) {
        const prev = existing.content;
        existing.content = content;
        return () => {
          existing.content = prev;
        };
      }
      const m = document.createElement("meta");
      m.name = name;
      m.content = content;
      document.head.appendChild(m);
      added.push(m);
      return () => m.remove();
    };
    const undo = [set("referrer", "no-referrer"), set("robots", "noindex, nofollow")];
    return () => undo.forEach((u) => u());
  }, []);
}

export default function PublicInterviewBooking() {
  useHeadMeta();
  const [token] = useState(() => parseBookingToken(window.location.hash));
  const [view, setView] = useState<View>(token ? { kind: "loading" } : { kind: "invalid" });
  const currentView = useRef(view);
  currentView.current = view;
  const [choice, setChoice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const lock = useRef(false);
  const seq = useRef(0);
  const shown = useRef<{ v: string; o: string | null } | null>(null);

  const load = useCallback(
    async (explicit: boolean) => {
      if (!token || lock.current) return;
      const mine = ++seq.current;
      if (explicit) setView((v) => (v.kind === "offered" ? v : { kind: "loading" }));
      const next = await readBooking(token);
      if (mine !== seq.current || lock.current) return;
      if (next.kind === "offered") {
        if (!explicit && currentView.current.kind === "confirmed") {
          setView(next);
          setStale(true);
          return;
        }
        const s = shown.current;
        const changed = s && (s.v !== next.proposal.version || s.o !== next.proposal.offerVersion);
        if (!s || explicit) {
          shown.current = { v: next.proposal.version, o: next.proposal.offerVersion };
          setStale(false);
          setChoice((c) => (c && next.proposal.startsAt.includes(c) ? c : null));
          setView(next);
          if (explicit) setUncertain(null);
        } else if (changed) setStale(true);
      } else if (next.kind === "confirmed") {
        setView(next);
        setUncertain(null);
      } else if (next.kind === "invalid") setView(next);
      else if (explicit || !shown.current || currentView.current.kind === "confirmed")
        setView(next);
      else setStale(true);
    },
    [token],
  );

  useEffect(() => {
    void load(true);
    const refresh = () => {
      // Consumed links can open directly on a receipt, without a proposal.
      // Revalidate those receipts too; a staff change can invalidate the grant.
      const kind = currentView.current.kind;
      if (kind !== "invalid" && kind !== "loading") void load(false);
    };
    const id = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      ++seq.current;
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  async function confirm() {
    if (view.kind !== "offered" || !choice || !token || lock.current || stale || uncertain) return;
    const { proposal } = view;
    const chosen = choice;
    lock.current = true;
    ++seq.current;
    setPending(true);
    try {
      const body = {
        confirm: true as const,
        token,
        expectedVersion: proposal.version,
        expectedOfferVersion: proposal.offerVersion,
        scheduledAt: chosen,
      };
      const res = await post("choose", body);
      if (res.status === 404) {
        setView({ kind: "invalid" });
        return;
      }
      const value: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(res.status === 409 ? "conflict" : "failed");
      const receipt = readCandidateConfirmationReceipt(value, {
        id: proposal.scheduleId,
        scheduledAt: chosen,
        duration: proposal.durationMinutes,
      });
      setView({ kind: "confirmed", receipt });
    } catch (e) {
      setUncertain(
        e instanceof Error && e.message === "conflict"
          ? "These times changed or a different choice was already recorded. Your selection is kept; check the latest status before choosing again."
          : "Lexy did not confirm your choice, so it may or may not have been saved. Your selection is kept. Check the latest status first; do not assume it failed.",
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
    // Automatic read after an uncertain write may recover a lost success.
    // Use the same sequence fence as focus, polling and explicit reloads so a
    // delayed recovery response cannot overwrite a newer status check.
    await load(false);
  }

  const shell = (children: React.ReactNode) => (
    <main className="min-h-[100dvh] bg-background text-foreground px-4 py-10">
      <div className="mx-auto w-full max-w-lg space-y-5">
        <h1 className="text-2xl font-semibold">Choose your interview time</h1>
        {children}
      </div>
    </main>
  );

  if (view.kind === "loading")
    return shell(
      <div role="status" aria-label="Loading" className="space-y-2">
        <div className="h-14 rounded-lg skeleton-shimmer" />
        <div className="h-14 rounded-lg skeleton-shimmer" />
      </div>,
    );
  if (view.kind === "invalid")
    return shell(
      <p role="alert" data-testid="text-invalid-link">
        This link is not valid. It may have expired, been replaced or been revoked. Ask the person
        who sent it for a new link.
      </p>,
    );
  if (view.kind === "error")
    return shell(
      <div role="alert" className="space-y-3">
        <p className="text-destructive">{view.message}</p>
        <Button variant="outline" onClick={() => void load(true)}>
          Try again
        </Button>
      </div>,
    );
  if (view.kind === "confirmed")
    return shell(
      <div className="space-y-2 rounded-lg border p-4" data-testid="status-confirmed">
        <p className="font-medium">Your choice is recorded in Lexy.</p>
        <p>
          {fmt(view.receipt.scheduledAt)} · {view.receipt.durationMinutes} minutes
        </p>
        <p className="text-sm text-muted-foreground">
          No calendar event was reserved and no invitation was sent. Your recruiter will arrange the
          details.
        </p>
        {token && <TimeChangeRequest token={token} scheduleId={view.receipt.scheduleId} />}
      </div>,
    );

  const { proposal, expiresAt } = view;
  const blocked = pending || stale || !!uncertain || !choice;
  return shell(
    <>
      <p className="text-sm text-muted-foreground">
        Anyone with this link can choose a time for this interview, so keep it private. Choosing
        records your preference in Lexy only; it does not check calendars, create an event or send
        an invitation. This link does not verify who you are.
      </p>
      <fieldset disabled={pending} className="space-y-2">
        <legend className="mb-1 text-sm font-medium">
          Offered times · {proposal.durationMinutes} minutes
        </legend>
        <p className="text-xs text-muted-foreground">
          Shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}.
        </p>
        {proposal.startsAt.map((t, i) => (
          <label
            key={t}
            className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${choice === t ? "border-primary" : ""}`}
          >
            <input type="radio" name="time" checked={choice === t} onChange={() => setChoice(t)} />
            <span>
              {fmt(t)}
              {i === 0 && <span className="ml-2 text-xs text-muted-foreground">Original time</span>}
            </span>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">These options expire {fmt(expiresAt)}.</p>
      </fieldset>
      {stale && (
        <p role="alert" className="text-sm text-destructive">
          The offered times changed or could not be refreshed. Reload before choosing.
        </p>
      )}
      {uncertain && (
        <p role="alert" className="text-sm text-destructive">
          {uncertain}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={blocked} onClick={() => void confirm()}>
          {pending ? "Confirming…" : "Confirm this time"}
        </Button>
        {token && !pending && <TimeChangeRequest token={token} scheduleId={proposal.scheduleId} />}
        {(stale || uncertain) && (
          <Button variant="outline" disabled={pending} onClick={() => void load(true)}>
            Reload latest
          </Button>
        )}
      </div>
    </>,
  );
}
