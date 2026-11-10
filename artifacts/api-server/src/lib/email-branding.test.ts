import { test } from "node:test";
import assert from "node:assert/strict";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { brandEmailHtml, withLexyLogo, LEXY_LOGO_CONTENT_ID } from "./email-branding";

test("adds one Lexy header and preserves hiring-company copy and exact action links", () => {
  const url = "https://example.invalid/interview?id=sample&action=start";
  const html = brandEmailHtml(
    `<html><body><p>Example Company interview</p><a href="${url}">Start interview</a><p>Code: 123456</p></body></html>`,
  );
  assert.ok(html.includes("Example Company interview"));
  assert.ok(html.includes(`href="${url}"`));
  assert.ok(html.includes("Code: 123456"));
  assert.ok(html.includes(`src="cid:${LEXY_LOGO_CONTENT_ID}"`));
  assert.equal(brandEmailHtml(html), html);
});

test("keeps the existing quick-reply block appended after the original HTML document", () => {
  const html = brandEmailHtml(
    '<!doctype html><html><body><p>Outreach</p></body></html><table><tr><td><a href="https://example.invalid/reply">Interested</a></td></tr></table>',
  );
  assert.ok(html.includes("Interested"));
  assert.ok(html.includes("https://example.invalid/reply"));
  assert.equal((html.match(/<body\b/g) ?? []).length, 1);
  assert.ok(html.indexOf("Interested") < html.indexOf("Sent with Lexy"));
});

test("retains existing template CSS, unsubscribe links and company signature", () => {
  const html = brandEmailHtml(
    '<html><head><style>.button{color:blue}</style><title>Old title</title></head><body><p>Company recruiter</p><a href="https://example.invalid/unsubscribe">Unsubscribe</a></body></html>',
  );
  assert.ok(html.includes(".button{color:blue}"));
  assert.ok(html.includes("Company recruiter"));
  assert.ok(html.includes('href="https://example.invalid/unsubscribe"'));
  assert.ok(!html.includes("<title>Old title</title>"));
});

test("preserves explicitly right-to-left email layout without changing language content", () => {
  const html = brandEmailHtml('<html lang="ar"><body dir="rtl"><p>مرحباً</p></body></html>');
  assert.ok(html.includes('<body dir="rtl"'));
  assert.ok(html.includes("مرحباً"));
});

test("logo is a real embedded PNG and ordinary PDF attachments remain unchanged", () => {
  const pdf = {
    filename: "resume.pdf",
    content: Buffer.from("%PDF sample").toString("base64"),
    contentType: "application/pdf",
  };
  const attachments = withLexyLogo([pdf]);
  assert.deepEqual(attachments[0], pdf);
  const logo = attachments[1];
  assert.equal(logo.contentId, LEXY_LOGO_CONTENT_ID);
  assert.equal(
    Buffer.from(logo.content, "base64").subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  assert.equal(withLexyLogo(attachments).length, 2);
});

test("SES MIME contains the inline logo, reply address, unsubscribe header and PDF", async () => {
  const attachments = withLexyLogo([
    {
      filename: "resume.pdf",
      content: Buffer.from("%PDF sample").toString("base64"),
      contentType: "application/pdf",
    },
  ]);
  const composer = new MailComposer({
    from: "Lexy <sender@example.invalid>",
    to: "recipient@example.invalid",
    subject: "Branding test",
    text: "Original plain-text message",
    html: brandEmailHtml(
      '<p>Test company</p><a href="https://example.invalid/interview">Interview</a>',
    ),
    replyTo: "recruiter@example.invalid",
    headers: [{ key: "List-Unsubscribe", value: "<https://example.invalid/unsubscribe>" }],
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, "base64"),
      contentType: a.contentType,
      cid: a.contentId,
      contentDisposition: a.contentId ? "inline" : "attachment",
    })),
  });
  const raw: Buffer = await new Promise((resolve, reject) =>
    composer
      .compile()
      .build((error: Error | null, result: Buffer) => (error ? reject(error) : resolve(result))),
  );
  const mime = raw.toString().replace(/=\r?\n/g, "");
  assert.ok(mime.includes(`Content-ID: <${LEXY_LOGO_CONTENT_ID}>`));
  assert.ok(mime.includes("Content-Disposition: inline;"));
  assert.ok(mime.includes("resume.pdf"));
  assert.ok(mime.includes("application/pdf"));
  assert.ok(mime.includes("multipart/related"));
  assert.ok(mime.includes("recruiter@example.invalid"));
  assert.ok(mime.includes("List-Unsubscribe"));
  assert.ok(mime.includes("Original plain-text message"));
});
