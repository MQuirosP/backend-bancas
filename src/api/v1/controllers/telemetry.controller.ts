import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import logger from "../../../core/logger";

export const TelemetryController = {
  async record(req: AuthenticatedRequest, res: Response) {
    const { event, durationMs, success, metadata } = req.body;

    logger.info({
      layer: "telemetry",
      action: event,
      userId: req.user?.id,
      bancaId: (req.user as any)?.bancaId || null,
      payload: {
        durationMs,
        success,
        metadata: {
          ...metadata,
          userAgent: req.headers["user-agent"],
          ip: req.ip,
        },
      },
    });

    res.status(202).json({ success: true });
  }
};

export default TelemetryController;
