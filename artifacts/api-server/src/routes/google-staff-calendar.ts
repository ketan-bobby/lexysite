import { Router, type Request } from "express";
import { z } from "zod/v4";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { CalendarError } from "../lib/outlook-calendar-core";
import { googleStaffConfig, googleStaffFailure } from "../lib/google-staff-config";
import { googleStaffProvider } from "../lib/google-staff-provider";
import { googleStaffStore, type GoogleStaffActor } from "../lib/google-staff-store";
import { googleStaffService } from "../lib/google-staff-service";

const cookieName = "lexy_google_calendar_flow";
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/api/google-calendar",
};
async function staffActor(id: string | null): Promise<GoogleStaffActor> {
  const user = await calendarStaff(id);
  if (!user.tenantId && user.role !== "platform_admin")
    throw googleStaffFailure("staff_employer_required", 403);
  return { id: user.id, tenantId: user.tenantId ?? "" };
}
const ownConsent = z
  .object({
    confirmOwnCalendar: z.literal(true),
    allowInvitations: z.boolean().optional().default(false),
  })
  .strict();
const disconnect = z.object({ revision: z.uuid(), confirmDisconnect: z.literal(true) }).strict();
export function googleStaffCalendarRouter(
  deps = {
    actor: staffActor,
    config: googleStaffConfig,
    service: () =>
      googleStaffService({
        store: googleStaffStore(),
        config: googleStaffConfig(),
        provider: () => {
          const config = googleStaffConfig();
          if (!config) throw googleStaffFailure("google_setup_required");
          return googleStaffProvider(config);
        },
        revalidate: async (actor: GoogleStaffActor) => {
          const current = await staffActor(actor.id);
          if (current.tenantId !== actor.tenantId)
            throw googleStaffFailure("google_account_changed", 403);
        },
      }),
  },
) {
  const router = Router();
  const handle =
    (
      work: (
        req: Request,
        actor: GoogleStaffActor,
        service: ReturnType<typeof deps.service>,
      ) => Promise<unknown>,
    ) =>
    async (req: Request, res: import("express").Response) => {
      res.set("Cache-Control", "no-store");
      try {
        const actor = await deps.actor(getAuthUserId(req));
        const service = deps.service();
        const result = await work(req, actor, service);
        return res.json(result);
      } catch (error) {
        const safe = error instanceof CalendarError ? error : googleStaffFailure();
        return res.status(safe.status).json({ error: safe.message, code: safe.code });
      }
    };
  router.get(
    "/google-calendar/me",
    handle(async (_req, actor, service) => service.status(actor)),
  );
  router.post("/google-calendar/me/connect", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const actor = await deps.actor(getAuthUserId(req));
      const consent = ownConsent.safeParse(req.body);
      if (!consent.success) throw googleStaffFailure("google_acknowledgement_required", 400);
      const result = await deps.service().begin(actor, consent.data.allowInvitations);
      res.cookie(cookieName, result.browser, { ...cookieOptions, maxAge: 10 * 60_000 });
      return res.json(result.receipt);
    } catch (error) {
      const safe = error instanceof CalendarError ? error : googleStaffFailure();
      return res.status(safe.status).json({ error: safe.message, code: safe.code });
    }
  });
  router.post(
    "/google-calendar/me/disconnect",
    handle(async (req, actor, service) => {
      const input = disconnect.safeParse(req.body);
      if (!input.success) throw googleStaffFailure("google_acknowledgement_required", 400);
      // Invalidating the database flow also invalidates any still-present cookie.
      return service.disconnect(actor, input.data.revision);
    }),
  );
  router.post(
    "/google-calendar/me/availability",
    handle(async (req, actor, service) => service.availability(actor, req.body)),
  );
  router.get("/google-calendar/callback", async (req, res) => {
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    const config = deps.config();
    res.clearCookie(cookieName, cookieOptions);
    if (!config) return res.status(503).send("Google Calendar authorization is not configured.");
    const target = new URL(config.settingsUrl);
    try {
      const actor = await deps.actor(getAuthUserId(req));
      await deps.service().finish(actor, {
        state: typeof req.query.state === "string" ? req.query.state : "",
        browser: typeof req.cookies?.[cookieName] === "string" ? req.cookies[cookieName] : "",
        code: typeof req.query.code === "string" ? req.query.code : "",
        denied: typeof req.query.error !== "undefined",
      });
      target.searchParams.set("googleCalendar", "connected");
    } catch {
      target.searchParams.set("googleCalendar", "error");
    }
    return res.redirect(303, target.toString());
  });
  return router;
}
export default googleStaffCalendarRouter();
