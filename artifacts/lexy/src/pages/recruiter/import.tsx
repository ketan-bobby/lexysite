/**
 * pages/recruiter/import.tsx — Bulk Candidate Import
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Allows recruiters to bulk-import candidates from a CSV or Excel file. The
 * file is uploaded, validated column-by-column, deduped against existing
 * candidates, and then imported asynchronously with a progress indicator.
 *
 * ─── Upload flow ─────────────────────────────────────────────────────────────
 *   1. Recruiter drags or selects a .csv / .xlsx file
 *   2. Client-side column mapping (which CSV column → which candidate field)
 *   3. POST /api/candidates/import (multipart) → returns { jobId, total }
 *   4. Polls GET /api/candidates/import/:jobId every 2 s for progress
 *   5. When done: shows summary (imported / skipped / errors)
 *   6. Errors list downloadable as CSV for fixing and re-importing
 *
 * ─── Column mapping ──────────────────────────────────────────────────────────
 * Supports auto-detection of common headers (name, email, phone, linkedinUrl,
 * currentRole, company, location, source, notes). Unrecognised headers are
 * mapped manually via a dropdown selector.
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/import
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FileUp, CheckCircle2, XCircle, AlertTriangle,
  RefreshCw, Users, FileText, Loader2, ChevronLeft, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@workspace/react-hooks/use-toast";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const statusCfg: Record<string, { label: string; color: string }> = {
  uploaded:          { label: "Uploaded",          color: "bg-slate-500/20 text-slate-300 border-slate-500/30"       },
  parsed:            { label: "Parsed",            color: "bg-blue-500/20 text-blue-300 border-blue-500/30"          },
  imported:          { label: "Imported",          color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  duplicate_updated: { label: "Duplicate Updated", color: "bg-amber-500/20 text-amber-300 border-amber-500/30"       },
  duplicate_skipped: { label: "Duplicate Skipped", color: "bg-orange-500/20 text-orange-300 border-orange-500/30"    },
  failed:            { label: "Failed",            color: "bg-red-500/20 text-red-300 border-red-500/30"             },
  needs_review:      { label: "Needs Review",      color: "bg-violet-500/20 text-violet-300 border-violet-500/30"    },
};

function useImportStats(page: number) {
  return useQuery<any>({
    queryKey: ["import", "admin-stats", page],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/candidates/import/admin-stats?page=${page}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to load import stats");
      return res.json();
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export default function ResumeImport() {
  const [page, setPage] = useState(1);
  const { data, isLoading, refetch, isFetching } = useImportStats(page);
  const { toast } = useToast();

  const totals     = data?.totals ?? {};
  const records    = data?.recentRecords ?? [];
  const pagination = data?.pagination ?? { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 };

  const statCards = [
    { label: "Total Imports",  value: totals.total             ?? 0, icon: FileUp,        color: "text-cyan-400"    },
    { label: "Imported",       value: totals.imported          ?? 0, icon: CheckCircle2,  color: "text-emerald-400" },
    { label: "Duplicates",     value: (totals.duplicate_updated ?? 0) + (totals.duplicate_skipped ?? 0),
                                                                      icon: Users,         color: "text-amber-400"   },
    { label: "Failed",         value: totals.failed            ?? 0, icon: XCircle,       color: "text-red-400"     },
    { label: "Needs Review",   value: totals.needs_review      ?? 0, icon: AlertTriangle, color: "text-violet-400"  },
  ];

  const csharpSnippet = `// C# — POST resume file to Lexy
var client = new HttpClient();
client.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", config["LexyImportApiKey"]);

await using var stream = File.OpenRead(filePath);
var content = new MultipartFormDataContent();
content.Add(new StreamContent(stream), "resume", Path.GetFileName(filePath));
content.Add(new StringContent("dotnet_resume_parser"), "source");

// REQUIRED: the importing company's tenant UUID. Imported candidates are
// always scoped to that company's own pool — platform-wide discovery
// requires the candidate's own explicit opt-in and cannot be set here.
content.Add(new StringContent("10000000-0000-0000-0000-000000000002"), "tenantId");

var response = await client.PostAsync(
    "https://your-lexy-domain/api/candidates/import",
    content
);
var result = await response.Content.ReadFromJsonAsync<ImportResult>();
// result.status     → "imported" | "duplicate_updated" | "duplicate_skipped"
// result.candidateId → Lexy UUID for the candidate
// result.resumeUrl  → S3 path where the file is stored
// result.tenantId   → tenant the candidate was assigned to
// result.pool       → always "tenant" (proprietary to the importing company)
// result.parsed     → { name, email, phone, location, title, company, skills }`;

  function copySnippet() {
    navigator.clipboard.writeText(csharpSnippet);
    toast({ title: "Copied", description: "C# snippet copied to clipboard" });
  }

  return (
    <AppLayout>
      <div className="p-6 space-y-6 max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">Resume Import</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Receives resume files from the .NET parser, extracts candidate data with AI, stores files in S3, and creates candidate records.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-2">
            {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </Button>
        </div>

        {/* Flow diagram */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          {[
            { step: "1", label: ".NET sends resume file" },
            { step: "2", label: "Lexy extracts text (PDF/DOCX)" },
            { step: "3", label: "AI parses structured data" },
            { step: "4", label: "File saved to S3" },
            { step: "5", label: "Duplicate check" },
            { step: "6", label: "Candidate created / updated" },
          ].map(({ step, label }, i, arr) => (
            <div key={step} className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-cyan-500/20 border border-cyan-500/40 text-cyan-400 text-[10px] font-bold flex items-center justify-center">{step}</span>
                <span>{label}</span>
              </div>
              {i < arr.length - 1 && <span className="text-border">→</span>}
            </div>
          ))}
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {statCards.map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="bg-card border-border">
              <CardContent className="p-4 flex flex-col gap-2">
                <Icon className={cn("w-5 h-5", color)} />
                <div className="text-2xl font-bold text-foreground">
                  {isLoading ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /> : value}
                </div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Recent records */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="w-4 h-4 text-cyan-400" />
                Import Records
                {pagination.totalItems > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    ({pagination.totalItems} total)
                  </span>
                )}
              </CardTitle>
              {isFetching && !isLoading && (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
                <Loader2 className="w-5 h-5 animate-spin" /> Loading…
              </div>
            ) : records.length === 0 && page === 1 ? (
              <div className="py-12 text-center text-muted-foreground text-sm">
                No imports yet. The .NET API should POST resume files to{" "}
                <code className="text-cyan-400 text-xs bg-cyan-400/10 px-1.5 py-0.5 rounded">
                  POST /api/candidates/import
                </code>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground text-xs uppercase tracking-wide">
                        <th className="text-left px-4 py-2.5">File</th>
                        <th className="text-left px-4 py-2.5">Status</th>
                        <th className="text-left px-4 py-2.5">Candidate</th>
                        <th className="text-left px-4 py-2.5">Error</th>
                        <th className="text-left px-4 py-2.5">Imported At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r: any) => {
                        const cfg = statusCfg[r.status] ?? { label: r.status, color: "bg-slate-500/20 text-slate-300 border-slate-500/30" };
                        const parsed = r.parsedData as any;
                        const name = parsed?.firstName && parsed?.lastName
                          ? `${parsed.firstName} ${parsed.lastName}`
                          : null;
                        return (
                          <tr key={r.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-2.5 font-mono text-xs text-foreground max-w-[160px] truncate">
                              {r.fileName ?? <span className="text-muted-foreground italic">—</span>}
                            </td>
                            <td className="px-4 py-2.5">
                              <Badge className={cn("text-xs border", cfg.color)}>{cfg.label}</Badge>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">
                              {name
                                ? <span className="text-foreground">{name}</span>
                                : r.candidateId
                                ? <span className="text-cyan-400/80 font-mono">{r.candidateId.slice(0, 8)}…</span>
                                : <span className="italic">—</span>}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-red-400 max-w-[200px] truncate">
                              {r.errorMessage ?? <span className="text-muted-foreground italic">—</span>}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                              {new Date(r.createdAt).toLocaleString()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination controls */}
                {pagination.totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                    <span className="text-xs text-muted-foreground">
                      Page {pagination.page} of {pagination.totalPages}
                      {" "}·{" "}
                      {pagination.totalItems} records
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        disabled={page <= 1}
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </Button>
                      {Array.from({ length: pagination.totalPages }, (_, i) => i + 1)
                        .filter(p => p === 1 || p === pagination.totalPages || Math.abs(p - page) <= 1)
                        .reduce<(number | "…")[]>((acc, p, i, arr) => {
                          if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push("…");
                          acc.push(p);
                          return acc;
                        }, [])
                        .map((p, i) =>
                          p === "…" ? (
                            <span key={`ellipsis-${i}`} className="text-xs text-muted-foreground px-1">…</span>
                          ) : (
                            <Button
                              key={p}
                              variant={page === p ? "default" : "outline"}
                              size="sm"
                              className="h-7 w-7 p-0 text-xs"
                              onClick={() => setPage(p as number)}
                            >
                              {p}
                            </Button>
                          )
                        )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        disabled={page >= pagination.totalPages}
                        onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Integration guide */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <FileUp className="w-4 h-4 text-cyan-400" />
                .NET Integration Guide
              </CardTitle>
              <Button variant="ghost" size="sm" className="text-xs gap-1.5" onClick={copySnippet}>
                Copy C# snippet
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Endpoint</p>
                <code className="block bg-muted/50 border border-border rounded-md px-3 py-2 text-cyan-300">
                  POST /api/candidates/import
                </code>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Authentication</p>
                <code className="block bg-muted/50 border border-border rounded-md px-3 py-2 text-amber-300">
                  Authorization: Bearer {"<LEXY_IMPORT_API_KEY>"}
                </code>
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Request</p>
              <div className="bg-muted/50 border border-border rounded-md px-3 py-2.5 text-xs space-y-1">
                <div><span className="text-muted-foreground">Content-Type:</span> <span className="text-foreground">multipart/form-data</span></div>
                <div><span className="text-muted-foreground">Field </span><code className="text-cyan-400">resume</code><span className="text-muted-foreground"> — the PDF or DOCX file (required, max 15 MB)</span></div>
                <div><span className="text-muted-foreground">Field </span><code className="text-cyan-400">source</code><span className="text-muted-foreground"> — optional string label, e.g. "dotnet_resume_parser"</span></div>
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Supported File Types</p>
              <div className="flex gap-2">
                <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30 text-xs">PDF (.pdf)</Badge>
                <Badge className="bg-slate-500/20 text-slate-300 border-slate-500/30 text-xs">Word (.docx / .doc)</Badge>
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Response</p>
              <pre className="bg-muted/50 border border-border rounded-md px-3 py-2.5 text-xs text-emerald-300 overflow-x-auto leading-relaxed">
{`{
  "status": "imported" | "duplicate_updated" | "duplicate_skipped" | "needs_review",
  "candidateId": "uuid",
  "batchId": "uuid",
  "resumeUrl": "/objects/uploads/uuid",   // S3 path
  "parsed": {
    "name": "John Smith",
    "email": "john@example.com",
    "phone": "+971501234567",
    "location": "Dubai, UAE",
    "title": "Senior Software Engineer",
    "company": "Acme Corp",
    "skills": ["TypeScript", "React", ...]
  },
  "message": "Candidate created successfully"
}`}
              </pre>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">C# Example</p>
              <pre className="bg-muted/50 border border-border rounded-md px-3 py-2.5 text-xs text-blue-300 overflow-x-auto leading-relaxed">
                {csharpSnippet}
              </pre>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Duplicate Detection</p>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Match by <strong className="text-foreground">email</strong> (extracted from resume, case-insensitive)</li>
                <li>Match by <strong className="text-foreground">phone</strong> if no email match</li>
                <li>Match by <strong className="text-foreground">first name + last name + location</strong> if neither found</li>
              </ol>
            </div>

          </CardContent>
        </Card>

      </div>
    </AppLayout>
  );
}
