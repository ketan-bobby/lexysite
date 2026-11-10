import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { resolveUser } from "../middlewares/resolveUser";
import { meetingScope } from "../lib/meeting-notes-service";
import {
  attendanceView,
  authorizeAttendanceWorkspace,
  revokeAttendanceWorkspace,
  approveAttendance,
  dispatchAttendance,
  stopAttendance,
  recoverAttendance,
  importAttendanceAudio,
} from "../lib/meeting-attendance-service";
import {
  attendanceApprovalInput,
  attendanceWorkspaceInput,
  attendanceImportInput,
} from "../lib/meeting-attendance-core";

const router = Router();
const base = "/jobs/:jobId/candidates/:candidateId/meeting-assistant";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
async function scope(req: Request) {
  return meetingScope(
    req.resolvedUser!.id,
    identifier.parse(req.params.jobId),
    identifier.parse(req.params.candidateId),
  );
}
const action: RequestHandler = async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const s = await scope(req);
    if (req.method === "GET") {
      res.json(await attendanceView(s));
      return;
    }
    if (req.path.endsWith("/workspace")) {
      res.json(
        req.method === "DELETE"
          ? await revokeAttendanceWorkspace(s)
          : await authorizeAttendanceWorkspace(s, attendanceWorkspaceInput.parse(req.body)),
      );
      return;
    }
    if (!req.params.attendanceId) {
      res.status(201).json(await approveAttendance(s, attendanceApprovalInput.parse(req.body)));
      return;
    }
    const id = z.string().uuid().parse(req.params.attendanceId);
    if (req.params.action === "dispatch") res.json(await dispatchAttendance(s, id));
    else if (req.params.action === "stop") res.json(await stopAttendance(s, id));
    else if (req.params.action === "recover") res.json(await recoverAttendance(s, id));
    else if (req.path.endsWith("/import"))
      res.json(await importAttendanceAudio(s, id, attendanceImportInput.parse(req.body)));
    else res.status(404).json({ error: "Action not found." });
  } catch (error) {
    next(error);
  }
};
router.get(base, resolveUser, action);
router.post(base, resolveUser, action);
router.put(`${base}/workspace`, resolveUser, action);
router.delete(`${base}/workspace`, resolveUser, action);
router.post(`${base}/attempts/:attendanceId/import`, resolveUser, action);
router.post(`${base}/attempts/:attendanceId/:action`, resolveUser, action);
export default router;
