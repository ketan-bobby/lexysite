import logo from "./email-brand-logo.json" with { type: "json" };

export const LEXY_LOGO_CONTENT_ID = "lexy-brand-logo@inline.lexy";
const BRAND_MARKER = 'data-lexy-email-branding="1"';

export type EmailAttachment = {
  filename: string;
  content: string;
  contentType?: string;
  contentId?: string;
};

export function lexyLogoAttachment(): EmailAttachment {
  return {
    filename: "lexy-logo.png",
    content: logo.base64,
    contentType: "image/png",
    contentId: LEXY_LOGO_CONTENT_ID,
  };
}

/** Layout only: preserves company copy, action URLs, and trailing reply blocks. */
export function brandEmailHtml(html: string): string {
  if (html.includes(BRAND_MARKER)) return html;
  const direction =
    html.match(/<(?:body|html)\b[^>]*\bdir=["'](rtl|ltr)["']/i)?.[1]?.toLowerCase() ?? "ltr";
  const styles = Array.from(html.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head>/gi))
    .flatMap((match) => match[1].match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [])
    .join("");
  const content = html
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<\/?(?:html|body)\b[^>]*>/gi, "")
    .trim();
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>${styles}</head>
<body dir="${direction}" style="margin:0;padding:0;background-color:#eef3f8;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef3f8"><tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table ${BRAND_MARKER} role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;border:1px solid #dbe5ee;border-radius:12px;background-color:#ffffff;" bgcolor="#ffffff">
<tr><td bgcolor="#071b2f" style="padding:24px 28px;background-color:#071b2f;border-radius:12px 12px 0 0;">
<img src="cid:${LEXY_LOGO_CONTENT_ID}" width="180" height="60" alt="Lexy AI" style="display:block;width:180px;max-width:100%;height:auto;border:0;"/>
<p style="margin:12px 0 0;font-size:11px;line-height:1.5;letter-spacing:2px;color:#b9d6ec;">LEXY &nbsp;·&nbsp; AI HIRING PLATFORM</p>
</td></tr>
<tr><td bgcolor="#008bcf" height="4" style="height:4px;line-height:4px;font-size:0;background-color:#008bcf;">&nbsp;</td></tr>
<tr><td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#182638;overflow-wrap:break-word;">${content}</td></tr>
<tr><td bgcolor="#f7fafd" style="padding:20px 28px;border-top:1px solid #e3ebf3;border-radius:0 0 12px 12px;background-color:#f7fafd;">
<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;font-weight:700;color:#14314c;">Sent with Lexy</p>
<p style="margin:5px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#54677b;">AI hiring platform</p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

/** Reserve one CID for the logo; retain ordinary résumé/PDF attachments. */
export function withLexyLogo(attachments: EmailAttachment[] = []): EmailAttachment[] {
  return [
    ...attachments.filter((attachment) => attachment.contentId !== LEXY_LOGO_CONTENT_ID),
    lexyLogoAttachment(),
  ];
}
