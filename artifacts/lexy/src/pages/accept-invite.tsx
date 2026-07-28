/**
 * pages/accept-invite.tsx — Candidate Portal Invite Acceptance Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The landing page for candidates who click their magic-link invite email.
 * Validates the token, creates their portal account, and redirects them to
 * the candidate portal dashboard.
 *
 * ─── Token states ────────────────────────────────────────────────────────────
 *   loading    — fetching token metadata from the API
 *   valid      — token is valid; showing "Accept & Enter Portal" CTA
 *   invalid    — token is expired or already used; shows error message
 *   accepting  — POST in progress
 *   done       — account created; redirecting to /portal
 *   error      — unexpected server error during acceptance
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 *   1. On mount: GET /api/accept-invite?token=<tok> to validate
 *   2. If valid: show candidate name + job title + "Accept" button
 *   3. On "Accept": POST /api/accept-invite { token } → { sessionToken, user }
 *   4. Store session token via useAuth().login()
 *   5. Redirect to /portal
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /accept-invite  (linked from candidate invite emails)
 */
import { useEffect, useState } from "react";
import { Zap, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type TokenState = "loading" | "valid" | "invalid" | "accepting" | "done" | "error";

export default function AcceptInvite() {
  const token = new URLSearchParams(window.location.search).get("token");
  const { login } = useAuth();

  const [state, setState]             = useState<TokenState>("loading");
  const [candidateName, setCandidateName] = useState("");
  const [errorMsg, setErrorMsg]       = useState("");

  useEffect(() => {
    if (!token) { setState("invalid"); setErrorMsg("No invite token found in this link."); return; }

    fetch(`${BASE}/api/invites/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.valid) {
          setCandidateName(data.candidateName ?? "Candidate");
          setState("valid");
        } else {
          setState("invalid");
          setErrorMsg(data.error ?? "This invite link is invalid or has expired.");
        }
      })
      .catch(() => { setState("invalid"); setErrorMsg("Failed to validate invite link."); });
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setState("accepting");
    try {
      const res = await fetch(`${BASE}/api/invites/${token}/accept`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setState("error"); setErrorMsg(data.error ?? "Failed to accept invite."); return; }
      login(data.user, data.token);
      setState("done");
      setTimeout(() => { window.location.href = `${BASE}/portal`; }, 1500);
    } catch {
      setState("error");
      setErrorMsg("Something went wrong. Please try again.");
    }
  };

  return (
    <div className="min-h-screen text-foreground flex flex-col">
      <header className="border-b border-border/50 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
            <Zap className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="font-bold tracking-tight">L3XY</span>
          <span className="text-muted-foreground text-sm">Candidate Portal</span>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-6 py-24">
        <div className="text-center max-w-sm w-full space-y-6">

          {(state === "loading") && (
            <>
              <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
              <p className="text-muted-foreground">Validating your invite link…</p>
            </>
          )}

          {state === "valid" && (
            <>
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                <Zap className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold mb-2">Welcome, {candidateName}!</h1>
                <p className="text-muted-foreground text-sm">
                  You've been invited to access your candidate portal. Click below to sign in and track your application status, schedule interviews, and prep for your interview.
                </p>
              </div>
              <Button className="w-full gap-2 shadow-lg shadow-primary/20" onClick={handleAccept}>
                <Zap className="w-4 h-4" /> Access my portal
              </Button>
            </>
          )}

          {state === "accepting" && (
            <>
              <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
              <p className="text-muted-foreground">Setting up your account…</p>
            </>
          )}

          {state === "done" && (
            <>
              <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold mb-2">All set!</h1>
                <p className="text-muted-foreground text-sm">Taking you to your portal…</p>
              </div>
            </>
          )}

          {(state === "invalid" || state === "error") && (
            <>
              <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                <XCircle className="w-8 h-8 text-destructive" />
              </div>
              <div>
                <h1 className="text-2xl font-bold mb-2">Link invalid</h1>
                <p className="text-muted-foreground text-sm">{errorMsg}</p>
              </div>
              <Button variant="outline" className="w-full" onClick={() => window.location.href = `${BASE}/portal/login`}>
                Go to candidate sign in
              </Button>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
