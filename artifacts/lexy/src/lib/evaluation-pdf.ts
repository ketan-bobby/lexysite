/**
 * evaluation-pdf.ts — Client-side "AI Candidate Evaluation" PDF generator.
 *
 * Produces a polished, client-ready PDF that a recruiter can download from the
 * candidate detail page and forward to their client (the hiring employer). It
 * aggregates the AI evaluation surfaced across the app: best-fit talent match,
 * resume screening, interview assessment, and a trust/verification signal.
 *
 * Pure jsPDF (no html2canvas) so output is crisp vector text and the bundle is
 * framework-agnostic — no React-version coupling.
 */
import { jsPDF } from "jspdf";
import { bandBy } from "./score-band";

export interface EvaluationRole {
  jobTitle: string | null;
  fitScore: number | null;
}

export interface EvaluationInterview {
  status?: string | null;
  score?: number | null;
  totalQuestions?: number | null;
  createdAt?: string | null;
  /** AI assessment from interview_summaries (session.score is often null). */
  overallScore?: number | null;
  recommendation?: string | null;
  summary?: string | null;
  strengths?: string[] | null;
  weaknesses?: string[] | null;
}

export interface EvaluationPdfData {
  candidate: {
    firstName: string;
    lastName: string;
    currentTitle?: string | null;
    currentCompany?: string | null;
    location?: string | null;
    email?: string | null;
    skills?: string[] | null;
    verificationStatus?: string | null;
  };
  bestRole?: EvaluationRole | null;
  allRoles?: EvaluationRole[];
  resumeScreen?: {
    screeningScore?: number | null;
    recruiterSummary?: string | null;
    extractedSkills?: string[] | null;
    missingSkills?: string[] | null;
  } | null;
  interviews?: EvaluationInterview[];
  verification?: {
    status?: string | null;
    identityVerified?: boolean | null;
  } | null;
  /** Optional name of the recruiter / agency preparing the report. */
  preparedBy?: string | null;
}

// ── Palette ───────────────────────────────────────────────────────────────────
// Mirrors the Lexy design tokens in src/index.css (same palette as
// evaluation-report-pdf.ts) so every exported PDF matches the brand.
// --primary is hsl(210 75% 37%) = #185EA5 (blue, NOT violet).
const BRAND: [number, number, number] = [24, 94, 165]; // --primary #185EA5
const INK: [number, number, number] = [15, 23, 42]; // --ink #0F172A
const MUTED: [number, number, number] = [71, 85, 105]; // --body #475569
const LIGHT: [number, number, number] = [241, 245, 249]; // slate-100 surface tint
const BORDER: [number, number, number] = [226, 232, 240]; // --line #E2E8F0
const EMERALD: [number, number, number] = [4, 120, 87]; // "strong" band
const ORANGE: [number, number, number] = [194, 65, 12]; // "fair"/caution band
const RED: [number, number, number] = [220, 38, 38]; // destructive

// Canonical banding (score-band.ts): strong=emerald, good=brand blue, fair=orange.
function scoreColor(score: number): [number, number, number] {
  return bandBy(score, { strong: EMERALD, good: BRAND, fair: ORANGE });
}


// Fit-label ladder: the canonical 3-band names plus one "Exceptional" tier above
// the strong band. EXCEPTIONAL_FIT_MIN is a label embellishment, not a colour band.
const EXCEPTIONAL_FIT_MIN = 85;
function scoreLabel(score: number): string {
  if (score >= EXCEPTIONAL_FIT_MIN) return "Exceptional fit";
  return bandBy(score, { strong: "Strong fit", good: "Moderate fit", fair: "Limited fit" });
}

