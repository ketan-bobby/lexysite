import { Router, type Request, type Response } from "express";
import {
  ConnectMyGoogleMeetRecordingAccountBody,
  DisconnectMyGoogleMeetRecordingAccountBody,
} from "@workspace/api-zod";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { CalendarError } from "../lib/outlook-calendar-core";
import {
  googleMeetRecordingConfig,
  googleMeetRecordingOAuth,
  meetAccountFailure,
} from "../lib/google-meet-recording-oauth";
import { googleMeetRecordingStore } from "../lib/google-meet-recording-store";
import { googleMeetRecordingAccount } from "../lib/google-meet-recording-account";
import type { GoogleStaffActor as Actor } from "../lib/google-staff-store";

const cookieName = "lexy_google_meet_recording_flow";
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/api/google-meet-recordings",
};
export async function meetRecordingStaffActor(id: string | null): Promise<Actor> {
  const user = await calendarStaff(id);
  if (!user.tenantId) throw meetAccountFailure("staff_employer_required", 403);
  return { id: user.id, tenantId: user.tenantId };
}
export const makeMeetRecordingAccount = () =>
  googleMeetRecordingAccount({
    store: googleMeetRecordingStore(),
    config: googleMeetRecordingConfig(),
    provider: () => {
      const config = googleMeetRecordingConfig();
      if (!config) throw meetAccountFailure("meet_recording_setup_required");
      return googleMeetRecordingOAuth(config);
    },
    revalidate: async (actor: Actor) => {
      const fresh = await meetRecordingStaffActor(actor.id);
      if (fresh.tenantId !== actor.tenantId)
        throw meetAccountFailure("meet_recording_account_changed", 403);
    },
  });
export function googleMeetRecordingAccountRouter(
  deps = {
    actor: meetRecordingStaffActor,
    config: googleMeetRecordingConfig,
    service: makeMeetRecordingAccount,
  },
) {
  const router = Router();
  const safeError = (res: Response, error: unknown) => {
    const safe = error instanceof CalendarError ? error : meetAccountFailure();
    res.status(safe.status).json({ error: safe.message, code: safe.code });
  };
  router.get("/google-meet-recordings/me", async (req: Request, res: Response): Promise<void> => {
    res.set("Cache-Control", "no-store");
    try {
      const actor = await deps.actor(getAuthUserId(req));
      res.json(await deps.service().status(actor));
    } catch (error) {
      safeError(res, error);
    }
  });
  router.post(
    "/google-meet-recordings/me/connect",
    async (req: Request, res: Response): Promise<void> => {
      res.set("Cache-Control", "no-store");
      try {
        const actor = await deps.actor(getAuthUserId(req));
        const input = ConnectMyGoogleMeetRecordingAccountBody.strict().safeParse(req.body);
        if (!input.success || input.data.confirmRecordingAccess !== true)
          throw meetAccountFailure("meet_recording_acknowledgement_required", 400);
        const result = await deps.service().begin(actor);
        res.cookie(cookieName, result.browser, { ...cookieOptions, maxAge: 10 * 60_000 });
        res.json(result.receipt);
      } catch (error) {
        safeError(res, error);
      }
    },
  );
  router.post(
    "/google-meet-recordings/me/disconnect",
    async (req: Request, res: Response): Promise<void> => {
      res.set("Cache-Control", "no-store");
      try {
        const actor = await deps.actor(getAuthUserId(req));
        const input = DisconnectMyGoogleMeetRecordingAccountBody.strict().safeParse(req.body);
        if (!input.success || input.data.confirmDisconnect !== true)
          throw meetAccountFailure("meet_recording_acknowledgement_required", 400);
        res.json(await deps.service().disconnect(actor, input.data.revision));
      } catch (error) {
        safeError(res, error);
      }
    },
  );
  router.get(
    "/google-meet-recordings/callback",
    async (req: Request, res: Response): Promise<void> => {
      res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
      res.clearCookie(cookieName, cookieOptions);
      const config = deps.config();
      if (!config) {
        res.status(503).send("Meet recording authorization is not configured.");
        return;
      }
      const target = new URL(config.settingsUrl);
      try {
        const actor = await deps.actor(getAuthUserId(req));
        await deps.service().finish(actor, {
          state: typeof req.query.state === "string" ? req.query.state : "",
          browser: typeof req.cookies?.[cookieName] === "string" ? req.cookies[cookieName] : "",
          code: typeof req.query.code === "string" ? req.query.code : "",
          denied: req.query.error !== undefined,
        });
        target.searchParams.set("googleMeetRecordings", "connected");
      } catch {
        target.searchParams.set("googleMeetRecordings", "error");
      }
      res.redirect(303, target.toString());
    },
  );
  return router;
}
export default googleMeetRecordingAccountRouter();
