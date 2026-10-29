import { Router, type IRouter } from "express";
import healthRouter from "./health";
import purchasesRouter from "./purchases";
import chatRouter from "./chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(purchasesRouter);
router.use(chatRouter);

export default router;
