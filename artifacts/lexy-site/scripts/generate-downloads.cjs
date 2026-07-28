/* Generates branded downloadable PDF assets into public/downloads/. Run: node scripts/generate-downloads.cjs */
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "downloads");
fs.mkdirSync(OUT, { recursive: true });

// Brand palette — matches the site design tokens (--primary: hsl(210 100% 45%)).
const BLUE = "#0073e6";
const DARK = "#0d1b3e"; // logo navy
const GREY = "#475569";
const LIGHT = "#dbeafe";

const LOGO = path.join(__dirname, "..", "public", "lexy-ai-logo-transparent.png");

// Draws the real L3XY AI logo at (x, y) with the given height.
function wordmark(doc, x, y, h) {
  doc.image(LOGO, x, y, { height: h });
}

function newDoc(file, title, subtitle) {
  const doc = new PDFDocument({
    size: "A4",
    bufferPages: true,
    margins: { top: 84, bottom: 72, left: 56, right: 56 },
  });
  doc._brandTitle = title;
  doc.pipe(fs.createWriteStream(path.join(OUT, file)));

  // Title block (first page only)
  doc
    .fillColor(DARK)
    .font("Helvetica-Bold")
    .fontSize(24)
    .text(title, 56, 96, {
      width: doc.page.width - 112,
    });
  if (subtitle) {
    doc.moveDown(0.3);
    doc
      .fillColor(GREY)
      .font("Helvetica")
      .fontSize(11)
      .text(subtitle, { width: doc.page.width - 112, lineGap: 2 });
  }
  doc.moveDown(1);
  hr(doc);
  doc.moveDown(1);
  return doc;
}

// Stamps the brand chrome (header band, wordmark, footer, page number) on every page.
function brandAllPages(doc) {
  const range = doc.bufferedPageRange();
  const total = range.start + range.count;
  for (let i = range.start; i < total; i++) {
    doc.switchToPage(i);
    // Writing in the footer area must not trigger an automatic page break.
    doc.page.margins.bottom = 0;
    const W = doc.page.width;
    const H = doc.page.height;
    // Top brand band
    doc.rect(0, 0, W, 6).fill(BLUE);
    // Header: wordmark left, tagline/doc title right
    wordmark(doc, 52, 16, 30);
    doc
      .fillColor("#94a3b8")
      .font("Helvetica")
      .fontSize(8)
      .text(i === 0 ? "Evidence-based hiring" : doc._brandTitle, 56, 30, {
        align: "right",
        width: W - 112,
        lineBreak: false,
      });
    doc
      .strokeColor(LIGHT)
      .lineWidth(0.75)
      .moveTo(56, 52)
      .lineTo(W - 56, 52)
      .stroke();
    // Footer: rule + wordmark-lite left, page number right
    doc
      .strokeColor(LIGHT)
      .lineWidth(0.75)
      .moveTo(56, H - 48)
      .lineTo(W - 56, H - 48)
      .stroke();
    doc
      .fillColor("#94a3b8")
      .font("Helvetica-Bold")
      .fontSize(8)
      .text("L3XY", 56, H - 38, { lineBreak: false });
    doc
      .fillColor("#94a3b8")
      .font("Helvetica")
      .fontSize(8)
      .text("  —  www.l3xy.ai", { lineBreak: false });
    doc
      .fillColor("#94a3b8")
      .font("Helvetica")
      .fontSize(8)
      .text(`${i + 1} / ${total}`, 56, H - 38, {
        align: "right",
        width: W - 112,
        lineBreak: false,
      });
  }
}

function hr(doc) {
  doc
    .strokeColor(LIGHT)
    .lineWidth(1)
    .moveTo(56, doc.y)
    .lineTo(doc.page.width - 56, doc.y)
    .stroke();
}

function h2(doc, text) {
  ensureSpace(doc, 60);
  doc.moveDown(0.8);
  doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(14).text(text);
  doc.moveDown(0.4);
}

