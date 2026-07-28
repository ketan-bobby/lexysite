/**
 * components/candidates/CsvImportDialog.tsx — Bulk Candidate CSV Import Dialog
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * A three-step modal that walks a recruiter through importing a CSV batch of
 * candidates. Handles drag-and-drop file selection, client-side CSV parsing,
 * validation, server submission, and a results summary.
 *
 * ─── Three steps ─────────────────────────────────────────────────────────────
 *   1. Upload   — drag-and-drop or click-to-browse; template CSV download link
 *   2. Preview  — table of parsed rows with per-row validation highlights
 *                 (required fields missing, duplicate email, etc.)
 *   3. Results  — created / skipped / error counts with per-row detail
 *
 * ─── Data flow ───────────────────────────────────────────────────────────────
 *   Client parses the CSV using a lightweight hand-rolled parser (no Papa Parse
 *   dependency). Valid rows are submitted to POST /api/candidates/import as JSON.
 *   On success the candidates query cache is invalidated.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   pages/recruiter/import.tsx   — primary import page
 *   pages/recruiter/candidates/index.tsx — "Import" button in candidates list
 */

import { useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Upload, Download, FileText, CheckCircle2, AlertTriangle, X,
  Loader2, Users, SkipForward, XCircle, ChevronRight,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/* ── CSV template ─────────────────────────────────────────────────────────── */
const TEMPLATE_HEADERS = [
  "firstName", "lastName", "email", "phone",
  "currentTitle", "currentCompany", "location",
  "linkedinUrl", "skills", "source", "isCurrentEmployee",
];

const TEMPLATE_EXAMPLE_ROWS = [
  ["Jane", "Doe", "jane.doe@example.com", "+1 415 555 0100",
   "Senior Engineer", "Acme Corp", "San Francisco CA",
   "https://linkedin.com/in/janedoe", "TypeScript,React,Node.js", "linkedin", "true"],
  ["John", "Smith", "john.smith@example.com", "",
   "Product Manager", "Beta Inc", "New York NY",
   "", "Product Strategy,SQL,Figma", "referral", "false"],
];

function downloadTemplate() {
  const rows = [TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLE_ROWS]
    .map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([rows], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "lexy_candidates_template.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── CSV parser ───────────────────────────────────────────────────────────── */
type ParsedRow = Record<string, string> & { _rowNum: number; _errors: string[] };

function parseCsvText(text: string): { headers: string[]; rows: ParsedRow[]; error?: string } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines.length < 2) return { headers: [], rows: [], error: "CSV must have a header row and at least one data row." };

  function splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  const headers = splitCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ""));
  if (!headers.includes("firstname") || !headers.includes("lastname") || !headers.includes("email")) {
    return { headers, rows: [], error: "CSV must include columns: firstName, lastName, email" };
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = splitCsvLine(line);
    const row = { _rowNum: i, _errors: [] as string[] } as ParsedRow;
    headers.forEach((h, idx) => { row[h] = cells[idx] ?? ""; });

    if (!row.firstname) row._errors.push("firstName required");
    if (!row.lastname) row._errors.push("lastName required");
    if (!row.email) row._errors.push("email required");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) row._errors.push("invalid email");

    rows.push(row);
  }

  return { headers, rows };
}

function mapRowToPayload(row: ParsedRow) {
  const rawEmployee = row.iscurrentemployee ?? (row as any).isCurrentEmployee;
  return {
    firstName:      row.firstname ?? row.firstName ?? "",
    lastName:       row.lastname  ?? row.lastName  ?? "",
    email:          row.email ?? "",
    phone:          row.phone ?? "",
    currentTitle:   row.currenttitle   ?? row.currentTitle   ?? "",
    currentCompany: row.currentcompany ?? row.currentCompany ?? "",
    location:       row.location ?? "",
    linkedinUrl:    row.linkedinurl ?? row.linkedinUrl ?? "",
    githubUrl:      row.githuburl  ?? row.githubUrl   ?? "",
    skills:         row.skills ?? "",
    source:         row.source || "manual_import",
    // Per-row override: only send when the column is present so it doesn't
    // clobber the dialog's top-level isCurrentEmployee default. The backend
    // coerces "true"/"1"/true → true.
    ...(rawEmployee !== undefined && rawEmployee !== "" ? { isCurrentEmployee: rawEmployee } : {}),
  };
}

