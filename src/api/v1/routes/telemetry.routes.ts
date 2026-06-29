import { Router } from "express";
import { protect } from "../../../middlewares/auth.middleware";
import { validateBody } from "../../../middlewares/validate.middleware";
import { TelemetryPayloadSchema } from "../validators/telemetry.validator";
import TelemetryController from "../controllers/telemetry.controller";

const router = Router();

router.post(
  "/",
  protect,
  validateBody(TelemetryPayloadSchema),
  TelemetryController.record
);

export default router;
