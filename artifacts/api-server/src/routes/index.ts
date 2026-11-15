import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import studioRouter from "./studio";
import campaignsRouter from "./campaigns";
import operationsRouter from "./operations";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(storageRouter);
router.use(studioRouter);
router.use(campaignsRouter);
router.use(operationsRouter);

export default router;