/* ── Step components ──────────────────────────────────────────────────────── */
function UploadStep({
  onParsed, onClose,
}: {
  onParsed: (rows: ParsedRow[], headers: string[]) => void;
  onClose: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    if (!file.name.endsWith(".csv") && file.type !== "text/csv") {
      setParseError("Please upload a .csv file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers, rows, error } = parseCsvText(text);
      if (error) { setParseError(error); return; }
      setParseError(null);
      onParsed(rows, headers);
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-5">
      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all",
          dragging ? "border-primary bg-primary/10" : "border-border/50 hover:border-primary/50 hover:bg-primary/5",
        )}
      >
        <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm font-semibold">Drop your CSV here or click to browse</p>
        <p className="text-xs text-muted-foreground mt-1">Supports .csv files up to 500 candidates</p>
      </div>

      {parseError && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-xs text-destructive">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {parseError}
        </div>
      )}

      {/* Required columns */}
      <div className="p-3 rounded-xl bg-muted/30 border border-border/50 space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Required columns</p>
        <div className="flex flex-wrap gap-1.5">
          {["firstName", "lastName", "email"].map(h => (
            <Badge key={h} variant="outline" className="text-xs text-primary border-primary/30">{h}</Badge>
          ))}
        </div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-2">Optional columns</p>
        <div className="flex flex-wrap gap-1.5">
          {["phone", "currentTitle", "currentCompany", "location", "linkedinUrl", "skills", "source", "isCurrentEmployee"].map(h => (
            <Badge key={h} variant="outline" className="text-xs">{h}</Badge>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">Skills: comma-separated inside the cell (e.g. "React,TypeScript,Node.js"). isCurrentEmployee: use "true"/"false" to flag internal employees per row.</p>
      </div>

      <Button variant="outline" className="w-full gap-2" onClick={downloadTemplate}>
        <Download className="w-4 h-4" /> Download Template CSV
      </Button>
    </div>
  );
}

function PreviewStep({
  rows, onBack, onImport, importing,
}: {
  rows: ParsedRow[]; onBack: () => void; onImport: () => void; importing: boolean;
}) {
  const valid   = rows.filter(r => r._errors.length === 0);
  const invalid = rows.filter(r => r._errors.length > 0);
  const preview = rows.slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="flex-1 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20 text-center">
          <p className="text-xl font-black text-emerald-400">{valid.length}</p>
          <p className="text-xs text-muted-foreground">Ready to import</p>
        </div>
        {invalid.length > 0 && (
          <div className="flex-1 p-3 rounded-xl bg-destructive/8 border border-destructive/20 text-center">
            <p className="text-xl font-black text-destructive">{invalid.length}</p>
            <p className="text-xs text-muted-foreground">Have errors (will skip)</p>
          </div>
        )}
      </div>

      <div className="border border-border/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">#</th>
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Name</th>
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Email</th>
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Title</th>
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {preview.map(row => {
                const hasErrors = row._errors.length > 0;
                return (
                  <tr key={row._rowNum} className={cn("border-t border-border/30", hasErrors && "bg-destructive/5")}>
                    <td className="px-3 py-2 text-muted-foreground">{row._rowNum}</td>
                    <td className="px-3 py-2 font-medium">
                      {row.firstname || row.firstName} {row.lastname || row.lastName}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[160px]">{row.email}</td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[120px]">
                      {row.currenttitle || row.currentTitle || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {hasErrors ? (
                        <span className="text-destructive flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> {row._errors[0]}
                        </span>
                      ) : (
                        <span className="text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> OK
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 8 && (
            <p className="text-xs text-muted-foreground text-center py-2 border-t border-border/30">
              …and {rows.length - 8} more rows
            </p>
          )}
        </div>
      </div>

      {valid.length === 0 && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-xs text-destructive text-center">
          No valid rows to import. Please fix errors in your CSV and re-upload.
        </div>
      )}
    </div>
  );
}

function ResultsStep({
  result, onClose,
}: {
  result: { created: number; skipped: number; errorCount: number; errors: any[] };
  onClose: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <div className="p-4 rounded-xl bg-emerald-500/8 border border-emerald-500/20 text-center">
          <CheckCircle2 className="w-5 h-5 mx-auto text-emerald-400 mb-1" />
          <p className="text-2xl font-black text-emerald-400">{result.created}</p>
          <p className="text-xs text-muted-foreground">Created</p>
        </div>
        <div className="p-4 rounded-xl bg-muted/30 border border-border/50 text-center">
          <SkipForward className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
          <p className="text-2xl font-black">{result.skipped}</p>
          <p className="text-xs text-muted-foreground">Skipped (already exist)</p>
        </div>
        <div className="p-4 rounded-xl bg-destructive/8 border border-destructive/20 text-center">
          <XCircle className="w-5 h-5 mx-auto text-destructive mb-1" />
          <p className="text-2xl font-black text-destructive">{result.errorCount}</p>
          <p className="text-xs text-muted-foreground">Errors</p>
        </div>
      </div>

      {result.created > 0 && (
        <div className="p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
          <p className="text-sm text-emerald-400">
            {pluralize(result.created, "candidate")} added to the pipeline.
            {result.created > 0 && " The intelligence engine will score them automatically."}
          </p>
        </div>
      )}

      {result.errors.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Errors</p>
          <div className="max-h-[120px] overflow-y-auto space-y-1">
            {result.errors.map((err: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-xs text-destructive p-2 rounded-lg bg-destructive/5 border border-destructive/20">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                Row {err.row} ({err.email || "—"}): {err.reason}
              </div>
            ))}
          </div>
        </div>
      )}

      <Button className="w-full" onClick={onClose}>Done</Button>
    </div>
  );
}

/* ── Main dialog ──────────────────────────────────────────────────────────── */
export function CsvImportDialog({
  open, onOpenChange, jobId, isCurrentEmployee,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; jobId?: string;
  /* When true, every imported row is flagged as a current employee and the
     copy switches to the internal-bench framing. */
  isCurrentEmployee?: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<"upload" | "preview" | "results">("upload");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<any>(null);

  const importMutation = useMutation({
    mutationFn: async () => {
      const validRows = parsedRows
        .filter(r => r._errors.length === 0)
        .map(mapRowToPayload);

      const res = await fetch(`${BASE}/api/candidates/bulk-import`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ rows: validRows, jobId, isCurrentEmployee }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Import failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setImportResult(data);
      setStep("results");
      queryClient.invalidateQueries({ queryKey: ["/api/candidates"] });
      queryClient.invalidateQueries({ queryKey: ["intelligence"] });
      queryClient.invalidateQueries({ queryKey: ["internal-talent"] });
      if (data.created > 0) {
        toast({ title: `${pluralize(data.created, "candidate")} imported` });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const handleClose = () => {
    onOpenChange(false);
    setTimeout(() => {
      setStep("upload");
      setParsedRows([]);
      setHeaders([]);
      setImportResult(null);
    }, 300);
  };

  const validCount = parsedRows.filter(r => r._errors.length === 0).length;

  const STEP_LABELS = { upload: "Upload File", preview: "Preview & Confirm", results: "Import Complete" };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            {isCurrentEmployee ? "Import Current Employees via CSV" : "Import Candidates via CSV"}
          </DialogTitle>
          <DialogDescription>
            {isCurrentEmployee
              ? "Everyone in this file is added to your internal bench and flagged as a current employee, so the engine surfaces them first for internal mobility."
              : jobId
              ? "Candidates will be added to this job's pipeline and linked to the role."
              : "Candidates will be added to the global candidate pool."}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-xs mb-1">
          {(["upload", "preview", "results"] as const).map((s, i, arr) => (
            <div key={s} className="flex items-center gap-2">
              <div className={cn(
                "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black",
                step === s ? "bg-primary text-black" : "bg-muted text-muted-foreground",
              )}>{i + 1}</div>
              <span className={cn("font-medium", step === s ? "text-primary" : "text-muted-foreground")}>
                {STEP_LABELS[s]}
              </span>
              {i < arr.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}
            </div>
          ))}
        </div>

        {/* Step content */}
        {step === "upload" && (
          <UploadStep
            onParsed={(rows, hdrs) => { setParsedRows(rows); setHeaders(hdrs); setStep("preview"); }}
            onClose={handleClose}
          />
        )}
        {step === "preview" && (
          <PreviewStep
            rows={parsedRows}
            onBack={() => setStep("upload")}
            onImport={() => importMutation.mutate()}
            importing={importMutation.isPending}
          />
        )}
        {step === "results" && importResult && (
          <ResultsStep result={importResult} onClose={handleClose} />
        )}

        {/* Footer */}
        {step !== "results" && (
          <DialogFooter className="gap-2">
            {step === "upload" && (
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
            )}
            {step === "preview" && (
              <>
                <Button variant="outline" onClick={() => setStep("upload")} disabled={importMutation.isPending}>
                  Back
                </Button>
                <Button
                  onClick={() => importMutation.mutate()}
                  disabled={validCount === 0 || importMutation.isPending}
                >
                  {importMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Import {pluralize(validCount, "Candidate")}
                </Button>
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