function p(doc, text) {
  doc
    .fillColor(GREY)
    .font("Helvetica")
    .fontSize(10)
    .text(text, { width: doc.page.width - 112, lineGap: 2 });
  doc.moveDown(0.4);
}

function bullets(doc, items) {
  for (const item of items) {
    ensureSpace(doc, 30);
    doc
      .fillColor(GREY)
      .font("Helvetica")
      .fontSize(10)
      .text(`•  ${item}`, {
        width: doc.page.width - 124,
        indent: 0,
        lineGap: 2,
      });
    doc.moveDown(0.2);
  }
  doc.moveDown(0.3);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - 72) doc.addPage();
}

function table(doc, headers, rows, widths) {
  const x0 = 56;
  const totalW = doc.page.width - 112;
  const ws = widths.map((w) => w * totalW);
  const rowH = (cells, font, size) => {
    let max = 18;
    cells.forEach((c, i) => {
      const h =
        doc
          .font(font)
          .fontSize(size)
          .heightOfString(String(c), { width: ws[i] - 12 }) + 10;
      if (h > max) max = h;
    });
    return max;
  };

  const drawRow = (cells, { header = false } = {}) => {
    const font = header ? "Helvetica-Bold" : "Helvetica";
    const size = header ? 9.5 : 9.5;
    const h = rowH(cells, font, size);
    ensureSpace(doc, h + 4);
    const y = doc.y;
    if (header) doc.rect(x0, y, totalW, h).fill("#eff6ff");
    let x = x0;
    cells.forEach((c, i) => {
      doc
        .fillColor(header ? BLUE : GREY)
        .font(font)
        .fontSize(size)
        .text(String(c), x + 6, y + 5, { width: ws[i] - 12, lineGap: 1 });
      x += ws[i];
    });
    doc.strokeColor(LIGHT).lineWidth(0.5);
    let xx = x0;
    for (let i = 0; i <= cells.length; i++) {
      doc
        .moveTo(xx, y)
        .lineTo(xx, y + h)
        .stroke();
      xx += ws[i] || 0;
    }
    doc
      .moveTo(x0, y)
      .lineTo(x0 + totalW, y)
      .stroke();
    doc
      .moveTo(x0, y + h)
      .lineTo(x0 + totalW, y + h)
      .stroke();
    doc.y = y + h;
    doc.x = 56;
  };

  drawRow(headers, { header: true });
  rows.forEach((r) => drawRow(r));
  doc.moveDown(0.6);
}

function finish(doc) {
  doc.moveDown(1.5);
  hr(doc);
  doc.moveDown(0.5);
  doc
    .fillColor(GREY)
    .font("Helvetica")
    .fontSize(8.5)
    .text(
      "© 2026 L3XY AI — free to use and share within your organization. L3XY runs structured AI interviews that turn every candidate into verified hiring signals. Learn more at www.l3xy.ai",
      { width: doc.page.width - 112 },
    );
  brandAllPages(doc);
  doc.end();
}

/* 1. Interview Scorecard */
(() => {
  const doc = newDoc(
    "l3xy-interview-scorecard.pdf",
    "Interview Scorecard",
    "One scorecard per candidate, per interview. Score independently, before any debrief discussion.",
  );
  p(doc, "Candidate: ______________________________    Role: ______________________________");
  p(doc, "Interviewer: _____________________________    Date: ______________________________");
  h2(doc, "Competency scores");
  p(
    doc,
    "Score each competency 1–5 against the rubric anchors. The evidence field is required — a score without observed evidence is not valid.",
  );
  table(
    doc,
    ["Competency", "Score (1–5)", "Evidence — what did the candidate say or do?"],
    [
      ["Problem solving", "", ""],
      ["Communication", "", ""],
      ["Ownership", "", ""],
      ["Adaptability", "", ""],
      ["Role-specific skill 1: ____________", "", ""],
      ["Role-specific skill 2: ____________", "", ""],
    ],
    [0.28, 0.12, 0.6],
  );
  h2(doc, "Recommendation (complete last)");
  bullets(doc, [
    "[  ] Strong hire — evidence strong across all competencies",
    "[  ] Hire — evidence solid; note any watch areas below",
    "[  ] No hire — evidence weak on one or more core competencies",
    "[  ] Insufficient evidence — recommend an additional structured session",
  ]);
  p(doc, "Watch areas / notes (behavioral observations only — no personality judgments):");
  p(doc, "_________________________________________________________________________________");
  p(doc, "_________________________________________________________________________________");
  h2(doc, "Rules that protect the data");
  bullets(doc, [
    "Score during or immediately after the interview — never from memory the next day.",
    "Complete this scorecard BEFORE discussing the candidate with anyone.",
    "Describe behavior, not character: what was said and done, not what kind of person they seemed.",
    "Never note age, family status, accent, appearance, health, or any protected characteristic.",
  ]);
  finish(doc);
})();

