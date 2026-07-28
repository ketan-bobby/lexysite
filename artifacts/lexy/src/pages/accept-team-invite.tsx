/**
 * pages/accept-team-invite.tsx — Staff Invite Acceptance Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The landing page for recruiter / tenant_admin / hiring_manager / interviewer
 * users who receive a staff invite link from their admin. They set a password
 * here to complete their account creation.
 *
 * ─── Token states ────────────────────────────────────────────────────────────
 *   loading    — GET /api/staff-invites/:token to validate
 *   valid      — shows name + role + tenant + password form
 *   invalid    — token expired or used; error message
 *   accepting  — POST /api/staff-invites/:token/accept in progress
 *   done       — account created; logged in; redirecting to dashboard
 *   error      — unexpected server error
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 *   1. On mount: GET /api/staff-invites/:token → { email, role, tenantName }
 *   2. Show pre-filled email + role + "Set Password" form
 *   3. On submit: POST /api/staff-invites/:token/accept { password }
 *      → { token, user }
 *   4. useAuth().login(token, user) → redirect to role-appropriate dashboard
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /accept-team-invite?token=<tok>
 */
import { useEffect, useState } from "react";
import { Zap, CheckCircle2, XCircle, Loader2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const roleLabels: Record<string, string> = {
  tenant_admin:   "Admin",
  recruiter:      "Recruiter",
  hiring_manager: "Hiring Manager",
  interviewer:    "Interviewer",
};

const roleRedirects: Record<string, string> = {
  tenant_admin:   "/dashboard",
  recruiter:      "/dashboard",
  hiring_manager: "/hiring/dashboard",
  interviewer:    "/interviewer/interviews",
};

type State = "loading" | "valid" | "invalid" | "submitting" | "done" | "error";

export default function AcceptTeamInvite() {
  const token = new URLSearchParams(window.location.search).get("token");
  const { login } = useAuth();

  const [state, setState]     = useState<State>("loading");
  const [inviteData, setInviteData] = useState<any>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!token) { setState("invalid"); setErrorMsg("No invite token found in this link."); return; }

    fetch(`${BASE}/api/staff-invites/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.valid) {
          setInviteData(data);
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
    if (password.length < 8) {
      setErrorMsg("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setErrorMsg("Passwords do not match.");
      return;
    }
    setErrorMsg("");
    setState("submitting");
    try {
      const res = await fetch(`${BASE}/api/staff-invites/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) { setState("error"); setErrorMsg(data.error ?? "Failed to accept invite."); return; }
      login(data.user, data.token);
      setState("done");
      setTimeout(() => {
        window.location.href = `${BASE}${roleRedirects[data.user.role] ?? "/dashboard"}`;
      }, 1500);
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
          <span className="text-muted-foreground text-sm">Team Invite</span>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm space-y-6">

          {state === "loading" && (
            <div className="text-center space-y-4">
              <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
              <p className="text-muted-foreground">Validating your invite…</p>
            </div>
          )}

          {state === "valid" && (
            <>
              <div className="text-center space-y-2">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <Zap className="w-8 h-8 text-primary" />
                </div>
                <h1 className="text-2xl font-bold">You're invited!</h1>
                <p className="text-muted-foreground text-sm">
                  You've been invited to join the team as a{" "}
                  <span className="text-foreground font-medium">{roleLabels[inviteData?.role] ?? inviteData?.role}</span>.
                </p>
              </div>

              <div className="bg-muted/40 rounded-xl p-4 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Name</span>
                  <span className="font-medium">{inviteData?.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Email</span>
                  <span className="font-medium">{inviteData?.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Role</span>
                  <Badge variant="outline" className="text-primary border-primary/30 bg-primary/10 text-xs">
                    {roleLabels[inviteData?.role] ?? inviteData?.role}
                  </Badge>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <Label htmlFor="password" className="mb-1.5 block">Set your password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPw ? "text" : "password"}
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(!showPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <Label htmlFor="confirm" className="mb-1.5 block">Confirm password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    placeholder="Repeat your password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAccept()}
                  />
                </div>
                {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
                <Button className="w-full gap-2 shadow-lg shadow-primary/20" onClick={handleAccept}>
                  <Zap className="w-4 h-4" /> Create my account
                </Button>
              </div>
            </>
          )}

          {state === "submitting" && (
            <div className="text-center space-y-4">
              <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
              <p className="text-muted-foreground">Creating your account…</p>
            </div>
          )}

          {state === "done" && (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold mb-2">All set!</h1>
                <p className="text-muted-foreground text-sm">Taking you to your dashboard…</p>
              </div>
            </div>
          )}

          {(state === "invalid" || state === "error") && (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                <XCircle className="w-8 h-8 text-destructive" />
              </div>
              <div>
                <h1 className="text-2xl font-bold mb-2">Link invalid</h1>
                <p className="text-muted-foreground text-sm">{errorMsg}</p>
              </div>
              {state === "error" && (
                <Button variant="outline" className="w-full" onClick={() => { setState("valid"); setErrorMsg(""); }}>
                  Try again
                </Button>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
