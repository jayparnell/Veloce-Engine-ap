import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import studioRouter from "./studio";
import campaignsRouter from "./campaigns";
import operationsRouter from "./operations";
import storageRouter from "./storage";
import socialRouter from "./social";
import autopilotRouter from "./autopilot";
import publishingReviewRouter from "./publishing-review";
import storageCleanupRouter from "./storage-cleanup";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(storageRouter);
router.use(storageCleanupRouter);
router.use(socialRouter);
router.use(autopilotRouter);
router.use(publishingReviewRouter);
router.use(studioRouter);
router.use(campaignsRouter);
router.use(operationsRouter);

export default router;