async function fetchLogoDataUrl(): Promise<string | null> {
  try {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const resp = await fetch(`${base}/lexy-logo.png`);
    const blob = await resp.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Enrichment occasionally lands a website URL (e.g. "www.acme.com") in the
 * candidate's title/company fields. A bare URL must never render as the
 * candidate's role on a client-facing report, so drop URL-like tokens.
 */
function isUrlLike(s: string | null | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  if (!t || /\s/.test(t)) return false; // multi-word = a real title/company name
  return (
    /^https?:\/\//i.test(t) ||
    /^www\./i.test(t) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)
  );
}

/**
 * Build the jsPDF document + a safe file name from the evaluation data, WITHOUT
 * triggering a download. Shared by the recruiter download (`generateEvaluationPdf`),
 * the base64 helper used to attach the PDF to a hiring-manager email
 * (`getEvaluationPdfBase64`), and the public hiring-manager page download.
 */
export async function buildEvaluationPdfDoc(
  data: EvaluationPdfData,
): Promise<{ doc: jsPDF; fileName: string }> {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentW = pageW - margin * 2;
  const bottomLimit = pageH - 56;
  let y = 0;

  const logoDataUrl = await fetchLogoDataUrl();

  const { candidate } = data;
  const fullName = `${candidate.firstName} ${candidate.lastName}`.trim();
  const roleLine = [candidate.currentTitle, candidate.currentCompany]
    .filter((v) => Boolean(v) && !isUrlLike(v))
    .join(" · ");

  // ── Helpers ──────────────────────────────────────────────────────────────
  const ensureSpace = (needed: number) => {
    if (y + needed > bottomLimit) {
      doc.addPage();
      y = margin;
    }
  };

  const sectionHeading = (label: string) => {
    ensureSpace(40);
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...BRAND);
    doc.text(label.toUpperCase(), margin, y);
    y += 8;
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(1);
    doc.line(margin, y, pageW - margin, y);
    y += 16;
  };

  const paragraph = (
    text: string,
    opts: { size?: number; color?: [number, number, number]; bold?: boolean } = {},
  ) => {
    const size = opts.size ?? 10;
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(opts.color ?? INK));
    const lineH = size * 1.45;
    const lines = doc.splitTextToSize(text, contentW);
    for (const line of lines) {
      ensureSpace(lineH);
      doc.text(line, margin, y);
      y += lineH;
    }
  };

  const labelledList = (label: string, items: string[], color: [number, number, number]) => {
    const text = items.length ? items.join(", ") : "None identified";
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...color);
    ensureSpace(14);
    doc.text(label, margin, y);
    const labelW = doc.getTextWidth(label + "  ");
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...INK);
    const lines = doc.splitTextToSize(text, contentW - labelW);
    doc.text(lines[0] ?? "", margin + labelW, y);
    y += 13.5;
    for (let i = 1; i < lines.length; i++) {
      ensureSpace(13.5);
      doc.text(lines[i], margin + labelW, y);
      y += 13.5;
    }
    y += 4;
  };

  // ── Header band ───────────────────────────────────────────────────────────
  const bandH = 104;
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageW, bandH, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("CANDIDATE EVALUATION", margin, 38);

  doc.setFontSize(24);
  doc.text(fullName || "Candidate", margin, 66);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const sub = [roleLine, candidate.location].filter(Boolean).join("  ·  ");
  if (sub) doc.text(sub, margin, 86);

  // Right-aligned logo + date
  // The L3xy AI logo is a wide white-on-black wordmark — render it on a black
  // rounded pill so it reads cleanly against the violet band.
  const logoW = 114;
  const logoH = 36;
  const logoX = pageW - margin - logoW;
  const logoY = 14;
  if (logoDataUrl) {
    doc.setFillColor(0, 0, 0);
    (doc as any).roundedRect(logoX - 8, logoY - 6, logoW + 16, logoH + 12, 6, 6, "F");
    doc.addImage(logoDataUrl, "PNG", logoX, logoY, logoW, logoH);
  } else {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(255, 255, 255);
    doc.text("L3xy AI", pageW - margin, 38, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.text("AI Hiring Intelligence", pageW - margin, 52, { align: "right" });
  }
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  doc.text(dateStr, pageW - margin, 86, { align: "right" });

  y = bandH + 28;

  // ── Overall fit ─────────────────────────────────────────────────────────
  sectionHeading("Overall Match");
  const best = data.bestRole;
  if (best && best.fitScore != null) {
    const sc = Math.round(best.fitScore);
    const col = scoreColor(sc);
    // Score box
    const boxW = 96;
    const boxH = 70;
    ensureSpace(boxH + 8);
    doc.setFillColor(...LIGHT);
    doc.roundedRect(margin, y, boxW, boxH, 8, 8, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(30);
    doc.setTextColor(...col);
    doc.text(`${sc}%`, margin + boxW / 2, y + 38, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text("FIT SCORE", margin + boxW / 2, y + 54, { align: "center" });

    // Right of box
    const tx = margin + boxW + 18;
    let ty = y + 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text(scoreLabel(sc), tx, ty);
    ty += 18;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    const roleName = best.jobTitle || "Target role";
    const rl = doc.splitTextToSize(`Evaluated against: ${roleName}`, contentW - boxW - 18);
    doc.text(rl, tx, ty);
    y += boxH + 10;
  } else {
    paragraph("This candidate has not yet been scored against a role.", { color: MUTED });
  }

  // Additional roles
  const others = (data.allRoles ?? []).filter(
    (r) => r.fitScore != null && r.jobTitle && r.jobTitle !== best?.jobTitle,
  );
  if (others.length) {
    y += 2;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...MUTED);
    ensureSpace(16);
    doc.text("Other matched roles", margin, y);
    y += 14;
    for (const r of others.slice(0, 6)) {
      ensureSpace(14);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(...INK);
      doc.text(`•  ${r.jobTitle}`, margin + 6, y);
      const sc = Math.round(r.fitScore as number);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...scoreColor(sc));
      doc.text(`${sc}%`, pageW - margin, y, { align: "right" });
      y += 14;
    }
    y += 4;
  }

  // ── Resume screening ──────────────────────────────────────────────────────
  const rs = data.resumeScreen;
  sectionHeading("Resume Screening");
  if (rs && (rs.screeningScore != null || rs.recruiterSummary)) {
    if (rs.screeningScore != null) {
      const sc = Math.round(rs.screeningScore);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...MUTED);
      ensureSpace(16);
      doc.text("Resume match score:", margin, y);
      doc.setTextColor(...scoreColor(sc));
      doc.text(`${sc}%`, margin + doc.getTextWidth("Resume match score:  "), y);
      y += 18;
    }
    if (rs.recruiterSummary) {
      paragraph("AI Recruiter Summary", { bold: true, size: 9.5, color: MUTED });
      y += 2;
      paragraph(rs.recruiterSummary, { color: INK });
      y += 6;
    }
    labelledList("Matched skills:", (rs.extractedSkills ?? []).filter(Boolean), EMERALD);
    labelledList("Skill gaps:", (rs.missingSkills ?? []).filter(Boolean), ORANGE);
  } else {
    paragraph("Resume has not been screened yet.", { color: MUTED });
  }

  // ── Interview assessment ──────────────────────────────────────────────────
  const completed = (data.interviews ?? []).filter((i) => i.status === "completed");
  sectionHeading("Interview Assessment");
  if (completed.length) {
    for (const iv of completed) {
      ensureSpace(20);
      // session.score is frequently null on completed sessions — fall back to
      // the assessment's overall score so the verdict isn't silently dropped.
      const rawScore = iv.score != null ? iv.score : (iv.overallScore != null ? iv.overallScore : null);
      const sc = rawScore != null ? Math.round(rawScore) : null;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...INK);
      doc.text("AI Video Interview", margin, y);
      if (sc != null) {
        doc.setTextColor(...scoreColor(sc));
        doc.text(`${sc}%`, pageW - margin, y, { align: "right" });
      }
      y += 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      const meta: string[] = [];
      if (iv.totalQuestions != null) meta.push(`${iv.totalQuestions} questions`);
      if (iv.createdAt) {
        const d = new Date(iv.createdAt);
        if (!isNaN(d.getTime()))
          meta.push(
            d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
          );
      }
      if (meta.length) {
        doc.text(meta.join("  ·  "), margin, y);
        y += 14;
      }
      if (iv.recommendation) {
        /* Never print the AI's advance/decline verdict on a client-facing
           document — this legacy PDF has no recruiter-approval workflow, so
           the recommendation always reads as pending recruiter review. */
        ensureSpace(14);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9.5);
        doc.setTextColor(...MUTED);
        doc.text("Recommendation:", margin, y);
        const labelW = doc.getTextWidth("Recommendation:  ");
        doc.setTextColor(...BRAND);
        doc.text("Ready for Recruiter Review", margin + labelW, y);
        y += 16;
      }
      if (iv.summary) {
        paragraph("AI Interview Summary", { bold: true, size: 9.5, color: MUTED });
        y += 2;
        paragraph(iv.summary, { color: INK });
        y += 6;
      }
      const strengths = (iv.strengths ?? []).filter(Boolean);
      const weaknesses = (iv.weaknesses ?? []).filter(Boolean);
      if (strengths.length) labelledList("Strengths:", strengths, EMERALD);
      if (weaknesses.length) labelledList("Areas of concern:", weaknesses, ORANGE);
      y += 4;
    }
  } else {
    paragraph("No completed interview on record yet.", { color: MUTED });
  }

  // ── Verification / trust ──────────────────────────────────────────────────
  const v = data.verification;
  sectionHeading("Identity & Trust");
  // Faithfully represent the verification outcome in this client-facing doc:
  // a flagged candidate must NOT be softened to "Pending". Prefer the explicit
  // verification status, falling back to the candidate row's status.
  const vStatus = (v?.status ?? candidate.verificationStatus ?? "").toLowerCase();
  let trustLabel: string;
  let trustColor: [number, number, number];
  if (vStatus === "verified" || v?.identityVerified === true) {
    trustLabel = "Verified";
    trustColor = EMERALD;
  } else if (vStatus === "flagged" || vStatus === "rejected") {
    trustLabel = "Flagged · Requires review";
    trustColor = RED;
  } else {
    trustLabel = "Pending";
    trustColor = MUTED;
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  ensureSpace(16);
  doc.text("Identity verification:", margin, y);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...trustColor);
  doc.text(trustLabel, margin + doc.getTextWidth("Identity verification:  "), y);
  y += 18;

  // ── Footers (page numbers + confidentiality) ──────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.5);
    doc.line(margin, pageH - 40, pageW - margin, pageH - 40);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    const left = data.preparedBy
      ? `Confidential · Prepared by ${data.preparedBy} with Lexy AI`
      : "Confidential · Generated by Lexy AI";
    doc.text(left, margin, pageH - 26);
    doc.text(`Page ${i} of ${pageCount}`, pageW - margin, pageH - 26, { align: "right" });
  }

  const safeName = fullName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "candidate";
  return { doc, fileName: `Evaluation-${safeName}.pdf` };
}

/** Build the evaluation PDF and trigger a browser download. */
export async function generateEvaluationPdf(data: EvaluationPdfData): Promise<void> {
  const { doc, fileName } = await buildEvaluationPdfDoc(data);
  doc.save(fileName);
}

/**
 * Build the evaluation PDF and return its base64-encoded bytes + file name, for
 * attaching to an outbound email (POST to the backend hm-share route).
 */
export async function getEvaluationPdfBase64(
  data: EvaluationPdfData,
): Promise<{ base64: string; fileName: string }> {
  const { doc, fileName } = await buildEvaluationPdfDoc(data);
  const uri = doc.output("datauristring");
  const idx = uri.indexOf("base64,");
  const base64 = idx >= 0 ? uri.slice(idx + "base64,".length) : "";
  return { base64, fileName };
}
