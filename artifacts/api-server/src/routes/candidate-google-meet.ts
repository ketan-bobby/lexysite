import { Router } from "express";
import { resolveCandidateSession } from "../lib/portal-auth";
import { candidateGoogleMeet } from "../lib/candidate-google-meet-store";

export function candidateGoogleMeetRouter(
  deps = {
    session: resolveCandidateSession,
    read: candidateGoogleMeet,
  },
) {
  const router = Router();
  router.get("/portal/interview-schedules/:scheduleId/google-meet", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const self = await deps.session(req);
      if (!self) return res.status(401).json({ error: "Candidate sign-in required." });
      const view = await deps.read(self, String(req.params.scheduleId));
      if (!view) return res.status(404).json({ error: "Appointment not found." });
      return res.json(view);
    } catch {
      return res.status(503).json({ error: "Meeting details unavailable. Please try again." });
    }
  });
  return router;
}
export default candidateGoogleMeetRouter();
