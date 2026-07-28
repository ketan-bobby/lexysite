/**
 * evaluation-report-pdf.ts — Client-ready PDF for the structured, human-approved
 * candidate×role evaluation (the `candidate_evaluations` report).
 *
 * Renders the MERGED, recruiter-approved content only. Pure jsPDF (no
 * html2canvas) so output is crisp vector text and framework-agnostic.
 *
 * The recommendation band, confidence and verification state are produced
 * deterministically server-side — this file only lays them out. It never invents
 * a verdict and never surfaces raw internal risk internals.
 */
import { jsPDF } from "jspdf";
import type { EvaluationContent, RecommendationBand } from "./evaluation-types";

// ── Palette ─────────────────────────────────────────────────────────────────
// Mirrors the Lexy design tokens in artifacts/lexy/src/index.css so the exported
// PDF matches the in-app report. --primary is hsl(210 75% 37%) = #185EA5 (blue,
// NOT violet). Score colours follow the canonical band in ./score-band.ts.
const BRAND: [number, number, number] = [24, 94, 165]; // --primary #185EA5
const INK: [number, number, number] = [15, 23, 42]; // --ink #0F172A
const MUTED: [number, number, number] = [71, 85, 105]; // --body #475569
const LIGHT: [number, number, number] = [241, 245, 249]; // slate-100 surface tint
const BORDER: [number, number, number] = [226, 232, 240]; // --line #E2E8F0
const EMERALD: [number, number, number] = [4, 120, 87]; // "strong" band
const ORANGE: [number, number, number] = [194, 65, 12]; // "fair"/caution band
const RED: [number, number, number] = [220, 38, 38]; // destructive

// Mirrors score-band.ts: >=75 strong (emerald) / >=55 good (brand blue) / <55 fair (orange).
function scoreColor(score: number): [number, number, number] {
  if (score >= 75) return EMERALD;
  if (score >= 55) return BRAND;
  return ORANGE;
}

function verificationColor(
  status: EvaluationContent["verification"]["status"],
): [number, number, number] {
  if (status === "verified") return EMERALD;
  if (status === "flagged") return RED;
  return MUTED;
}

function verificationLabel(status: EvaluationContent["verification"]["status"]): string {
  if (status === "verified") return "Verified";
  if (status === "flagged") return "Flagged";
  if (status === "pending") return "Pending";
  return "Not available";
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

export interface EvaluationReportPdfData {
  candidateName: string;
  jobTitle: string | null;
  companyName?: string | null;
  content: EvaluationContent & { recruiterComments?: string };
  recommendationBand: RecommendationBand;
  bandLabel: string;
  confidence: number | null;
  preparedBy?: string | null;
  approvedAt?: string | null;
  /** True when the evaluation has not been recruiter-approved yet — the PDF
   *  carries a DRAFT notice on every page so it can't pass as final. */
  isDraft?: boolean;
}

function safeName(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "candidate"
  );
}

