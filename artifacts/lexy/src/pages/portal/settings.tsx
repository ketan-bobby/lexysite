/**
 * pages/portal/settings.tsx — Candidate Portal Account Settings
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Account settings for logged-in candidates. Allows updating name, job title,
 * LinkedIn URL, and changing password. Also shows the connected email address
 * (read-only; set at account creation and used as the primary identity).
 *
 * ─── Sections ────────────────────────────────────────────────────────────────
 *   Profile          — name, current title, LinkedIn URL, location
 *   Security         — change password form (current + new + confirm)
 *   Notifications    — email notification preferences (interview reminders,
 *                      outreach replies, digest)
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET  /api/users/me         — current user profile
 *   PATCH /api/users/me        — update profile fields
 *   POST  /api/auth/change-password — password change
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /portal/settings
 */
import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { apiBase, apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, User, Briefcase, Link, AlertCircle, ShieldOff, X, Plus } from "lucide-react";

interface CandidateInfo {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
}

export default function PortalSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    location: "",
    linkedinUrl: "",
    githubUrl: "",
  });

  /* Privacy state — backed by GET/PUT /portal/privacy. Kept separate from
     the main profile form because the API path is separate and the save
     button below saves both atomically. */
  const [privacy, setPrivacy] = useState({
    discoveryPaused: false,
    hideFromCurrentEmployer: false,
    currentEmployerDomain: "",
    blockedCompanyDomains: [] as string[],
    matchOnlyVisibility: false,
  });
  const [newBlockedDomain, setNewBlockedDomain] = useState("");

  /* Platform-discovery opt-in — backed by GET/POST/DELETE
     /portal/candidate/discovery. Deliberately NOT part of the save form:
     it is a logged consent action (like AI-interview consent), so the
     toggle takes effect immediately with its own confirmation. */
  const [discovery, setDiscovery] = useState<{ active: boolean; loaded: boolean; busy: boolean }>({
    active: false, loaded: false, busy: false,
  });

  useEffect(() => {
    apiFetch(`${apiBase}/portal/candidate/discovery`)
      .then(r => r.json())
      .then(d => setDiscovery(s => ({ ...s, active: !!d.discoverable, loaded: true })))
      .catch(() => setDiscovery(s => ({ ...s, loaded: true })));
  }, []);

  async function toggleDiscovery() {
    if (discovery.busy) return;
    const next = !discovery.active;
    if (next && !window.confirm(
      "Make your profile discoverable to other companies?\n\n" +
      "Your profile (name, title, skills, experience) becomes visible to recruiters at licensed companies across Lexy — not just the company you applied to or that invited you — and they may contact you about matching roles.\n\n" +
      "Your interview recordings, scores, and evaluations are never shared. You can turn this off at any time."
    )) return;
    setDiscovery(s => ({ ...s, busy: true }));
    try {
      const res = next
        ? await apiFetch(`${apiBase}/portal/candidate/discovery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ consent: true, surface: "settings" }),
          })
        : await apiFetch(`${apiBase}/portal/candidate/discovery`, { method: "DELETE" });
      if (res.ok) setDiscovery(s => ({ ...s, active: next, busy: false }));
      else setDiscovery(s => ({ ...s, busy: false }));
    } catch {
      setDiscovery(s => ({ ...s, busy: false }));
    }
  }

  useEffect(() => {
    Promise.all([
      apiFetch(`${apiBase}/portal/candidate/me`).then(r => r.json()).catch(() => ({ data: null })),
      apiFetch(`${apiBase}/portal/privacy`).then(r => r.json()).catch(() => ({})),
    ])
      .then(([{ data }, priv]) => {
        if (data) {
          setForm({
            firstName:   data.firstName   ?? "",
            lastName:    data.lastName    ?? "",
            email:       data.email       ?? "",
            phone:       data.phone       ?? "",
            location:    data.location    ?? "",
            linkedinUrl: data.linkedinUrl ?? "",
            githubUrl:   data.githubUrl   ?? "",
          });
        }
        if (priv && typeof priv === "object") {
          setPrivacy({
            discoveryPaused:         !!priv.discoveryPaused,
            hideFromCurrentEmployer: !!priv.hideFromCurrentEmployer,
            currentEmployerDomain:   priv.currentEmployerDomain ?? "",
            blockedCompanyDomains:   Array.isArray(priv.blockedCompanyDomains) ? priv.blockedCompanyDomains : [],
            matchOnlyVisibility:     !!priv.matchOnlyVisibility,
          });
        }
      })
      .catch(() => setError("Could not load your profile. Please try again."))
      .finally(() => setLoading(false));
  }, []);

  function addBlockedDomain() {
    const d = newBlockedDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (!d) return;
    setSaved(false);
    setPrivacy(p => p.blockedCompanyDomains.includes(d) ? p
      : { ...p, blockedCompanyDomains: [...p.blockedCompanyDomains, d] });
    setNewBlockedDomain("");
  }
  function removeBlockedDomain(d: string) {
    setSaved(false);
    setPrivacy(p => ({ ...p, blockedCompanyDomains: p.blockedCompanyDomains.filter(x => x !== d) }));
  }

  function field(key: keyof typeof form) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setSaved(false);
        setForm(f => ({ ...f, [key]: e.target.value }));
      },
    };
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const [profileRes, privacyRes] = await Promise.all([
        apiFetch(`${apiBase}/portal/candidate/me`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName:   form.firstName   || undefined,
            lastName:    form.lastName    || undefined,
            phone:       form.phone       || undefined,
            location:    form.location    || undefined,
            linkedinUrl: form.linkedinUrl || undefined,
            githubUrl:   form.githubUrl   || undefined,
          }),
        }),
        apiFetch(`${apiBase}/portal/privacy`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(privacy),
        }),
      ]);
      if (!profileRes.ok || !privacyRes.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[40vh]">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Account Settings</h1>
          <p className="text-sm text-muted-foreground">Manage your personal details and contact information.</p>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-400/10 border border-red-400/20 text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-5">
          {/* Personal Info */}
          <Card className="border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-primary/10 rounded-lg text-primary">
                  <User className="w-4 h-4" />
                </div>
                <CardTitle className="text-base">Personal Information</CardTitle>
              </div>
              <CardDescription className="text-xs">Your name and contact details.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="firstName" className="text-xs font-medium">First name</Label>
                  <Input id="firstName" placeholder="Jane" {...field("firstName")} className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lastName" className="text-xs font-medium">Last name</Label>
                  <Input id="lastName" placeholder="Smith" {...field("lastName")} className="h-9" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Email address</Label>
                <Input value={form.email} disabled className="h-9 opacity-60 cursor-not-allowed" />
                <p className="text-[11px] text-muted-foreground/60">Email cannot be changed from here.</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="phone" className="text-xs font-medium">Phone number</Label>
                <Input id="phone" placeholder="+1 555 000 0000" {...field("phone")} className="h-9" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="location" className="text-xs font-medium">Location</Label>
                <Input id="location" placeholder="San Francisco, CA" {...field("location")} className="h-9" />
              </div>
            </CardContent>
          </Card>

          {/* Online Profiles */}
          <Card className="border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-primary/10 rounded-lg text-primary">
                  <Link className="w-4 h-4" />
                </div>
                <CardTitle className="text-base">Online Profiles</CardTitle>
              </div>
              <CardDescription className="text-xs">Helps Lexy surface better matches and personalise your experience.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="linkedin" className="text-xs font-medium">LinkedIn URL</Label>
                <Input
                  id="linkedin"
                  placeholder="https://linkedin.com/in/yourname"
                  {...field("linkedinUrl")}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="github" className="text-xs font-medium">GitHub URL</Label>
                <Input
                  id="github"
                  placeholder="https://github.com/yourhandle"
                  {...field("githubUrl")}
                  className="h-9"
                />
              </div>
            </CardContent>
          </Card>

          {/* Privacy & Visibility */}
          <Card className="border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-primary/10 rounded-lg text-primary">
                  <ShieldOff className="w-4 h-4" />
                </div>
                <CardTitle className="text-base">Privacy &amp; Visibility</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Stay invisible to companies you don't want seeing your profile. Lexy will not surface you in any
                search or recommendation from these companies — they will never know you exist on the platform.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Platform-discovery opt-in — explicit, logged consent.
                  Off by default for EVERY intake path (apply / invite /
                  self-register); only this toggle makes the profile
                  discoverable to other licensed companies. */}
              <div className={`flex items-start justify-between gap-4 p-3 rounded-lg border-2 ${discovery.active ? "border-emerald-400/40 bg-emerald-400/5" : "border-border/40 bg-muted/20"}`}>
                <div className="space-y-0.5">
                  <Label htmlFor="discoveryOptIn" className="text-sm font-semibold cursor-pointer flex items-center gap-2">
                    Make my profile discoverable to other companies
                    {discovery.active && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-300 border border-emerald-400/40">
                        Discoverable
                      </span>
                    )}
                  </Label>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    When on, recruiters at licensed companies across Lexy — beyond the company you applied to
                    or that invited you — can find your profile and contact you about matching roles. Your
                    interview recordings, scores, and evaluations are never shared. Off by default; your
                    choice is recorded, and you can withdraw it here at any time.
                  </p>
                </div>
                <button
                  type="button"
                  id="discoveryOptIn"
                  role="switch"
                  aria-checked={discovery.active}
                  disabled={!discovery.loaded || discovery.busy}
                  onClick={toggleDiscovery}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors mt-0.5 disabled:opacity-50
                    ${discovery.active ? "bg-emerald-400" : "bg-muted-foreground/30"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform mt-0.5
                    ${discovery.active ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>

              {/* Master "Pause discovery" — brochure Privacy slide:
                  "Stay invisible until you're ready." Hides the candidate
                  from every recruiter discovery surface, regardless of
                  any other privacy setting below. */}
              <div className={`flex items-start justify-between gap-4 p-3 rounded-lg border-2 ${privacy.discoveryPaused ? "border-amber-400/40 bg-amber-400/5" : "border-border/40 bg-muted/20"}`}>
                <div className="space-y-0.5">
                  <Label htmlFor="discoveryPaused" className="text-sm font-semibold cursor-pointer flex items-center gap-2">
                    Pause discovery
                    {privacy.discoveryPaused && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/40">
                        Invisible
                      </span>
                    )}
                  </Label>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Stay invisible until you're ready. While paused, you won't appear in any recruiter
                    search or recommendation — anywhere on Lexy. Recruiters you've already applied to
                    or interviewed with can still see you (you started those conversations).
                  </p>
                </div>
                <button
                  type="button"
                  id="discoveryPaused"
                  role="switch"
                  aria-checked={privacy.discoveryPaused}
                  onClick={() => { setSaved(false); setPrivacy(p => ({ ...p, discoveryPaused: !p.discoveryPaused })); }}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors mt-0.5
                    ${privacy.discoveryPaused ? "bg-amber-400" : "bg-muted-foreground/30"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform mt-0.5
                    ${privacy.discoveryPaused ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>

              {/* Hide-from-current-employer */}
              <div className="flex items-start justify-between gap-4 p-3 rounded-lg border border-border/40 bg-muted/20">
                <div className="space-y-0.5">
                  <Label htmlFor="hideEmployer" className="text-sm font-medium cursor-pointer">
                    Hide my profile from my current employer
                  </Label>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Recruiters from this domain will never see you in search results.
                  </p>
                </div>
                <button
                  type="button"
                  id="hideEmployer"
                  role="switch"
                  aria-checked={privacy.hideFromCurrentEmployer}
                  onClick={() => { setSaved(false); setPrivacy(p => ({ ...p, hideFromCurrentEmployer: !p.hideFromCurrentEmployer })); }}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors mt-0.5
                    ${privacy.hideFromCurrentEmployer ? "bg-primary" : "bg-muted-foreground/30"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform mt-0.5
                    ${privacy.hideFromCurrentEmployer ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="employerDomain" className="text-xs font-medium">Your current employer's domain</Label>
                <Input
                  id="employerDomain"
                  placeholder="acme.com"
                  value={privacy.currentEmployerDomain}
                  onChange={e => { setSaved(false); setPrivacy(p => ({ ...p, currentEmployerDomain: e.target.value })); }}
                  className="h-9"
                />
                <p className="text-[11px] text-muted-foreground/70">
                  e.g. <code>acme.com</code> — we match recruiter tenants by website &amp; email domain.
                  {!privacy.hideFromCurrentEmployer && " Hiding is off — turn on the toggle above to hide your profile from this employer."}
                </p>
              </div>

              {/* Per-company opt-out blocklist */}
              <div className="space-y-2 pt-2 border-t border-border/40">
                <div>
                  <Label className="text-xs font-medium">Other companies I want to block</Label>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    Add the domains of any companies you don't want to be visible to (max 50).
                  </p>
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="competitor.com"
                    value={newBlockedDomain}
                    onChange={e => setNewBlockedDomain(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addBlockedDomain(); } }}
                    className="h-9"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={addBlockedDomain} className="h-9 gap-1 shrink-0">
                    <Plus className="w-3.5 h-3.5" /> Add
                  </Button>
                </div>
                {privacy.blockedCompanyDomains.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {privacy.blockedCompanyDomains.map(d => (
                      <span key={d} className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-red-400/10 border border-red-400/30 text-red-300">
                        {d}
                        <button type="button" onClick={() => removeBlockedDomain(d)} className="hover:text-red-200" aria-label={`Remove ${d}`}>
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground/60 pt-1">No companies blocked yet.</p>
                )}
              </div>

              {/* Match-only visibility — brochure Privacy slide promise:
                  "Show your profile only to recruiters whose roles genuinely match." */}
              <div className="flex items-start justify-between gap-4 p-3 rounded-lg border border-border/40 bg-muted/20 mt-2">
                <div className="space-y-0.5">
                  <Label htmlFor="matchOnly" className="text-sm font-medium cursor-pointer">
                    Only show me to recruiters with a matching open role
                  </Label>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Lexy will hide you from recruiters whose open jobs don't overlap with your target roles.
                    Curated, high-signal outreach only — no recruiter spam.
                  </p>
                </div>
                <button
                  type="button"
                  id="matchOnly"
                  role="switch"
                  aria-checked={privacy.matchOnlyVisibility}
                  onClick={() => { setSaved(false); setPrivacy(p => ({ ...p, matchOnlyVisibility: !p.matchOnlyVisibility })); }}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors mt-0.5
                    ${privacy.matchOnlyVisibility ? "bg-primary" : "bg-muted-foreground/30"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform mt-0.5
                    ${privacy.matchOnlyVisibility ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>
            </CardContent>
          </Card>

          {/* Save */}
          <div className="flex items-center justify-between">
            {saved ? (
              <div className="flex items-center gap-2 text-sm text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                Changes saved
              </div>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={saving} className="gap-2 px-8">
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