/* 2. Interview Rubric */
(() => {
  const doc = newDoc(
    "l3xy-interview-rubric.pdf",
    "Interview Scoring Rubric",
    "Anchored 1–5 scale. Write anchors before interviewing anyone; score answers against anchors, not against other candidates.",
  );
  h2(doc, "The universal anchor scale");
  table(
    doc,
    ["Score", "Anchor", "What it looks like in an answer"],
    [
      ["1", "No evidence", "Vague, generic, or evasive. Cannot name specifics when probed twice."],
      [
        "2",
        "Weak",
        "Real example, but the candidate's own role is unclear or minimal ('we did...' with no 'I').",
      ],
      [
        "3",
        "Solid",
        "Specific example, clear personal actions, plausible outcome. The baseline for a hire-quality answer.",
      ],
      [
        "4",
        "Strong",
        "Specific and personally owned, plus reflection — can articulate what they'd do differently.",
      ],
      [
        "5",
        "Exceptional",
        "All of 4, plus evidence the behavior is repeated and deliberate, not a one-off survival story.",
      ],
    ],
    [0.1, 0.18, 0.72],
  );
  h2(doc, "Worked example — 'Tell me about delivering bad news to a stakeholder'");
  table(
    doc,
    ["Score", "Anchored description"],
    [
      [
        "1",
        "No specific example, or example shows avoidance (delayed, delegated, or softened the message into meaninglessness).",
      ],
      [
        "3",
        "Specific example; delivered the news directly; can describe the stakeholder's reaction and their own follow-up.",
      ],
      [
        "5",
        "All of 3, plus prepared the stakeholder in advance or brought options, and can articulate what they'd change — a deliberate approach, not a survived incident.",
      ],
    ],
    [0.1, 0.9],
  );
  h2(doc, "Writing rules for your own anchors");
  bullets(doc, [
    "Anchor 1, 3, and 5. Leave 2 and 4 as between-states — full anchoring adds work, not reliability.",
    "Use content criteria, not delivery criteria. 'Named the tradeoff explicitly' beats 'confident tone'.",
    "Test anchors on real answers: two scorers more than one point apart means the anchor is ambiguous — rewrite it.",
    "If every candidate scores 4+, the anchors are too soft. Recalibrate.",
  ]);
  finish(doc);
})();

