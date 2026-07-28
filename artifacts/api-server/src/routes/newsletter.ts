/**
 * routes/newsletter.ts — Public Newsletter Subscription
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Handles newsletter subscriptions from the public Lexy marketing website.
 * No authentication required — the endpoints are fully public.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   POST /newsletter/subscribe     Subscribe an email address.
 *                                  Validates the email format, deduplicates
 *                                  (re-activates if previously unsubscribed),
 *                                  and inserts into newsletter_subscribers.
 *   POST /newsletter/unsubscribe   Unsubscribe via token (one-click from email).
 *                                  Sets active=false + stamps unsubscribedAt.
 *
 * ─── Deduplication ───────────────────────────────────────────────────────────
 * If the email already exists in the table:
 *   active=true  → return 200 (idempotent, already subscribed)
 *   active=false → re-activate (user previously unsubscribed, now re-opting in)
 */
import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { newsletterSubscribersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { validate } from "../middlewares/validate";

const SubscribeBody = z.object({
  email: z.string().min(1),
  source: z.string().optional(),
});

const router = Router();

router.post("/newsletter/subscribe", validate({ body: SubscribeBody }), async (req, res) => {
  try {
    const { email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }

    const existing = await db
      .select()
      .from(newsletterSubscribersTable)
      .where(eq(newsletterSubscribersTable.email, trimmed))
      .limit(1);

    if (existing.length > 0) {
      if (!existing[0].active) {
        await db
          .update(newsletterSubscribersTable)
          .set({ active: true, unsubscribedAt: null })
          .where(eq(newsletterSubscribersTable.email, trimmed));
      }
      return res.json({ message: "You're already subscribed. Thanks!" });
    }

    await db.insert(newsletterSubscribersTable).values({
      email: trimmed,
      source: (req.body.source as string | undefined) ?? "lexy-site",
    });

    logger.info({ email: trimmed }, "Newsletter subscriber added");
    return res.status(201).json({ message: "Subscribed successfully." });
  } catch (err) {
    logger.error({ err }, "Newsletter subscribe error");
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

export default router;
