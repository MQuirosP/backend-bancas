import { Router } from "express";
import MultiplierController from "../controllers/multiplier.controller";

const router = Router();

router.post("/",      MultiplierController.create);
router.get("/",       MultiplierController.list);
router.get("/:id",    MultiplierController.getById);
router.patch("/:id",  MultiplierController.update);
router.patch("/:id/toggle", MultiplierController.toggle);

export default router;
