/**
 * ResumeUploader.tsx — Candidate resume upload / attach component.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Provides a drag-and-drop (or click-to-browse) PDF/DOCX upload widget
 * scoped to a single candidate.  On upload it POSTs to object storage and then
 * attaches the returned object path to the candidate record.  Shows a download
 * link and a remove button when a resume is already attached.
 *
 * ── Props ─────────────────────────────────────────────────────────────────────
 *  candidateId   UUID of the candidate this resume belongs to
 *  resumeUrl     Existing resume object path (null if none uploaded yet)
 *  onUploaded    Optional callback receiving the new object path after upload
 *  compact       Renders a condensed single-line variant (default: full card)
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  POST /api/upload/resume              Multipart upload → returns { objectPath }
 *  POST /api/candidates/:id/resume      Attach objectPath to candidate record
 *  DELETE /api/candidates/:id/resume    Remove attached resume
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/candidates/[id].tsx  Candidate profile sidebar
 *  pages/portal/profile.tsx             Candidate self-service profile page
 */

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@workspace/react-hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Upload, FileText, Download, Trash2, CheckCircle2,
  AlertCircle, Loader2, FileSearch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ResumeUploaderProps {
  candidateId: string;
  resumeUrl: string | null | undefined;
  onUploaded?: (objectPath: string) => void;
  compact?: boolean;
}

function useAttachResume(candidateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (objectPath: string) => {
      const res = await fetch(`${BASE}/api/candidates/${candidateId}/resume`, {
        credentials: "include",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ objectPath }),
      });
      if (!res.ok) throw new Error("Failed to save resume URL");
      return res.json();
    },
    onSuccess: () => {
      // Refresh every query scoped to this candidate (profile, resume-screen,
      // talent-match, intelligence) — their keys all embed the candidateId.
      const refreshCandidate = () => {
        queryClient.invalidateQueries({
          predicate: (q) => JSON.stringify(q.queryKey).includes(candidateId),
        });
        queryClient.invalidateQueries({ queryKey: ["/api/candidates"] });
      };
      refreshCandidate();
      // The server re-screens the resume and rescores linked jobs in the
      // background (~10s of LLM calls). Re-invalidate a few times so the
      // Talent Match score refreshes once the rescore lands, without making
      // the upload itself block on it.
      [4000, 9000, 15000].forEach((ms) => setTimeout(refreshCandidate, ms));
    },
  });
}

function useDeleteResume(candidateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/candidates/${candidateId}/resume`, {
        credentials: "include",
        method: "DELETE",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to remove resume");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/candidates/${candidateId}`] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
    },
  });
}

export function ResumeUploader({ candidateId, resumeUrl, onUploaded, compact = false }: ResumeUploaderProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const attachResume = useAttachResume(candidateId);
  const deleteResume = useDeleteResume(candidateId);

  const uploadFile = async (file: File) => {
    setIsUploading(true);
    setProgress(20);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${BASE}/api/storage/uploads/file`, {
        method: "POST",
        body: fd,
      });
      setProgress(80);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed");
      }
      const data = await res.json() as { objectPath: string };
      await attachResume.mutateAsync(data.objectPath);
      setProgress(100);
      toast({ title: "Resume uploaded", description: `${file.name} saved successfully.` });
      onUploaded?.(data.objectPath);
    } catch (err) {
      const e = err instanceof Error ? err : new Error("Upload failed");
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const handleFile = (file: File) => {
    const allowed = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (!allowed.includes(file.type) && !file.name.match(/\.(pdf|doc|docx)$/i)) {
      toast({ title: "Invalid file type", description: "Please upload a PDF or Word document.", variant: "destructive" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum resume size is 10 MB.", variant: "destructive" });
      return;
    }
    setFileName(file.name);
    uploadFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleDelete = async () => {
    await deleteResume.mutateAsync();
    setFileName(null);
    toast({ title: "Resume removed", description: "The resume has been removed from this candidate." });
  };

  const downloadUrl = resumeUrl ? `${BASE}/api/storage${resumeUrl}` : null;

  const isBusy = isUploading || attachResume.isPending;

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {resumeUrl ? (
          <>
            <Badge variant="outline" className="gap-1.5 text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
              <CheckCircle2 className="w-3 h-3" /> Resume on file
            </Badge>
            <Button variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs" asChild>
              <a href={downloadUrl!} target="_blank" rel="noopener noreferrer">
                <Download className="w-3 h-3" /> Download
              </a>
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-destructive"
              onClick={handleDelete}
              disabled={deleteResume.isPending}
            >
              {deleteResume.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline" size="sm"
              className="h-7 px-3 gap-1.5 text-xs"
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
            >
              {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              {isBusy ? `Uploading…${progress}%` : "Upload Resume"}
            </Button>
            <input ref={fileInputRef} type="file" className="hidden" accept=".pdf,.doc,.docx"
              onChange={(e) => { e.target.files?.[0] && handleFile(e.target.files[0]); }} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {resumeUrl ? (
        <div className="flex items-center gap-4 p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-emerald-400">Resume on file</p>
            <p className="text-xs text-muted-foreground truncate">{resumeUrl.split("/").pop()}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" className="gap-1.5 text-xs border-emerald-500/30 hover:bg-emerald-500/10" asChild>
              <a href={downloadUrl!} target="_blank" rel="noopener noreferrer">
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => fileInputRef.current?.click()} disabled={isBusy}>
              <Upload className="w-3.5 h-3.5" /> Replace
            </Button>
            <Button
              variant="ghost" size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={handleDelete}
              disabled={deleteResume.isPending}
            >
              {deleteResume.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </Button>
          </div>
          <input ref={fileInputRef} type="file" className="hidden" accept=".pdf,.doc,.docx"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        </div>
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !isBusy && fileInputRef.current?.click()}
          className={cn(
            "flex flex-col items-center justify-center gap-3 p-8 rounded-xl border-2 border-dashed transition-all cursor-pointer",
            dragOver
              ? "border-primary bg-primary/10 scale-[1.01]"
              : "border-border/50 hover:border-primary/50 hover:bg-muted/30",
            isBusy && "cursor-default pointer-events-none opacity-75",
          )}
        >
          {isBusy ? (
            <>
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-primary animate-spin" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-sm">Uploading{fileName ? ` "${fileName}"` : ""}…</p>
                <p className="text-xs text-muted-foreground mt-1">Please wait</p>
              </div>
              <Progress value={progress} className="w-full max-w-xs h-1.5" />
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                <Upload className="w-6 h-6 text-primary" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-sm">Drop resume here or <span className="text-primary">browse</span></p>
                <p className="text-xs text-muted-foreground mt-1">PDF, DOC, DOCX · Max 10 MB</p>
              </div>
            </>
          )}
          <input
            ref={fileInputRef} type="file" className="hidden"
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </div>
      )}

      {!resumeUrl && !isBusy && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Upload a resume to enable AI screening — the Screening Agent analyzes it automatically.</span>
        </div>
      )}

      {resumeUrl && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <FileSearch className="w-3.5 h-3.5 text-primary shrink-0" />
          <span>AI Screening Agent will re-analyze on the next screening run.</span>
        </div>
      )}
    </div>
  );
}
