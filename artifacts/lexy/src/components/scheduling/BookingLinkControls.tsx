import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase, apiFetch } from "@/lib/api";
import type {
  InterviewBookingLinkInput,
  InterviewBookingLinkStatus,
  StaffOfferedTimes,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Link2 } from "lucide-react";
import { buildBookingUrl, parseLinkCreated, parseLinkStatus } from "@/lib/booking-link";
import { formatInterviewInstant as fmt } from "@/lib/interview-time-display";

async function errorOf(res: Response, fallback: string): Promise<string> {
  const b: unknown = await res.json().catch(() => null);
  return b && typeof b === "object" && "error" in b && typeof b.error === "string" && b.error
    ? b.error
    : fallback;
}

export function BookingLinkControls({
  scheduleId,
  offer,
  blocked,
  onChanged,
}: {
  scheduleId: string;
  offer: StaffOfferedTimes | null;
  blocked: boolean;
  onChanged?: () => void;
}) {
  const path = `${apiBase}/coordinator/schedules/${encodeURIComponent(scheduleId)}/booking-link`;
  const [status, setStatus] = useState<InterviewBookingLinkStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const seq = useRef(0);
  const lock = useRef(false);
  const offerVersionRef = useRef(offer?.proposal.offerVersion ?? null);
  const staffVersionRef = useRef(offer?.version ?? null);

  // Any change to the underlying offer makes a displayed link untrustworthy.
  useEffect(() => {
    const ov = offer?.proposal.offerVersion ?? null;
    const sv = offer?.version ?? null;
    if (offerVersionRef.current !== ov || staffVersionRef.current !== sv) {
      offerVersionRef.current = ov;
      staffVersionRef.current = sv;
      setUrl(null);
      setConfirming(false);
    }
  }, [offer]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await apiFetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(await errorOf(res, "Link status could not be loaded."));
      const next = parseLinkStatus(await res.json().catch(() => null));
      if (mine !== seq.current) return;
      setStatus(next);
      setReadError(null);
      if (!next.active) setUrl(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setStatus(null);
      setReadError(e instanceof Error ? e.message : "Link status could not be loaded.");
    }
  }, [path]);

  useEffect(() => {
    void load();
    const onFocus = () => {
      if (!lock.current) void load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      ++seq.current;
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const ready = !!offer && !!status && !readError && !blocked && !busy;

  async function mutate(method: "POST" | "DELETE") {
    if (lock.current || !ready || !offer || !status) return;
    lock.current = true;
    ++seq.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    setConfirming(false);
    const body: InterviewBookingLinkInput = {
      expectedVersion: offer.version,
      expectedOfferVersion: offer.proposal.offerVersion,
      expectedLinkVersion: status.version,
    };
    try {
      const res = await apiFetch(path, {
        method,
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorOf(res, "Lexy did not confirm this request."));
      const value: unknown = await res.json().catch(() => null);
      if (method === "POST") {
        const created = parseLinkCreated(value);
        setUrl(buildBookingUrl(window.location.origin, import.meta.env.BASE_URL, created.token));
        setStatus({ version: created.version, active: true, expiresAt: created.expiresAt });
      } else {
        const next = parseLinkStatus(value);
        if (next.active) throw new Error("Lexy reports the link is still active.");
        setUrl(null);
        setStatus(next);
        setNotice("Link revoked.");
      }
      onChanged?.();
    } catch (e) {
      setUrl(null);
      setStatus(null);
      setReadError(
        `${e instanceof Error ? e.message : "The request failed."} The result is uncertain; any link shown earlier was discarded. Reload the status before trying again.`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied.");
    } catch {
      window.prompt("Copy this link:", url);
    }
  }

  return (
    <section
      className="space-y-2 rounded-lg border p-3 text-sm"
      aria-label="Candidate booking link"
    >
      <p className="flex items-center gap-2 font-medium">
        <Link2 className="h-4 w-4 text-primary" /> Candidate booking link
      </p>
      <p className="text-xs text-muted-foreground">
        Anyone holding this link can choose a time for this schedule only. It does not prove who the
        person is, so share it only with the intended candidate. It expires within 7 days or at the
        earliest offered time, and stops working if the offered times change. No availability is
        checked and no calendar event, invitation or email is created.
      </p>
      {readError && (
        <div role="alert" className="space-y-2 text-destructive">
          <p>{readError}</p>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
            Reload link status
          </Button>
        </div>
      )}
      {status && (
        <p className="text-xs" data-testid="text-link-status">
          {status.active && status.expiresAt
            ? `A link is active until ${fmt(status.expiresAt)}. Its address cannot be shown again.`
            : "No active link."}
        </p>
      )}
      {url && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Shown once. Copy it now; creating another link invalidates this one.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={url}
              aria-label="Booking link"
              onFocus={(e) => e.target.select()}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Copy link"
              onClick={() => void copy()}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {confirming ? (
          <>
            <p className="w-full text-xs">
              {status?.active
                ? "This invalidates the earlier link immediately."
                : "This creates a link that lets its holder choose a time."}
            </p>
            <Button size="sm" disabled={!ready} onClick={() => void mutate("POST")}>
              {busy ? "Working…" : status?.active ? "Replace link" : "Create link"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!ready}
              onClick={() => setConfirming(true)}
            >
              {status?.active ? "Replace link" : "Create link"}
            </Button>
            {status?.active && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!ready}
                onClick={() => void mutate("DELETE")}
              >
                Revoke link
              </Button>
            )}
          </>
        )}
      </div>
      {blocked && (
        <p className="text-xs text-muted-foreground">
          Save or reload the offered times above before managing the link.
        </p>
      )}
    </section>
  );
}
