/**
 * GenerateMessageDialog — generate → review → approve / save-as-example (T009).
 *
 * Lets a recruiter pick a message type + tone, generate an AI draft for a given
 * job/candidate, see the "context used / why this message" summary, edit it, and
 * approve or save it as a reusable example. Approved candidate-facing drafts can
 * be dispatched; nothing is ever sent without a human action.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Sparkles, Loader2, Check, BookmarkPlus, Info } from "lucide-react";
import { aiFetch, AI_TONES, AI_MESSAGE_TYPES } from "@/lib/ai-intel-api";

interface Generation {
  id: string;
  messageType: string;
  tone: string | null;
  subject: string | null;
  body: string;
  status: string;
  contextSummary: string | null;
  sourceContext?: any;
  candidateId?: string | null;
}

export function GenerateMessageDialog({
  jobId,
  candidateId,
  tenantId,
  trigger,
}: {
  jobId?: string | null;
  candidateId?: string | null;
  tenantId?: string | null;
  trigger?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [messageType, setMessageType] = useState("outreach");
  const [tone, setTone] = useState<string>("");
  const [extra, setExtra] = useState("");
  const [gen, setGen] = useState<Generation | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const typeMeta = AI_MESSAGE_TYPES.find((t) => t.value === messageType);

  function reset() {
    setGen(null);
    setSubject("");
    setBody("");
    setExtra("");
  }

  const generateMut = useMutation({
    mutationFn: () =>
      aiFetch<{ generation: Generation }>(`/ai-messages/generate`, {
        method: "POST",
        body: JSON.stringify({
          messageType,
          jobId: jobId ?? undefined,
          candidateId: candidateId ?? undefined,
          tenantId: tenantId ?? undefined,
          tone: tone || undefined,
          extraInstructions: extra || undefined,
        }),
      }),
    onSuccess: ({ generation }) => {
      setGen(generation);
      setSubject(generation.subject ?? "");
      setBody(generation.body ?? "");
      qc.invalidateQueries({ queryKey: ["ai-queue"] });
    },
    onError: (e: any) => {
      toast({
        title: e.code === "ai_disabled" ? "AI is turned off for this tenant" : "Generation failed",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const saveEditMut = useMutation({
    mutationFn: () =>
      aiFetch<{ generation: Generation }>(`/ai-messages/${gen!.id}`, {
        method: "PATCH",
        body: JSON.stringify({ subject, body }),
      }),
    onSuccess: ({ generation }) => {
      setGen(generation);
      toast({ title: "Draft updated" });
      qc.invalidateQueries({ queryKey: ["ai-queue"] });
    },
  });

  const approveMut = useMutation({
    mutationFn: () => aiFetch(`/ai-messages/${gen!.id}/approve`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      toast({ title: "Approved", description: "It's now in the approved queue." });
      qc.invalidateQueries({ queryKey: ["ai-queue"] });
      setOpen(false);
      reset();
    },
  });

  const exampleMut = useMutation({
    mutationFn: () => aiFetch(`/ai-messages/${gen!.id}/save-as-example`, { method: "POST", body: "{}" }),
    onSuccess: () => toast({ title: "Saved as example", description: "Future drafts will learn from it." }),
  });

  const dirty = gen && (subject !== (gen.subject ?? "") || body !== (gen.body ?? ""));

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button className="gap-2"><Sparkles className="w-4 h-4" /> Generate AI message</Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" /> Generate AI message
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Message type</Label>
              <Select value={messageType} onValueChange={setMessageType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AI_MESSAGE_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tone (optional — defaults to brand tone)</Label>
              <Select value={tone} onValueChange={setTone}>
                <SelectTrigger><SelectValue placeholder="Brand default" /></SelectTrigger>
                <SelectContent>
                  {AI_TONES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Extra instructions (optional)</Label>
            <Textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="e.g. mention the upcoming team offsite" />
          </div>

          {!typeMeta?.candidateFacing && (
            <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>This is an internal artifact (not sent to candidates). It can be approved and copied, but not emailed.</span>
            </div>
          )}

          <Button className="w-full gap-2" disabled={generateMut.isPending} onClick={() => generateMut.mutate()}>
            {generateMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {gen ? "Regenerate" : "Generate draft"}
          </Button>

          {gen && (
            <div className="space-y-3 border-t border-border pt-4">
              {gen.contextSummary && (
                <div className="rounded-lg bg-primary/5 border border-primary/15 p-3">
                  <p className="text-[11px] font-semibold text-primary flex items-center gap-1 mb-1">
                    <Info className="w-3 h-3" /> Context used — why this message
                  </p>
                  <p className="text-xs text-muted-foreground">{gen.contextSummary}</p>
                </div>
              )}

              {(gen.subject !== null || typeMeta?.candidateFacing) && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Subject</Label>
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Body</Label>
                <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-sm" />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="capitalize">{gen.status}</Badge>
                {dirty && (
                  <Button size="sm" variant="outline" disabled={saveEditMut.isPending} onClick={() => saveEditMut.mutate()}>
                    {saveEditMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save edits"}
                  </Button>
                )}
                <div className="flex-1" />
                <Button size="sm" variant="outline" className="gap-1.5" disabled={exampleMut.isPending} onClick={() => exampleMut.mutate()}>
                  <BookmarkPlus className="w-3.5 h-3.5" /> Save as example
                </Button>
                <Button size="sm" className="gap-1.5" disabled={approveMut.isPending || !!dirty} onClick={() => approveMut.mutate()}>
                  {approveMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
                </Button>
              </div>
              {dirty && <p className="text-[11px] text-amber-600">Save your edits before approving.</p>}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