/* 3. Competency Matrix */
(() => {
  const doc = newDoc(
    "l3xy-competency-matrix.pdf",
    "Competency Matrix",
    "Define 4–6 competencies per role before writing a single interview question. Fewer, measured well, beats many measured loosely.",
  );
  h2(doc, "How to use this matrix");
  bullets(doc, [
    "1. List the capabilities that separate strong performers from weak ones in THIS role — not generic virtues.",
    "2. For each, write an observable definition: what does demonstrating it look like?",
    "3. Map each competency to 2 interview questions (see the Question Bank).",
    "4. Weight competencies if they are not equally important — and decide weights before interviewing.",
  ]);
  h2(doc, "Role competency matrix");
  p(doc, "Role: ______________________________    Level: ______________________________");
  table(
    doc,
    ["Competency", "Observable definition (what demonstrating it looks like)", "Weight", "Q1 / Q2"],
    [
      ["", "", "", ""],
      ["", "", "", ""],
      ["", "", "", ""],
      ["", "", "", ""],
      ["", "", "", ""],
      ["", "", "", ""],
    ],
    [0.22, 0.5, 0.1, 0.18],
  );
  h2(doc, "Example — Senior Customer Success Manager");
  table(
    doc,
    ["Competency", "Observable definition", "Weight"],
    [
      [
        "Commercial judgment",
        "Can walk through a renewal they saved or expanded, with the specific levers they used and why.",
        "30%",
      ],
      [
        "Difficult conversations",
        "Can describe delivering unwelcome news to a customer directly, with preparation and follow-up.",
        "25%",
      ],
      [
        "Prioritization",
        "Can explain how they triaged a book of 40+ accounts, including what they deliberately dropped.",
        "25%",
      ],
      [
        "Cross-team influence",
        "Can give an example of getting product/engineering to act on a customer need without authority.",
        "20%",
      ],
    ],
    [0.24, 0.62, 0.14],
  );
  h2(doc, "Quality checks");
  bullets(doc, [
    "Every competency is observable in an interview. ('Passion' and 'hunger' are not — cut them.)",
    "A current strong performer would score 4+ on every row. If not, the definitions are wrong.",
    "No more than 6 rows. Interviewer fatigue makes later scores soft.",
  ]);
  finish(doc);
})();

/* 4. Interview Question Bank */
(() => {
  const doc = newDoc(
    "l3xy-interview-question-bank.pdf",
    "Interview Question Bank",
    "Behavioral and situational questions organized by competency. Ask the same questions, in the same order, to every candidate for the role.",
  );
  const sections = [
    [
      "Problem solving",
      [
        "Walk me through the most complex problem you've solved in the last year. What made it hard, and what did you actually do?",
        "Imagine you inherit a project that's behind schedule and the original owner is gone. What are your first three moves?",
        "Tell me about a time the obvious solution was wrong. How did you figure that out?",
        "Describe a problem you solved with far fewer resources than you needed.",
      ],
    ],
    [
      "Communication",
      [
        "Tell me about a time you had to explain something technical or complicated to someone who disagreed with you.",
        "If you had to give this team one piece of difficult feedback after your first month, how would you deliver it?",
        "Describe a time a message you sent landed badly. What did you do next?",
        "Tell me about persuading someone senior to change course.",
      ],
    ],
    [
      "Ownership",
      [
        "Describe a time something failed and it was at least partly your fault. What happened afterward?",
        "Tell me about a time you did work nobody asked you to do. Why did you do it?",
        "Describe the moment you realized a commitment you'd made couldn't be met. What did you do in the first 24 hours?",
        "What is something broken in your current/last role that you fixed without being told to?",
      ],
    ],
    [
      "Adaptability",
      [
        "Tell me about a time priorities changed suddenly under you. What did you keep, and what did you drop?",
        "What's a strongly held opinion about your work you've reversed in the last two years?",
        "Describe joining a team or company whose way of working conflicted with yours.",
        "Tell me about learning a skill under deadline pressure.",
      ],
    ],
    [
      "Collaboration",
      [
        "Tell me about a conflict with a colleague where you were partly wrong.",
        "Describe a time you helped a teammate succeed at cost to your own workload.",
        "Tell me about working closely with someone whose style was opposite to yours.",
        "Describe a decision your team made that you disagreed with. What did you do after it was made?",
      ],
    ],
    [
      "Leadership (for senior roles)",
      [
        "Tell me about the hardest personnel decision you've made.",
        "Describe raising the bar on a team that was comfortable.",
        "Tell me about a time you delegated something important and it went wrong.",
        "How did you decide what NOT to do last quarter? Walk me through a real example.",
      ],
    ],
  ];
  for (const [title, qs] of sections) {
    h2(doc, title);
    bullets(doc, qs);
  }
  h2(doc, "Probing follow-ups (use on any question)");
  bullets(doc, [
    "What did YOU do — specifically?",
    "What happened in the first hour / first day?",
    "What would you do differently now?",
    "How do you know it worked? What did you measure?",
  ]);
  finish(doc);
})();

