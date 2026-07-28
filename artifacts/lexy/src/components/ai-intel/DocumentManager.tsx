/**
 * DocumentManager — upload / list / delete knowledge documents for either a
 * tenant brand profile or a workorder. On upload the server distills the doc into
 * a bounded brief (shown inline); only that brief is ever fed to the AI.
 */
import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import { FileText, Trash2, Upload, Loader2, Sparkles } from "lucide-react";
import { format, parseISO } from "date-fns";
import { aiFetch, aiUpload, AI_DOC_TYPES } from "@/lib/ai-intel-api";

interface AiDoc {
  id: string;
  docType: string;
  fileName: string;
  contentType: string | null;
  distilledBrief: string | null;
  createdAt: string;
}

export function DocumentManager({
  scope,
  scopeId,
  defaultDocType = "other",
}: {
  scope: "tenants" | "jobs";
  scopeId: string;
  defaultDocType?: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState(defaultDocType);
  const queryKey = ["ai-documents", scope, scopeId];

  const { data, isLoading } = useQuery<{ documents: AiDoc[] }>({
    queryKey,
    queryFn: () => aiFetch(`/${scope}/${scopeId}/ai-documents`),
    enabled: !!scopeId,
  });
  const docs = data?.documents ?? [];

  const uploadMut = useMutation({
    mutationFn: (file: File) =>
      aiUpload(`/${scope}/${scopeId}/ai-documents`, file, { docType }),
    onSuccess: () => {
      toast({ title: "Document uploaded & distilled" });
      qc.invalidateQueries({ queryKey });
    },
    onError: (e: any) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      aiFetch(`/${scope}/${scopeId}/ai-documents/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Document removed" });
      qc.invalidateQueries({ queryKey });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Document type</label>
          <Select value={docType} onValueChange={setDocType}>
            <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              {AI_DOC_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,.md,.csv,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadMut.mutate(f);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={uploadMut.isPending}
          onClick={() => fileRef.current?.click()}
        >
          {uploadMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Upload document
        </Button>
        <p className="text-xs text-muted-foreground">PDF, DOCX, TXT, MD — up to 15 MB. We distill it into a brief; the raw file is never sent to the model.</p>
      </div>

      <div className="space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">Loading documents…</p>}
        {!isLoading && docs.length === 0 && (
          <p className="text-sm text-muted-foreground">No documents yet.</p>
        )}
        {docs.map((d) => (
          <div key={d.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <FileText className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{d.fileName}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge variant="secondary" className="text-[10px] capitalize">
                      {AI_DOC_TYPES.find((t) => t.value === d.docType)?.label ?? d.docType}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {d.createdAt ? format(parseISO(d.createdAt), "MMM d, yyyy") : ""}
                    </span>
                  </div>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-red-500 hover:text-red-600"
                onClick={() => deleteMut.mutate(d.id)}
                disabled={deleteMut.isPending}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
            {d.distilledBrief ? (
              <div className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/50 p-2">
                <Sparkles className="w-3 h-3 mt-0.5 text-primary shrink-0" />
                <p className="text-xs text-muted-foreground line-clamp-4">{d.distilledBrief}</p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-amber-600">No brief was extracted (document may be empty or unreadable).</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
