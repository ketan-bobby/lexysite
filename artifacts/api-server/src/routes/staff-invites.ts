/**
 * routes/staff-invites.ts — Staff (Recruiter / Admin) Invite Links
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Generates, validates, and accepts invite links for internal staff roles
 * (recruiter, tenant_admin, hiring_manager, interviewer). Separate from
 * routes/invites.ts which handles candidate portal invites.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   POST /staff-invites           Generate an invite link for a staff member.
 *                                 Requires tenant_admin or platform_admin.
 *                                 Body: { email, role, tenantId? }
 *                                 Returns: { inviteUrl, token, expiresAt }
 *   GET  /staff-invites/:token    Validate a token and return invite metadata
 *                                 (email, role, tenantName) so the acceptance
 *                                 page can pre-fill the form.
 *   POST /staff-invites/:token/accept  Accept an invite: create the users row
 *                                      (hashed password), mark the token as
 *                                      used, return a session token.
 *   GET  /staff-invites           List all open (unused) invite tokens for the
 *                                 caller's tenant (tenant_admin) or all tenants
 *                                 (platform_admin).
 *   DELETE /staff-invites/:id     Revoke an unused invite token.
 *
 * ─── Role guard ──────────────────────────────────────────────────────────────
 * Only STAFF_ROLES may be invited: tenant_admin, recruiter, hiring_manager,
 * interviewer. A tenant_admin may only invite roles within their own tenant's
 * subtree (checked by isInSubtree()). platform_admin may invite to any tenant.
 *
 * ─── Token TTL ───────────────────────────────────────────────────────────────
 * Tokens expire after 7 days (configurable via STAFF_INVITE_TTL_DAYS env).
 * Expired tokens return 410 Gone.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, staffInviteTokensTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { checkSeatInviteAllowed, buildLimitExceededBody } from "../lib/plan-enforcement";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { logger } from "../lib/logger";
import { sendEmail, isEmailConfigured } from "../lib/email";
import { issueToken, setSessionTokenCookie, devOnlyTokenBody } from "../lib/auth-token";
import { getTenantRegion } from "../lib/region";
import { validate } from "../middlewares/validate";
import { validatePasswordStrength } from "../lib/password-policy";

const CreateStaffInviteBody = z.object({
  email: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  tenantId: z.string().optional(),
});

const AcceptStaffInviteBody = z.object({
  password: z.string().min(1),
});

async function isInSubtree(rootTenantId: string, candidateId: string): Promise<boolean> {
  if (rootTenantId === candidateId) return true;
  let cursor: string | null = candidateId;
  for (let i = 0; i < 16 && cursor; i++) {
    const [row] = await db.select({ parentId: tenantsTable.parentId })
      .from(tenantsTable).where(eq(tenantsTable.id, cursor)).limit(1);
    if (!row) return false;
    if (row.parentId === rootTenantId) return true;
    cursor = row.parentId;
  }
  return false;
}

const ROLE_LABELS: Record<string, string> = {
  platform_admin: "Platform Admin",
  tenant_admin:   "Admin",
  recruiter_admin: "Recruiter Admin",
  recruiter:      "Recruiter",
  hiring_manager: "Hiring Manager",
  interviewer:    "Interviewer",
};

function getAppBaseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.APP_PUBLIC_URL ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "") ||
    ""
  ).replace(/\/$/, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function buildInviteEmail(opts: {
  recipientName: string;
  inviterName: string | null;
  tenantName: string | null;
  roleLabel: string;
  acceptUrl: string;
  expiresAt: Date;
}): { subject: string; html: string; text: string } {
  const { recipientName, inviterName, tenantName, roleLabel, acceptUrl, expiresAt } = opts;

  // Escape every user-controlled value before embedding into HTML.
  const safeRecipient = escapeHtml(recipientName || "there");
  const safeInviter   = inviterName ? escapeHtml(inviterName) : null;
  const safeTenant    = tenantName ? escapeHtml(tenantName) : null;
  const safeRole      = escapeHtml(roleLabel);
  const safeUrlAttr   = escapeAttr(acceptUrl);
  const safeUrlText   = escapeHtml(acceptUrl);

  const inviterLineHtml = safeInviter ? `${safeInviter} has invited you` : "You've been invited";
  const tenantLineHtml  = safeTenant ? ` to join <strong>${safeTenant}</strong>` : "";
  const subject = `You're invited to join L3xy${tenantName ? ` — ${tenantName}` : ""}`;
  const expiresStr = expiresAt.toUTCString();

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #0f172a;">
      <h2 style="margin: 0 0 12px 0; font-size: 22px; font-weight: 700; letter-spacing: -0.01em;">Welcome to L3xy</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.55;">
        Hi ${safeRecipient},
      </p>
      <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.55;">
        ${inviterLineHtml}${tenantLineHtml} as a <strong>${safeRole}</strong> on L3xy — the AI hiring platform.
      </p>
      <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.55;">
        Click the button below to set your password and activate your account.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 28px 0;">
        <tr>
          <td align="center" bgcolor="#0891b2" style="background-color: #0891b2; border-radius: 8px;">
            <a href="${safeUrlAttr}"
               style="display: inline-block; padding: 13px 24px; background-color: #0891b2; color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; mso-padding-alt: 0;">
              Accept Invite &amp; Set Password
            </a>
          </td>
        </tr>
      </table>
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #475569; line-height: 1.55;">
        Or copy and paste this link into your browser:
      </p>
      <p style="margin: 0 0 24px 0; font-size: 12px; color: #475569; word-break: break-all;">
        <a href="${safeUrlAttr}" style="color: #0891b2;">${safeUrlText}</a>
      </p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="margin: 0; font-size: 12px; color: #64748b; line-height: 1.55;">
        This invite expires on ${escapeHtml(expiresStr)}. If you weren't expecting this email, you can safely ignore it.
      </p>
    </div>
  `;

  // Plain-text body uses raw values (no HTML interpretation).
  const inviterLineText = inviterName ? `${inviterName} has invited you` : "You've been invited";
  const text =
`Welcome to L3xy

Hi ${recipientName || "there"},

${inviterLineText}${tenantName ? ` to join ${tenantName}` : ""} as a ${roleLabel} on L3xy.

Set your password and activate your account here:
${acceptUrl}

This invite expires on ${expiresStr}. If you weren't expecting this email, you can safely ignore it.`;

  return { subject, html, text };
}

const router: IRouter = Router();

const STAFF_ROLES = ["tenant_admin", "recruiter_admin", "recruiter", "hiring_manager", "interviewer"] as const;

// Which roles each caller role may invite. A Recruiter Admin manages line staff
// only (never other admins); admins may invite the full STAFF_ROLES set.
const INVITE_ROLES_BY_CALLER: Record<string, readonly string[]> = {
  platform_admin: STAFF_ROLES,
  tenant_admin:   STAFF_ROLES,
  recruiter_admin: ["recruiter", "hiring_manager"],
};

/* ── POST /api/staff-invites ── generate invite link ─────────────────────── */
router.post("/staff-invites", validate({ body: CreateStaffInviteBody }), resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter_admin"), async (req, res) => {
  try {
    const caller = req.resolvedUser!;
    const { email, name, role, tenantId } = req.body as {
      email?: string; name?: string; role?: string; tenantId?: string;
    };

    if (!email || !name || !role) {
      return res.status(400).json({ error: "email, name, and role are required" });
    }
    if (!STAFF_ROLES.includes(role as any)) {
      return res.status(400).json({ error: `role must be one of: ${STAFF_ROLES.join(", ")}` });
    }
    const invitableRoles = INVITE_ROLES_BY_CALLER[caller.role] || [];
    if (!invitableRoles.includes(role)) {
      return res.status(403).json({ error: `Role '${role}' is not permitted for caller role '${caller.role}'` });
    }

    let targetTenantId: string | null;
    if (caller.role === "platform_admin") {
      targetTenantId = tenantId || caller.tenantId;
    } else if (caller.role === "recruiter_admin") {
      // Recruiter Admins always provision staff into their OWN (agency) tenant —
      // recruiters are agency employees who get assigned to client requisitions.
      targetTenantId = caller.tenantId;
    } else {
      // tenant_admin: may invite into own tenant or any descendant
      targetTenantId = tenantId || caller.tenantId;
      if (tenantId && tenantId !== caller.tenantId) {
        if (!caller.tenantId || !(await isInSubtree(caller.tenantId, tenantId))) {
          return res.status(403).json({ error: "Cannot invite into a tenant outside your subtree" });
        }
      }
    }

    if (!targetTenantId) {
      return res.status(400).json({ error: "tenantId required" });
    }

    // Check if email already registered
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (existing) {
      return res.status(409).json({ error: "A user with this email already exists" });
    }

    // Plan-limit gate: seat cap (active users + pending invites) on the root
    // tenant. Sub-clients have no team of their own, so the limit always
    // applies to the contracting root tenant. Returns 402 with the standard
    // PLAN_LIMIT_EXCEEDED payload — same shape as the jobs / interviews gates.
    const seatCheck = await checkSeatInviteAllowed(targetTenantId);
    if (!seatCheck.allowed) {
      return res.status(402).json(buildLimitExceededBody(seatCheck));
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await db.insert(staffInviteTokensTable).values({
      token,
      email,
      name,
      role: role as any,
      tenantId: targetTenantId,
      invitedBy: caller.id,
      expiresAt,
    });

    logger.info({ email, role, tenantId: targetTenantId, invitedBy: caller.id }, "Staff invite generated");

    // Look up tenant name for the email body (best-effort)
    let tenantName: string | null = null;
    try {
      const [t] = await db
        .select({ name: tenantsTable.name })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, targetTenantId))
        .limit(1);
      tenantName = t?.name ?? null;
    } catch { /* non-fatal */ }

    // Build the accept URL — refuse to send an email with a relative link.
    const baseUrl = getAppBaseUrl();
    if (!baseUrl) {
      logger.error(
        { tenantId: targetTenantId },
        "Cannot send invite email: no PUBLIC_APP_URL / APP_PUBLIC_URL / REPLIT_DEV_DOMAIN configured",
      );
    }
    const acceptUrl = baseUrl
      ? `${baseUrl}/accept-team-invite?token=${encodeURIComponent(token)}`
      : `/accept-team-invite?token=${encodeURIComponent(token)}`;

    // Only send if we have an absolute URL — otherwise the link in the email would be broken.
    const canSendEmail = !!baseUrl;

    // Send the invite email to the recipient
    const { subject, html, text } = buildInviteEmail({
      recipientName: name,
      inviterName: caller.name ?? null,
      tenantName,
      roleLabel: ROLE_LABELS[role] || role,
      acceptUrl,
      expiresAt,
    });

    const emailResult = canSendEmail
      ? await sendEmail({
          to: email,
          subject,
          html,
          text,
          audit: {
            tenantId: targetTenantId,
            actorLabel: caller.name ? `${caller.name} (${caller.role})` : caller.role,
            subjectType: "user",
            subjectLabel: email,
            action: "staff_invite.sent",
            metadata: { role, invitedBy: caller.id, tokenPrefix: token.slice(0, 8) },
          },
        })
      : { ok: false as const, error: "App base URL not configured" };

    if (!emailResult.ok) {
      logger.warn({ email, err: emailResult.error }, "Staff invite email failed to send (link still valid)");
    } else {
      logger.info(
        { email, simulated: !!emailResult.simulated, messageId: emailResult.messageId },
        emailResult.simulated ? "Staff invite email SIMULATED (SES not configured)" : "Staff invite email sent",
      );
    }

    res.json({
      token,
      email,
      name,
      role,
      tenantId: targetTenantId,
      expiresAt: expiresAt.toISOString(),
      acceptUrl,
      emailSent: emailResult.ok && !emailResult.simulated,
      emailSimulated: !!emailResult.simulated,
      emailConfigured: isEmailConfigured(),
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to generate staff invite");
    res.status(500).json({ error: "Failed to generate invite" });
  }
});