/* 5. Hiring Evidence Checklist */
(() => {
  const doc = newDoc(
    "l3xy-hiring-evidence-checklist.pdf",
    "Hiring Evidence Checklist",
    "Run every hiring decision through this checklist before making an offer — or a rejection.",
  );
  h2(doc, "The evidence standard");
  p(
    doc,
    "Evidence is observed (not claimed), comparable (same standard for every candidate), and verifiable (a second reviewer would reach a similar conclusion).",
  );
  h2(doc, "Before interviewing");
  bullets(doc, [
    "[  ] Competencies for the role are defined and observable (see Competency Matrix)",
    "[  ] Every candidate will face the same questions, in the same order",
    "[  ] Scoring anchors are written — before any candidate is interviewed",
    "[  ] Interviewers know to score independently, before any debrief",
  ]);
  h2(doc, "For each candidate");
  bullets(doc, [
    "[  ] Every competency score has a written evidence note (what was said/done)",
    "[  ] Claims that matter were probed — 'what did you do in the first hour?'",
    "[  ] Skills central to the role were demonstrated, not just discussed",
    "[  ] No score is based on rapport, confidence, or similarity to the interviewer",
    "[  ] Nothing on the record references a protected characteristic",
  ]);
  h2(doc, "At the decision");
  bullets(doc, [
    "[  ] Scores were recorded independently before the debrief",
    "[  ] Disagreements were resolved by re-examining specific answers, not by averaging",
    "[  ] The decision can be stated as: 'scored X against rubric Y, here are the responses'",
    "[  ] A rejected candidate could be told the real reason without embarrassment",
  ]);
  h2(doc, "The one-question audit");
  p(
    doc,
    "For any decision, ask: what did we OBSERVE, and can we DEFEND it? If the honest answer is 'the team felt good about them' — you have a guess, not a decision.",
  );
  finish(doc);
})();

/* 6. AI Vendor Evaluation Checklist */
(() => {
  const doc = newDoc(
    "l3xy-ai-vendor-evaluation-checklist.pdf",
    "AI Hiring Vendor Evaluation Checklist",
    "The questions to ask any AI interview or assessment vendor — and the answers that should end the meeting.",
  );
  h2(doc, "Transparency");
  bullets(doc, [
    "[  ] For any score, can we see the evidence trail — transcript, rubric anchor, reasoning?",
    "[  ] Can the candidate-facing experience be demoed end to end?",
    "[  ] Is there a documented model/system card describing what the AI does and doesn't do?",
  ]);
  h2(doc, "Fairness engineering");
  bullets(doc, [
    "[  ] What is redacted before scoring (names, demographic signals, accent markers)?",
    "[  ] Can they show adverse-impact monitoring (e.g., four-fifths analysis) — actual reports, not policy statements?",
    "[  ] Is scoring validated against calibrated human expert scores? How often is drift checked?",
  ]);
  h2(doc, "Human oversight");
  bullets(doc, [
    "[  ] Which decisions does a human make, and where is that recorded?",
    "[  ] What happens when the AI is uncertain — flagged for review, or silently rounded?",
    "[  ] Can a candidate request human review where regulation requires it?",
  ]);
  h2(doc, "Data & compliance");
  bullets(doc, [
    "[  ] Data processing agreement, retention policy, and deletion path in writing",
    "[  ] Candidate notice and consent flows appropriate to your jurisdictions (NYC LL144, EU AI Act, etc.)",
    "[  ] Where is data stored and who can access it?",
  ]);
  h2(doc, "Red flags — end the meeting");
  bullets(doc, [
    "Facial-expression, tone-of-voice, or personality inference 'analysis'",
    "Scores with no visible reasoning or transcript",
    "Claims of 'eliminating' bias (serious vendors reduce and measure)",
    "No answer to 'show me one candidate's full evidence trail'",
  ]);
  finish(doc);
})();

