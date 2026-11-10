import type { RequestHandler } from "express";
import { verifyRecallWebhook } from "../lib/meeting-attendance-core";
import { acceptAttendanceEvent } from "../lib/meeting-attendance-service";

// Mounted with a bounded raw parser BEFORE express.json and cookie/CSRF handling.
export const recallEventsHandler: RequestHandler = async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Raw event body required." });
      return;
    }
    const id = verifyRecallWebhook(req.body, req.headers, process.env.RECALL_WEBHOOK_SECRET);
    let body: unknown;
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Invalid event JSON." });
      return;
    }
    await acceptAttendanceEvent(id, body);
    res.set("Cache-Control", "no-store").status(204).end();
  } catch (error) {
    next(error);
  }
};