/* ── GET /api/staff-invites/:token ── validate ────────────────────────────── */
router.get("/staff-invites/:token", async (req, res) => {
  try {
    const [row] = await db
      .select()
      .from(staffInviteTokensTable)
      .where(eq(staffInviteTokensTable.token, req.params.token))
      .limit(1);

    if (!row) return res.status(404).json({ valid: false, error: "Invite link not found" });
    if (row.usedAt) return res.status(410).json({ valid: false, error: "This invite link has already been used" });
    if (new Date() > row.expiresAt) return res.status(410).json({ valid: false, error: "This invite link has expired" });

    res.json({
      valid: true,
      email: row.email,
      name: row.name,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to validate staff invite token");
    res.status(500).json({ valid: false, error: "Failed to validate invite" });
  }
});

/* ── POST /api/staff-invites/:token/accept ── accept + create user ─────── */
router.post("/staff-invites/:token/accept", validate({ body: AcceptStaffInviteBody }), async (req, res) => {
  try {
    const { password } = req.body as { password?: string };
    const policy = validatePasswordStrength(password);
    if (!policy.ok) {
      return res.status(400).json({ error: policy.code, message: policy.message });
    }

    const [row] = await db
      .select()
      .from(staffInviteTokensTable)
      .where(eq(staffInviteTokensTable.token, req.params.token))
      .limit(1);

    if (!row) return res.status(404).json({ error: "Invite link not found" });
    if (row.usedAt) return res.status(410).json({ error: "This invite link has already been used" });
    if (new Date() > row.expiresAt) return res.status(410).json({ error: "This invite link has expired" });

    // Create the user with a real bcrypt hash
    const passwordHash = await bcrypt.hash(password, 12);
    const [user] = await db
      .insert(usersTable)
      .values({
        email: row.email,
        name: row.name,
        role: row.role,
        tenantId: row.tenantId,
        passwordHash,
      })
      .returning();

    // Mark invite used
    await db
      .update(staffInviteTokensTable)
      .set({ usedAt: new Date() })
      .where(eq(staffInviteTokensTable.token, req.params.token));

    logger.info({ userId: user.id, email: user.email, role: user.role }, "Staff invite accepted");

    const acceptToken = issueToken({ userId: user.id, role: user.role, tenantId: user.tenantId, region: await getTenantRegion(user.tenantId) });
    setSessionTokenCookie(res, acceptToken);
    res.json({
      user: {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
        role: user.role,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt.toISOString(),
      },
      ...devOnlyTokenBody(acceptToken),
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to accept staff invite");
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

export default router;
