/**
 * routes/guide.ts — Token-Gated HTML Documentation Viewer
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Serves two static HTML documentation files (candidate guide and platform
 * guide) behind a secret query-string token. Used internally for sharing
 * documentation with stakeholders without requiring platform authentication.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET /guide/candidate   Serve the candidate portal guide HTML.
 *                          Requires ?token=<GUIDE_ACCESS_TOKEN>
 *   GET /guide/platform    Serve the platform (recruiter) guide HTML.
 *                          Requires ?token=<GUIDE_ACCESS_TOKEN>
 *
 * ─── Token guard ─────────────────────────────────────────────────────────────
 * The GUIDE_ACCESS_TOKEN environment variable must be set. If missing the
 * endpoint returns 503. If the provided token doesn't match, returns 403 with
 * a styled "Access Denied" HTML page. Responses carry no-store/no-cache
 * headers and X-Robots-Tag: noindex to prevent indexing by crawlers.
 */
import { Router, type IRouter } from "express";
import guideHtml from "./candidate-guide.html";
import platformGuideHtml from "./platform-guide.html";

const router: IRouter = Router();

const PRIVATE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  "Pragma": "no-cache",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "default-src 'self' 'unsafe-inline'; img-src 'self' data:;",
};

function checkToken(req: any, res: any): boolean {
  const expected = process.env.GUIDE_ACCESS_TOKEN;
  if (!expected) {
    res.status(503).send("Document access is not configured.");
    return false;
  }
  const provided = req.query.token as string | undefined;
  if (!provided || provided !== expected) {
    res.set("Cache-Control", "no-store");
    res.status(403).send(
      `<!DOCTYPE html><html><head><title>Access Denied</title>
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0f1a;color:#fff;}
      .box{text-align:center;padding:40px;border:1px solid #1e2d4a;border-radius:16px;max-width:400px;}
      h2{color:#ef4444;margin-bottom:8px;}p{color:#64748b;font-size:14px;}</style></head>
      <body><div class="box"><h2>Access Denied</h2>
      <p>This document is private. A valid access token is required.</p></div></body></html>`
    );
    return false;
  }
  return true;
}

router.get("/guide/platform", (req, res) => {
  if (!checkToken(req, res)) return;
  res.set(PRIVATE_HEADERS);
  return res.send(platformGuideHtml);
});

router.get("/guide/candidate-platform", (req, res) => {
  if (!checkToken(req, res)) return;
  res.set(PRIVATE_HEADERS);
  return res.send(guideHtml);
});

export default router;
