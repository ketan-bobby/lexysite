/**
 * SendToHiringManagerModal — email a branded candidate package to a hiring
 * manager who has no Lexy login. The recruiter picks what to include (contact
 * details, résumé, notes), writes an optional note, and sends. The backend
 * (`POST /api/hm-share`) creates a signed+expiring share, emails a no-login web
 * link, and attaches the evaluation PDF.
 *
 * The parent owns PDF-data assembly (it has the loaded candidate data) and
 * passes `buildPdfData(opts)` so the snapshot already respects the toggles.
 */
import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@workspace/react-hooks/use-toast";
import { getEvaluationPdfBase64, type EvaluationPdfData } from "@/lib/evaluation-pdf";
import { Send, Copy, Check, Mail } from "lucide-react";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type HmIncludeOpts = {
  includeContact: boolean;
  includeResume: boolean;
  includeNotes: boolean;
};

export function SendToHiringManagerModal({
  open, onOpenChange, candidateId, candidateName, jobId, buildPdfData, getApprovedReportPdf,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  candidateId: string;
  candidateName: string;
  jobId?: string | null;
  buildPdfData: (opts: HmIncludeOpts) => EvaluationPdfData;
  /** Supplies the structured client-facing evaluation report (generated on
   *  demand if needed) to attach instead of the legacy summary. Resolving to
   *  null means unavailable — the legacy PDF is attached instead. */
  getApprovedReportPdf?: () => Promise<{ base64: string; fileName: string } | null>;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [includeContact, setIncludeContact] = useState(false);
  const [includeResume, setIncludeResume] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [sending, setSending] = useState(false);
  const [resultLink, setResultLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setEmail(""); setName(""); setMessage("");
    setIncludeContact(false); setIncludeResume(true); setIncludeNotes(true);
    setResultLink(null); setCopied(false);
  };

  const handleSend = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      toast({ title: "Recipient required", description: "Enter the hiring manager's email.", variant: "destructive" });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast({ title: "Invalid email", description: "Enter a valid email address, e.g. manager@company.com.", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const opts: HmIncludeOpts = { includeContact, includeResume, includeNotes };
      const pdfData = buildPdfData(opts);
      const structured = getApprovedReportPdf ? await getApprovedReportPdf() : null;
      const { base64, fileName } = structured ?? (await getEvaluationPdfBase64(pdfData));
      const res = await fetch(`${BASE}/api/hm-share`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          candidateId,
          jobId: jobId ?? null,
          recipients: [{ email: email.trim(), name: name.trim() || undefined }],
          includeContact, includeResume, includeNotes,
          message: message.trim() || undefined,
          package: pdfData,
          pdf: { base64, fileName },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to send");
      const sent = data.sent?.[0];
      setResultLink(sent?.link ?? null);
      toast({
        title: sent?.emailed ? "Sent to hiring manager" : "Share created",
        description: sent?.emailed
          ? `A branded review link + PDF was emailed to ${email.trim()}.`
          : "Email couldn't be sent — copy the link below to share it manually.",
        variant: sent?.emailed ? undefined : "destructive",
      });
    } catch (err: any) {
      toast({ title: "Send failed", description: err.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const copyLink = async () => {
    if (!resultLink) return;
    await navigator.clipboard.writeText(resultLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-4 h-4" /> Send to hiring manager
          </DialogTitle>
          <DialogDescription>
            Email a branded, no-login review of <span className="font-medium">{candidateName}</span>. They can advance,
            request an interview, or pass — the decision flows straight back to your pipeline.
          </DialogDescription>
        </DialogHeader>

        {resultLink ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Share link (also emailed):</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={resultLink} className="text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={copyLink} className="gap-1.5 shrink-0">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => { onOpenChange(false); reset(); }}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="hm-email">Hiring manager email</Label>
                <Input id="hm-email" type="email" placeholder="manager@company.com"
                  value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hm-name">Name (optional)</Label>
                <Input id="hm-name" placeholder="Jane Smith"
                  value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hm-message">Note (optional)</Label>
              <Textarea id="hm-message" rows={3}
                placeholder="A short note to the hiring manager…"
                value={message} onChange={(e) => setMessage(e.target.value)} />
            </div>

            <div className="rounded-lg border border-border/60 divide-y divide-border/60">
              <ToggleRow label="Include contact details" hint="Email & phone on the profile"
                checked={includeContact} onChange={setIncludeContact} />
              <ToggleRow label="Attach résumé" hint="Adds résumé to email + download link"
                checked={includeResume} onChange={setIncludeResume} />
              <ToggleRow label="Include recruiter notes" hint="Your summary & screening notes"
                checked={includeNotes} onChange={setIncludeNotes} />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={handleSend} disabled={sending} className="gap-1.5">
                <Send className="w-3.5 h-3.5" />
                {sending ? "Sending…" : "Send package"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
