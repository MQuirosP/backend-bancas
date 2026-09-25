import { Router, Request, Response, NextFunction } from "express";
import { config } from "../../../config";
import { protect } from "../../../middlewares/auth.middleware";
import { validateBody } from "../../../middlewares/validate.middleware";
import { TelemetryPayloadSchema } from "../validators/telemetry.validator";
import TelemetryController from "../controllers/telemetry.controller";

const router = Router();

router.post(
  "/",
  // Short-circuit inmediato si la telemetría está desactivada (false por defecto):
  // Responde 202 Accepted sin ejecutar autenticación, parseo Zod ni logging.
  (req: Request, res: Response, next: NextFunction) => {
    if (!config.telemetryEnabled) {
      return res.status(202).json({ success: true, disabled: true });
    }
    next();
  },
  protect,
  validateBody(TelemetryPayloadSchema),
  TelemetryController.record
);

export default router;
