/*
 * signup-success.tsx — Post-checkout provisioning screen.
 *
 * After Stripe checkout the user lands here with a `?ps=<pendingSignupId>` in
 * the URL. Tenant provisioning happens asynchronously server-side, so this page
 * polls /api/public/signup-status until the account is ready, then hands off to
 * the lexy app via a one-time loginToken exchange. Polling backs off to an
 * error state after POLL_TIMEOUT_MS so the user is never stuck spinning.
 */
import { usePageMeta } from "@/lib/seo";
import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldAlert, CheckCircle2 } from "lucide-react";

// API server is mounted by the platform at /api/* (see api-server artifact.toml).
const API = "";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

type Status = "polling" | "ready" | "expired" | "error";

export default function SignupSuccess() {
  usePageMeta({
    title: "You're In",
    description: "Signup successful.",
    path: "/signup-success",
    noIndex: true,
  });
  const [status, setStatus] = useState<Status>("polling");
  const [message, setMessage] = useState("");
  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ps = params.get("ps");
    if (!ps) {
      setStatus("error");
      setMessage("Signup reference is missing from the URL.");
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      if (cancelled) return;
      try {
        const res = await fetch(`${API}/api/public/signup-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pendingSignupId: ps }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (data.status === "ready" && data.loginToken) {
          setStatus("ready");
          // Hand off to the lexy app, which exchanges the loginToken for a session.
          window.location.replace(
            `/lexy/auth/trial-exchange?lt=${encodeURIComponent(data.loginToken)}`,
          );
          return;
        }
        if (data.status === "expired" || data.status === "not_found") {
          setStatus("expired");
          setMessage(
            "This signup link has expired or could not be found. Start a fresh signup to continue.",
          );
          return;
        }
        if (data.status === "already_used") {
          setStatus("ready");
          setMessage("Your account is already set up. Redirecting to sign in…");
          window.location.replace(`/lexy/login`);
          return;
        }

        if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
          setStatus("error");
          setMessage(
            "We're still finalising your account. Refresh in a moment, or sign in directly with the email and password you just entered.",
          );
          return;
        }
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err: any) {
        if (cancelled) return;
        if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
          setStatus("error");
          setMessage(err?.message ?? "Network error while finalising your account.");
          return;
        }
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center px-6 text-foreground">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center">
        {status === "polling" && (
          <>
            <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
            <h1 className="text-lg font-semibold mb-1">Setting up your workspace…</h1>
            <p className="text-sm text-muted-foreground">
              Payment confirmed. We're provisioning your tenant — this usually takes a few seconds.
            </p>
          </>
        )}
        {status === "ready" && (
          <>
            <CheckCircle2 className="w-8 h-8 text-primary mx-auto mb-4" />
            <h1 className="text-lg font-semibold mb-1">All set!</h1>
            <p className="text-sm text-muted-foreground">{message || "Signing you in…"}</p>
          </>
        )}
        {status === "expired" && (
          <>
            <ShieldAlert className="w-8 h-8 text-amber-400 mx-auto mb-4" />
            <h1 className="text-lg font-semibold mb-1">Signup link expired</h1>
            <p className="text-sm text-muted-foreground mb-5">{message}</p>
            <a
              href="/lexy-site/signup"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              Start over
            </a>
          </>
        )}
        {status === "error" && (
          <>
            <ShieldAlert className="w-8 h-8 text-amber-400 mx-auto mb-4" />
            <h1 className="text-lg font-semibold mb-1">Hang tight</h1>
            <p className="text-sm text-muted-foreground mb-5">{message}</p>
            <a
              href="/login"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              Go to sign in
            </a>
          </>
        )}
      </div>
    </div>
  );
}
