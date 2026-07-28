/**
 * interview-report-pdf.ts — Client-shareable "Interview Performance" PDF.
 *
 * Produces a polished, client-ready report a recruiter can download from the
 * interview detail page and forward to their client (the hiring employer). It
 * summarizes a single completed AI interview: overall score, per-question
 * scores, strengths, areas to develop, concerns, the AI recommendation, and a
 * dedicated section for the recruiter's own written comments.
 *
 * Pure jsPDF (no html2canvas) so output is crisp vector text and the bundle is
 * framework-agnostic. Mirrors the visual language of evaluation-pdf.ts.
 */
import { jsPDF } from "jspdf";

export interface InterviewQuestionScore {
  questionText: string;
  score: number | null;
  /** The assessor's analysis of how the candidate answered — NOT the verbatim answer. */
  feedback?: string | null;
}

export interface InterviewReportPdfData {
  candidate: {
    name: string;
    title?: string | null;
    email?: string | null;
  };
  interviewType?: string | null;
  totalQuestions?: number | null;
  completedAt?: string | null;
  overallScore: number | null;
  questionScores?: InterviewQuestionScore[];
  strengths?: string[];
  weaknesses?: string[];
  redFlags?: string[];
  recommendation?: string | null;
  aiSummary?: string | null;
  recruiterComments?: string | null;
  /** Optional name of the recruiter / agency preparing the report. */
  preparedBy?: string | null;
}

// ── Palette ───────────────────────────────────────────────────────────────────
const BAND_BLUE: [number, number, number] = [15, 35, 80];   // deep navy — header band
const ACCENT: [number, number, number]   = [0, 188, 212];   // brand cyan — section labels
const INK: [number, number, number] = [17, 24, 39];
const MUTED: [number, number, number] = [107, 114, 128];
const LIGHT: [number, number, number] = [243, 244, 246];
const BORDER: [number, number, number] = [226, 232, 240];
const GREEN: [number, number, number] = [22, 163, 74];
const AMBER: [number, number, number] = [217, 119, 6];
const RED: [number, number, number] = [220, 38, 38];

/**
 * Derive a concise topic label from a full interview question turn.
 *
 * Lexy's stored `questionText` is its *complete* conversational turn —
 * social opener ("Hello Ketankumar…", "That's a great point. Let's shift to…")
 * PLUS the actual question at the end. This function isolates the real question
 * and returns a short topic phrase (≤60 chars) suitable for a PDF heading.
 *
 * Algorithm:
 *  1. Strip "Lexy: " speaker prefix.
 *  2. Split into sentences; find the last one containing a question keyword.
 *  3. If that sentence still starts with filler ("Before we begin,", "Just",
 *     "So, "), slice from the first substantive question verb inside it.
 *  4. Strip standard opener phrases ("Can you explain…", "Tell me about…")
 *     to expose the topic noun phrase.
 *  5. Capitalise + truncate to 60 chars.
 */
function deriveTopicLabel(questionText: string): string {
  // 1. Strip speaker prefix
  const text = questionText.replace(/^lexy:\s*/i, "").trim();

  // 2. Split on sentence-ending punctuation
  const sentences = text
    .split(/[.?!]+(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);

  // 3. Find the last sentence that contains a question keyword
  //    (includes "when" which was previously missing)
  const questionKeyword =
    /\b(what|when|how|can you|could you|describe|explain|walk me|tell me|why|which|have you|do you|would you|is there|are you)\b/i;

  let core = sentences[sentences.length - 1] ?? text;
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (questionKeyword.test(sentences[i])) {
      core = sentences[i];
      break;
    }
  }

  // 4. If the sentence starts with conversational filler before the real
  //    question word, slice from the question word forward.
  //    e.g. "Before we begin, could you…" → "could you…"
  //    e.g. "So, how would you…"          → "how would you…"
  const pivotMatch = core.match(
    /(?:,\s*|\bso\s+|\bjust\s+|\bnow\s+|\bfirst\s+|\bsimply\s+)(?:can you |could you |please |would you |tell me |describe |explain |how |what |when |why |have you |do you )/i,
  );
  if (pivotMatch && pivotMatch.index !== undefined && pivotMatch.index > 0) {
    core = core.slice(pivotMatch.index).replace(/^[,\s]+/, "").trim();
  }

  // 5. Try to strip generic opener phrases to expose the topic noun phrase.
  //    e.g. "Can you explain how you handle…" → "how you handle…"
  //    e.g. "Tell me about your experience with…" → "your experience with…"
  //    SAFETY CHECK: only accept the stripped result if it doesn't begin with
  //    a connector/pronoun (it, and, that, this…) — those indicate we cut
  //    mid-phrase and created a grammatical fragment.
  const openers =
    /^(?:(?:and |but |so |now |also |additionally |finally |lastly |next |just )?(?:can you |could you |please |would you (?:mind )?)?)?(?:tell (?:me )?(?:a (?:bit |little )?)?(?:about |more about )?|describe (?:your |a )?(?:experience (?:with |in )?)?|explain (?:your |how |the |a )?|walk (?:me )?through (?:your |a )?|talk (?:me )?through (?:your |a )?|share (?:your |a )?(?:experience (?:with )?)?|give me (?:an? )?(?:example of |overview of )?|discuss (?:your )?|elaborate on (?:your )?)/i;

  const stripped = core.replace(openers, "").replace(/\?$/, "").trim();
  const fragmentStart = /^(it|and|that|this|there|which|them|they|he|she|we)\b/i;

  let label: string;
  if (stripped.length > 12 && !fragmentStart.test(stripped)) {
    label = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  } else {
    // Opener stripping would create a fragment — keep the full sentence
    label = core.replace(/\?$/, "").trim();
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }

  // 6. Truncate to 90 chars at a word boundary
  if (label.length <= 90) return label;
  const cut = label.slice(0, 87);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + "…";
}

