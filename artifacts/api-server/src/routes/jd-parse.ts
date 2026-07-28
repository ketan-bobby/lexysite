/**
 * routes/jd-parse.ts — Job-Description text extractor
 *
 * Accepts a multipart upload of a PDF / DOCX / DOC file and returns the raw
 * extracted plain text so the frontend can pre-fill the JD textarea before
 * submitting the job. Without this endpoint, PDF/DOC uploads on the
 * Create-Job dialog never reach the LLM and the ICP gets generated from an
 * empty description (causing the model to hallucinate the role from the
 * title alone).
 *
 * Route: POST /api/jobs/parse-jd
 *   • Field name: "file"
 *   • Returns:    { text: string, fileName: string, charCount: number }
 *   • 422 if the file type is unsupported, 400 if no file attached.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { createRequire } from "node:module";
import mammoth from "mammoth";
import { logger } from "../lib/logger.js";
import { resolveUser } from "../middlewares/resolveUser";

const _require = createRequire(import.meta.url);
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = _require("pdf-parse");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

/* Wrap multer so file-size / type errors return clean JSON instead of HTML. */
function uploadSingle(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File too large — JD must be under 15 MB." });
      return;
    }
    res.status(400).json({ error: err.message || "File upload failed" });
  });
}

const router: IRouter = Router();

/* No JSON body validation: this is a pure multipart route. The `file` part
 * is constrained by multer (15 MB cap) and the handler checks the MIME +
 * extension before parsing. There are no other form fields read — any
 * extra parts in the envelope are silently ignored by `upload.single`. */
router.post("/jobs/parse-jd", resolveUser, uploadSingle, async (req, res) => {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) { res.status(400).json({ error: "No file attached (field name must be 'file')" }); return; }

  const name = file.originalname.toLowerCase();
  const mime = file.mimetype;

  try {
    let text = "";
    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      const parsed = await pdfParse(file.buffer);
      text = parsed.text || "";
    } else if (
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx")
    ) {
      // mammoth supports DOCX (Open XML) only — legacy binary .doc is NOT supported.
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = result.value || "";
    } else if (mime === "text/plain" || name.endsWith(".txt") || name.endsWith(".md")) {
      text = file.buffer.toString("utf8");
    } else if (mime === "application/msword" || name.endsWith(".doc")) {
      res.status(422).json({ error: "Legacy .doc files aren't supported — please re-save as .docx or PDF and try again." });
      return;
    } else {
      res.status(422).json({ error: `Unsupported file type: ${mime || name}. Upload PDF, DOCX, TXT or MD.` });
      return;
    }

    const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    res.json({ text: cleaned, fileName: file.originalname, charCount: cleaned.length });
  } catch (err: any) {
    logger.error({ err, fileName: file.originalname }, "[jd-parse] extraction failed");
    res.status(500).json({ error: `Could not extract text from ${file.originalname}: ${err?.message || "unknown error"}` });
  }
});

export default router;
