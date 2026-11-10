import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { CalendarError } from "../lib/outlook-calendar-core";
import { getAuthUserId } from "../lib/auth-token";
import { zoomStaffActor, zoomStaffAccountService } from "../lib/zoom-staff-account";
import { zoomAppConfig, zoomProviderError } from "../lib/zoom-provider";

const cookieName = "lexy_zoom_host_flow";
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/api/zoom-account",
};
export function zoomStaffAccountRouter(
  deps = {
    actor: zoomStaffActor,
    service: zoomStaffAccountService,
    config: zoomAppConfig,
  },
) {
  const router = Router();
  const handle =
    (work: (req: Request, actor: Awaited<ReturnType<typeof deps.actor>>) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      res.set("Cache-Control", "no-store");
      try {
        const actor = await deps.actor(getAuthUserId(req));
        return res.json(await work(req, actor));
      } catch (error) {
        const safe = error instanceof CalendarError ? error : zoomProviderError();
        return res.status(safe.status).json({ code: safe.code, error: safe.message });
      }
    };
  router.get(
    "/zoom-account/me",
    handle(async (_req, actor) => deps.service().status(actor)),
  );
  // Browser binding lives only in an httpOnly cookie, never in the JSON receipt.
  router.post("/zoom-account/me/connect", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const actor = await deps.actor(getAuthUserId(req));
      if (!z.strictObject({ confirmOwnZoom: z.literal(true) }).safeParse(req.body).success)
        throw zoomProviderError("zoom_consent_required", 400);
      const { browser, ...receipt } = await deps.service().begin(actor);
      res.cookie(cookieName, browser, { ...cookieOptions, maxAge: 10 * 60_000 });
      return res.json(receipt);
    } catch (error) {
      const safe = error instanceof CalendarError ? error : zoomProviderError();
      return res.status(safe.status).json({ code: safe.code, error: safe.message });
    }
  });
  router.post(
    "/zoom-account/me/disconnect",
    handle(async (req, actor) => {
      const input = z
        .strictObject({ revision: z.uuid(), confirmDisconnect: z.literal(true) })
        .safeParse(req.body);
      if (!input.success) throw zoomProviderError("zoom_consent_required", 400);
      return deps.service().disconnect(actor, input.data.revision);
    }),
  );
  router.get("/zoom-account/callback", async (req, res) => {
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    const config = deps.config();
    const browser = typeof req.cookies?.[cookieName] === "string" ? req.cookies[cookieName] : "";
    res.clearCookie(cookieName, cookieOptions);
    if (!config) return res.status(503).send("Zoom authorization is not configured.");
    const target = new URL(config.settingsUrl);
    try {
      const actor = await deps.actor(getAuthUserId(req));
      await deps.service().finish(actor, {
        state: typeof req.query.state === "string" ? req.query.state : "",
        browser,
        code: typeof req.query.code === "string" ? req.query.code : "",
        denied: typeof req.query.error !== "undefined",
      });
      target.searchParams.set("zoom", "connected");
    } catch {
      target.searchParams.set("zoom", "error");
    }
    return res.redirect(303, target.toString());
  });
  return router;
}
export default zoomStaffAccountRouter();
