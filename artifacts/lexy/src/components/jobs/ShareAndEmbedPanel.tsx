/**
 * ShareAndEmbedPanel.tsx — Public job posting share and embed panel.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Gives recruiters three ways to distribute a published job opening:
 *   1. Direct link — careers-portal URL for the specific job
 *   2. Widget embed — a one-line <script> snippet for embedding an apply button
 *      on any external website
 *   3. iFrame embed — full job-detail embed for ATS / career-page integration
 * Each option has a one-click copy button and a live-preview "Open" link.
 * The panel is disabled (greyed out with a warning) if the job is not published.
 *
 * ── Props ─────────────────────────────────────────────────────────────────────
 *  jobId      UUID of the job
 *  jobTitle   Display title used in the panel heading
 *  jobStatus  "published" | "draft" | other — gates the copy controls
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/jobs/[id].tsx    Job detail — Share & Embed tab
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Check, Copy, Globe, Code2, Zap, ExternalLink, Share2, Link2, FileCode2 } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Props {
  jobId: string;
  jobTitle: string;
  jobStatus: string;
}

function CopyBlock({ label, value, description }: { label: string; value: string; description?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">{label}</p>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
          className={cn(
            "gap-1.5 text-xs h-7 transition-colors",
            copied ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10" : "",
          )}
        >
          {copied ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy</>}
        </Button>
      </div>
      <pre className="text-xs bg-muted/50 border border-border/50 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed text-muted-foreground">
        {value}
      </pre>
    </div>
  );
}

export function ShareAndEmbedPanel({ jobId, jobTitle, jobStatus }: Props) {
  const { toast } = useToast();
  const origin = window.location.origin;
  const applyUrl = `${origin}${BASE}/careers/${jobId}`;
  const embedUrl = `${origin}${BASE}/careers/${jobId}?embed=1`;

  const iframeSnippet = `<!-- Lexy AI Apply Form — ${jobTitle} -->
<iframe
  src="${embedUrl}"
  width="100%"
  height="820"
  frameborder="0"
  allow="camera; microphone"
  style="border:none; border-radius:12px; overflow:hidden;"
  title="Apply for ${jobTitle}"
></iframe>`;

  const jsWidgetSnippet = `<!-- Lexy Apply Button — paste before </body> -->
<a
  href="${applyUrl}"
  target="_blank"
  rel="noopener"
  style="
    display:inline-flex; align-items:center; gap:8px;
    background:#7c3aed; color:#fff; font-weight:600;
    padding:12px 24px; border-radius:8px;
    text-decoration:none; font-family:sans-serif; font-size:15px;
  "
>
  ⚡ Apply Now — ${jobTitle}
</a>`;

  const isActive = jobStatus === "active";

  return (
    <div className="space-y-6">
      {/* Status banner */}
      {!isActive && (
        <Card className="border-amber-500/30 bg-amber-500/8">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Zap className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-400">Work Order is not yet published</p>
                <p className="text-xs text-muted-foreground mt-1">
                  This WO is currently <strong>{jobStatus.replace("_", " ")}</strong>. Links below work, but the job won't appear on the public board until it's approved and marked Active. You can still share the direct link with specific candidates.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {isActive && (
        <Card className="border-emerald-500/30 bg-emerald-500/8">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
                <Globe className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-emerald-400">Live on public job board</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  This position is active and visible on the Lexy careers page. All applicants are automatically captured.
                </p>
              </div>
              <a href={applyUrl} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="outline" className="gap-1.5 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10">
                  <ExternalLink className="w-3.5 h-3.5" /> Preview
                </Button>
              </a>
            </div>
          </CardContent>
        </Card>
      )}

      {/* How it works */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Share2 className="w-4 h-4 text-primary" /> How candidate capture works
          </CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Every apply link and embed form routes candidates through Lexy's AI interview pipeline. Applications are saved automatically — no integration required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {[
              { step: "1", title: "Candidate applies", desc: "Via your site, email, or social post" },
              { step: "2", title: "AI screens them", desc: "Resume + interview in minutes" },
              { step: "3", title: "Saved in Lexy", desc: "Appears in your pipeline instantly" },
            ].map(item => (
              <div key={item.step} className="rounded-lg border border-white/8 bg-white/3 p-3 space-y-1">
                <div className="w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center">
                  {item.step}
                </div>
                <p className="text-sm font-semibold">{item.title}</p>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Direct Apply Link */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="w-4 h-4 text-primary" /> Direct Apply Link
            <Badge variant="secondary" className="text-xs ml-auto">Easiest</Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            Share this anywhere — LinkedIn, email, job boards, Slack, WhatsApp. Anyone who opens it can apply directly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyBlock
            label="Apply link"
            value={applyUrl}
            description="Paste on LinkedIn posts, job boards, email signatures, or anywhere you promote this role"
          />
        </CardContent>
      </Card>

      {/* Iframe Embed */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Code2 className="w-4 h-4 text-primary" /> Embed on your career page
            <Badge variant="secondary" className="text-xs ml-auto">Recommended</Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            Paste the snippet below into your company's career page HTML. The apply form loads inline — no Lexy branding, just the form. All applicants land directly in your pipeline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyBlock
            label="Iframe snippet"
            value={iframeSnippet}
            description="Paste inside your career page HTML where you want the form to appear. Works in any CMS or website builder."
          />
          <div className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-1">
            <p className="text-xs font-semibold text-muted-foreground">Embed tips</p>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
              <li>The form adapts to 100% width — set the container width as needed</li>
              <li>Height <strong>820px</strong> fits the full form; reduce if your layout is tight</li>
              <li>If candidates use voice interviews, grant <strong>microphone</strong> permission in the iframe's <code>allow</code> attribute</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* JS Button Widget */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileCode2 className="w-4 h-4 text-primary" /> Apply button widget
          </CardTitle>
          <CardDescription className="text-xs">
            A simple styled button that opens the apply page in a new tab. Copy and paste into any HTML page — no dependencies needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyBlock
            label="Button HTML"
            value={jsWidgetSnippet}
            description="Paste anywhere in your page body — a ready-styled Apply Now button appears"
          />
        </CardContent>
      </Card>

      {/* ATS note */}
      <Card className="border-white/8 bg-white/3">
        <CardContent className="pt-5 pb-4">
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">Already have an ATS?</strong> You don't need to migrate. Use the link or embed above — Lexy captures the candidate and AI-screens them, and you can export the shortlist back to your existing system. Contact your Lexy admin to set up automatic syncing.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