// Interview-performance bands — a candidate-performance quantity distinct from
// match fit, with its own (deliberately stricter) colour/label cutoffs. Any
// equality with a match cutoff is coincidental, not a dependency.
const PERF_COLOR_STRONG = 85;
const PERF_COLOR_MODERATE = 70;
const PERF_LABEL_EXCEPTIONAL = 85;
const PERF_LABEL_STRONG = 75;
const PERF_LABEL_SOLID = 60;
function scoreColor(score: number): [number, number, number] {
  if (score >= PERF_COLOR_STRONG) return GREEN;
  if (score >= PERF_COLOR_MODERATE) return AMBER;
  return RED;
}

function scoreLabel(score: number): string {
  if (score >= PERF_LABEL_EXCEPTIONAL) return "Exceptional performance";
  if (score >= PERF_LABEL_STRONG) return "Strong performance";
  if (score >= PERF_LABEL_SOLID) return "Solid performance";
  return "Developing performance";
}

function recommendationLabel(rec: string): { label: string; color: [number, number, number] } {
  const r = (rec || "").toLowerCase();
  if (r === "yes" || r === "advance") return { label: "Advance to Next Stage", color: GREEN };
  if (r === "no" || r === "decline") return { label: "Do Not Advance", color: RED };
  return { label: "Needs Further Review", color: AMBER };
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

export async function generateInterviewReportPdf(data: InterviewReportPdfData): Promise<void> {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentW = pageW - margin * 2;
  const bottomLimit = pageH - 56;
  let y = 0;

  const logoDataUrl = await fetchLogoDataUrl();

  const { candidate } = data;
  const fullName = candidate.name?.trim() || "Candidate";

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
    doc.setTextColor(...ACCENT);
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

  const bulletList = (items: string[], marker: [number, number, number]) => {
    for (const item of items) {
      if (!item) continue;
      const lineH = 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      const lines = doc.splitTextToSize(item, contentW - 16);
      ensureSpace(lineH);
      doc.setTextColor(...marker);
      doc.text("•", margin + 2, y);
      doc.setTextColor(...INK);
      doc.text(lines[0] ?? "", margin + 16, y);
      y += lineH;
      for (let i = 1; i < lines.length; i++) {
        ensureSpace(lineH);
        doc.text(lines[i], margin + 16, y);
        y += lineH;
      }
    }
    y += 4;
  };

  // ── Header band ───────────────────────────────────────────────────────────
  const bandH = 104;
  doc.setFillColor(...BAND_BLUE);
  doc.rect(0, 0, pageW, bandH, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("INTERVIEW PERFORMANCE REPORT", margin, 38);

  doc.setFontSize(24);
  doc.text(fullName, margin, 66);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const sub = [candidate.title, candidate.email].filter(Boolean).join("  ·  ");
  if (sub) doc.text(sub, margin, 86);

  // Right-aligned logo + date
  // The L3xy AI logo is a wide white-on-black wordmark — render it on a black
  // rounded pill so it reads cleanly against the violet band.
  const logoW = 114;
  const logoH = 36;
  const logoX = pageW - margin - logoW;
  const logoY = 14;
  if (logoDataUrl) {
    // Black rounded pill background
    doc.setFillColor(0, 0, 0);
    (doc as any).roundedRect(logoX - 8, logoY - 6, logoW + 16, logoH + 12, 6, 6, "F");
    doc.addImage(logoDataUrl, "PNG", logoX, logoY, logoW, logoH);
  } else {
    // Fallback text when logo can't be fetched
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

  // ── Interview meta ──────────────────────────────────────────────────────
  const metaParts: string[] = [];
  if (data.interviewType) metaParts.push(`${data.interviewType} interview`);
  if (data.completedAt) {
    const d = new Date(data.completedAt);
    if (!isNaN(d.getTime()))
      metaParts.push(
        `Completed ${d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
      );
  }
  // Bug fix: use actual scored question count if available — the session's
  // stored totalQuestions may be stale (e.g. created with an old default).
  const actualQCount =
    (data.questionScores ?? []).filter((q) => q.questionText).length || data.totalQuestions;
  if (actualQCount != null) metaParts.push(`${actualQCount} questions`);
  if (metaParts.length) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...MUTED);
    doc.text(metaParts.join("  ·  "), margin, y);
    y += 18;
  }

  // ── Overall score ─────────────────────────────────────────────────────────
  sectionHeading("Overall Performance");
  if (data.overallScore != null) {
    const sc = Math.round(data.overallScore);
    const col = scoreColor(sc);
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
    doc.text("OVERALL SCORE", margin + boxW / 2, y + 54, { align: "center" });

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
    const rl = doc.splitTextToSize(
      "Match score — Lexy's overall assessment of the candidate's fit, weighed across every answer in the interview. The reasoning behind it is detailed below.",
      contentW - boxW - 18,
    );
    doc.text(rl, tx, ty);
    y += boxH + 10;
  } else {
    paragraph("This interview has not been scored.", { color: MUTED });
  }

  // ── Per-question scores ────────────────────────────────────────────────────
  const qScores = (data.questionScores ?? []).filter((q) => q.questionText);
  if (qScores.length) {
    sectionHeading("Answer-by-Answer Analysis");
    paragraph(
      "Lexy's assessment of how the candidate responded to each question — what stood out, what was missing, and why it earned its score. This is an analysis, not a transcript.",
      { size: 9, color: MUTED },
    );
    y += 6;
    qScores.forEach((q, i) => {
      ensureSpace(20);
      const hasScore = typeof q.score === "number";
      const sc = hasScore ? Math.round(q.score as number) : null;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...INK);
      const topicLabel = `Q${i + 1}: ${deriveTopicLabel(q.questionText)}`;
      doc.text(topicLabel, margin, y);
      doc.setTextColor(...(sc == null ? MUTED : scoreColor(sc)));
      doc.text(sc == null ? "—" : `${sc}%`, pageW - margin, y, { align: "right" });
      y += 14;
      // Assessor's analysis of the answer (never the verbatim answer).
      const fb = (q.feedback ?? "").trim();
      if (fb) {
        y += 2;
        doc.setFont("helvetica", "italic");
        doc.setFontSize(9);
        doc.setTextColor(...MUTED);
        const fbLines = doc.splitTextToSize(fb, contentW - 16);
        for (const line of fbLines) {
          ensureSpace(13);
          doc.text(line, margin + 12, y);
          y += 13;
        }
        doc.setFont("helvetica", "normal");
      }
      y += 8;
    });
  }

  // ── Strengths ──────────────────────────────────────────────────────────────
  const strengths = (data.strengths ?? []).filter(Boolean);
  if (strengths.length) {
    sectionHeading("Strengths");
    bulletList(strengths, GREEN);
  }

  // ── Areas to develop ───────────────────────────────────────────────────────
  const weaknesses = (data.weaknesses ?? []).filter(Boolean);
  if (weaknesses.length) {
    sectionHeading("Areas to Develop");
    bulletList(weaknesses, AMBER);
  }

  // ── Concerns ───────────────────────────────────────────────────────────────
  const redFlags = (data.redFlags ?? []).filter(Boolean);
  if (redFlags.length) {
    sectionHeading("Concerns");
    bulletList(redFlags, RED);
  }

  // ── Recommendation + AI summary ───────────────────────────────────────────
  sectionHeading("Assessment");
  const rec = recommendationLabel(data.recommendation ?? "maybe");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  ensureSpace(16);
  doc.text("Recommendation:", margin, y);
  doc.setTextColor(...rec.color);
  doc.text(rec.label, margin + doc.getTextWidth("Recommendation:  "), y);
  y += 18;
  if (data.aiSummary) {
    paragraph(data.aiSummary, { color: INK });
    y += 6;
  }

  // ── Recruiter comments ─────────────────────────────────────────────────────
  const comments = (data.recruiterComments ?? "").trim();
  sectionHeading("Recruiter Comments");
  if (comments) {
    paragraph(comments, { color: INK });
  } else {
    paragraph("No recruiter comments were added to this report.", { color: MUTED });
  }
  y += 6;

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
  doc.save(`Interview-Report-${safeName}.pdf`);
}