export async function buildEvaluationReportPdfDoc(
  data: EvaluationReportPdfData,
): Promise<{ doc: jsPDF; fileName: string }> {
  const { content } = data;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 44;
  const contentW = pageW - margin * 2;
  let y = 0;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - 56) {
      doc.addPage();
      y = margin;
    }
  };

  const sectionHeader = (label: string) => {
    ensureSpace(40);
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...BRAND);
    doc.text(label.toUpperCase(), margin, y);
    y += 6;
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(1);
    doc.line(margin, y, pageW - margin, y);
    y += 14;
  };

  const paragraph = (
    text: string,
    opts: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number } = {},
  ) => {
    if (!text) return;
    const size = opts.size ?? 10;
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(opts.color ?? INK));
    const lines = doc.splitTextToSize(text, contentW);
    for (const line of lines) {
      ensureSpace(size + 4);
      doc.text(line, margin, y);
      y += size + 4;
    }
    y += opts.gap ?? 4;
  };

  const bullet = (text: string, color: [number, number, number] = INK) => {
    if (!text) return;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, contentW - 14);
    ensureSpace(14);
    doc.setTextColor(...BRAND);
    doc.text("•", margin, y);
    doc.setTextColor(...color);
    doc.text(lines[0] ?? "", margin + 14, y);
    y += 14;
    for (let i = 1; i < lines.length; i++) {
      ensureSpace(14);
      doc.text(lines[i], margin + 14, y);
      y += 14;
    }
  };

  // ── Header band ─────────────────────────────────────────────────────────
  const bandH = 92;
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageW, bandH, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("CANDIDATE EVALUATION", margin, 34);
  doc.setFontSize(22);
  doc.text(data.candidateName || "Candidate", margin, 60);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const roleLine = [data.jobTitle, data.companyName].filter(Boolean).join(" · ");
  if (roleLine) doc.text(roleLine, margin, 80);

  const logo = await fetchLogoDataUrl();
  if (logo) {
    try {
      doc.addImage(logo, "PNG", pageW - margin - 96, 28, 96, 30, undefined, "FAST");
    } catch {
      /* ignore logo errors */
    }
  }
  y = bandH + 24;

  // ── Recommendation + confidence banner ────────────────────────────────────
  const bannerH = 70;
  ensureSpace(bannerH + 10);
  /* The AI's internal verdict band is NEVER printed as the recommendation.
     The banner shows the recruiter-workflow status instead: a report that has
     not been recruiter-approved reads "Ready for Recruiter Review"; once a
     recruiter approves it, it reads "Approved with Recruiter Recommendation". */
  const approved = data.isDraft != null ? !data.isDraft : !!data.approvedAt;
  const bc: [number, number, number] = approved ? EMERALD : BRAND;
  const statusLabel = approved
    ? "Approved with Recruiter Recommendation"
    : "Ready for Recruiter Review";
  doc.setFillColor(...LIGHT);
  doc.roundedRect(margin, y, contentW, bannerH, 8, 8, "F");
  doc.setFillColor(...bc);
  doc.roundedRect(margin, y, 6, bannerH, 3, 3, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text("RECOMMENDATION", margin + 20, y + 20);
  doc.setFontSize(15);
  doc.setTextColor(...bc);
  doc.text(statusLabel, margin + 20, y + 40);
  y += bannerH + 6;

  // ── Headline + executive summary ──────────────────────────────────────────
  if (content.headline) {
    sectionHeader("Summary");
    paragraph(content.headline, { size: 12, bold: true, gap: 6 });
  } else {
    sectionHeader("Summary");
  }
  paragraph(content.executiveSummary);

  // ── Role alignment ────────────────────────────────────────────────────────
  if (content.roleAlignment) {
    sectionHeader("Role Alignment");
    paragraph(content.roleAlignment);
  }

  // ── Competencies ──────────────────────────────────────────────────────────
  if (content.competencies?.length) {
    sectionHeader("Competency Assessment");
    for (const c of content.competencies) {
      ensureSpace(30);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...INK);
      doc.text(c.label, margin, y);
      const scoreTxt =
        c.insufficientEvidence || c.score == null
          ? "Insufficient evidence"
          : `${Math.round(c.score)}/100`;
      const col = c.insufficientEvidence || c.score == null ? MUTED : scoreColor(c.score);
      doc.setTextColor(...col);
      const w = doc.getTextWidth(scoreTxt);
      doc.text(scoreTxt, pageW - margin - w, y);
      y += 14;
      if (c.evidence) paragraph(c.evidence, { size: 9.5, color: INK, gap: 2 });
      if (c.rationale) paragraph(c.rationale, { size: 9.5, color: MUTED, gap: 8 });
    }
  }

  // ── Behavioral insights ───────────────────────────────────────────────────
  if (content.behavioralInsights?.length) {
    sectionHeader("Behavioral Insights");
    for (const b of content.behavioralInsights) {
      paragraph(b.dimension, { size: 10, bold: true, gap: 2 });
      paragraph(b.descriptor, { size: 9.5, color: MUTED, gap: 6 });
    }
  }

  // ── Observations ──────────────────────────────────────────────────────────
  if (content.observations?.length) {
    sectionHeader("Key Observations");
    for (const o of content.observations) {
      paragraph(o.observed, { size: 10, bold: true, gap: 2 });
      if (o.whyItMatters)
        paragraph(`Why it matters: ${o.whyItMatters}`, { size: 9.5, color: MUTED, gap: 2 });
      for (const f of o.followUps ?? []) bullet(f, MUTED);
      y += 6;
    }
  }

  // ── Development opportunities ──────────────────────────────────────────────
  if (content.developmentOpportunities?.length) {
    sectionHeader("Development Opportunities");
    for (const d of content.developmentOpportunities) {
      paragraph(`${d.area}  (${d.impact} impact)`, { size: 10, bold: true, gap: 2 });
      if (d.coaching) paragraph(d.coaching, { size: 9.5, color: MUTED, gap: 6 });
    }
  }

  // ── Risk assessment ───────────────────────────────────────────────────────
  const hasRisk =
    content.riskAssessment?.concerns?.length || content.riskAssessment?.toValidate?.length;
  if (hasRisk) {
    sectionHeader("Risk & Points to Validate");
    if (content.riskAssessment.concerns?.length) {
      paragraph("Concerns", { size: 10, bold: true, gap: 2 });
      for (const c of content.riskAssessment.concerns) bullet(c, INK);
      y += 4;
    }
    if (content.riskAssessment.toValidate?.length) {
      paragraph("For the client to validate", { size: 10, bold: true, gap: 2 });
      for (const v of content.riskAssessment.toValidate) bullet(v, INK);
    }
  }

  // ── Verification ──────────────────────────────────────────────────────────
  sectionHeader("Verification");
  {
    const vs = content.verification.status;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...verificationColor(vs));
    doc.text(verificationLabel(vs), margin, y);
    y += 14;
  }
  paragraph(content.verification.summary, { size: 9.5, color: MUTED });

  // ── Recommendation rationale ──────────────────────────────────────────────
  if (content.recommendation?.rationale) {
    sectionHeader("Recommendation Rationale");
    paragraph(content.recommendation.rationale);
  }

  // ── Recruiter comments ────────────────────────────────────────────────────
  if (content.recruiterComments) {
    sectionHeader("Recruiter Notes");
    paragraph(content.recruiterComments);
  }

  // ── Footer on every page ──────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    const prepared = data.preparedBy ? `Prepared by ${data.preparedBy}` : "Prepared with Lexy";
    doc.text(prepared, margin, pageH - 28);
    const pageTxt = `Page ${p} of ${pageCount}`;
    doc.text(pageTxt, pageW - margin - doc.getTextWidth(pageTxt), pageH - 28);
    const conf = data.isDraft
      ? "DRAFT — pending recruiter approval. Confidential — for the intended hiring client only."
      : "Confidential — for the intended hiring client only.";
    if (data.isDraft) doc.setTextColor(...ORANGE);
    doc.text(conf, margin, pageH - 16);
    if (data.isDraft) doc.setTextColor(...MUTED);
  }

  const fileName = `evaluation-${safeName(data.candidateName)}${data.jobTitle ? "-" + safeName(data.jobTitle) : ""}.pdf`;
  return { doc, fileName };
}

export async function downloadEvaluationReportPdf(data: EvaluationReportPdfData): Promise<void> {
  const { doc, fileName } = await buildEvaluationReportPdfDoc(data);
  doc.save(fileName);
}

/**
 * Build the structured evaluation report PDF and return base64 bytes + file
 * name, for attaching to an outbound email (hm-share route).
 */
export async function getEvaluationReportPdfBase64(
  data: EvaluationReportPdfData,
): Promise<{ base64: string; fileName: string }> {
  const { doc, fileName } = await buildEvaluationReportPdfDoc(data);
  const uri = doc.output("datauristring");
  const idx = uri.indexOf("base64,");
  const base64 = idx >= 0 ? uri.slice(idx + "base64,".length) : "";
  return { base64, fileName };
}