/* 7. Candidate Story Bank Worksheet */
(() => {
  const doc = newDoc(
    "l3xy-story-bank-worksheet.pdf",
    "Interview Story Bank Worksheet",
    "Prepare evidence, not answers. Six stories at this depth will answer almost any structured interview question.",
  );
  h2(doc, "How to use this worksheet");
  p(
    doc,
    "Fill one block per story from your real experience. Write facts, not scripts — in the interview you'll retrieve, not recite. Rehearse each story out loud at least once.",
  );
  const prompts = [
    "A hard problem you solved",
    "A failure you owned",
    "A conflict you handled",
    "A time priorities collapsed",
    "Something you built or improved",
    "A time you changed your mind",
  ];
  for (const title of prompts) {
    h2(doc, title);
    bullets(doc, [
      "Situation (2 sentences — enough context to make the stakes clear): ______________________________________________",
      "MY actions (specifically yours, not the team's — this is where probes go): __________________________________",
      "Outcome (with a number if one exists): _____________________________________________________________________",
      "What I'd do differently now: _______________________________________________________________________________",
    ]);
  }
  h2(doc, "In the room");
  bullets(doc, [
    "Answer the question asked, then stop. Structured interviewers probe for what they need.",
    "Say 'I', not 'we', when it was you.",
    "Real beats ideal — vagueness is what rubrics score down hardest.",
    "Take the two-second pause to pick the right story. It reads as composure.",
  ]);
  finish(doc);
})();

/* 8. Structured Hiring Rollout Checklist */
(() => {
  const doc = newDoc(
    "l3xy-structured-hiring-rollout.pdf",
    "Structured Hiring Rollout Checklist",
    "A 30/60/90 plan for moving an organization from ad-hoc interviews to consistent, evidence-based hiring.",
  );
  h2(doc, "Days 1–30 — Foundation");
  bullets(doc, [
    "[  ] Pick one high-volume role family as the pilot",
    "[  ] Define 4–6 competencies with observable definitions (Competency Matrix)",
    "[  ] Write the question set and scoring anchors (Question Bank + Rubric)",
    "[  ] Pilot the interview on 2–3 current strong performers; rewrite what doesn't differentiate",
    "[  ] Brief interviewers: independent scoring, evidence notes, behavioral language",
  ]);
  h2(doc, "Days 31–60 — Pilot");
  bullets(doc, [
    "[  ] Run all pilot-role interviews on the structured process",
    "[  ] Enforce scorecard-before-debrief on every panel",
    "[  ] Review score distributions weekly: anchors too soft? interviewer outliers?",
    "[  ] Collect candidate feedback on the experience",
  ]);
  h2(doc, "Days 61–90 — Scale");
  bullets(doc, [
    "[  ] Fix what the pilot exposed (questions that didn't differentiate, ambiguous anchors)",
    "[  ] Extend to the next 2–3 role families, reusing the template",
    "[  ] Stand up adverse-impact monitoring: pass rates by stage, by group",
    "[  ] Set the quarterly loop: compare interview scores to on-the-job performance and refine",
  ]);
  h2(doc, "What makes rollouts fail");
  bullets(doc, [
    "Mandating structure without making it the EASY path (pre-built questions, rubrics, tooling)",
    "Letting senior interviewers opt out — inconsistency at the top licenses it everywhere",
    "Skipping the outcome loop — without validation, the process never improves and support erodes",
  ]);
  finish(doc);
})();

console.log("Generated 8 PDFs in", OUT);

// Bundle all PDFs into the email-gated Complete Hiring Toolkit ZIP.
// Deferred so all PDF write streams have flushed.
process.on("exit", () => {
  const { execFileSync } = require("child_process");
  try {
    execFileSync(
      "zip",
      ["-j", "-q", "l3xy-complete-hiring-toolkit.zip"].concat(
        fs.readdirSync(OUT).filter((f) => f.endsWith(".pdf")),
      ),
      { cwd: OUT },
    );
    console.log("Bundled l3xy-complete-hiring-toolkit.zip");
  } catch (e) {
    console.error("ZIP bundling failed:", e.message);
  }
});
