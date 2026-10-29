import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { GEMINI_MODEL } from "../agent/llm/gemini";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const configured = Boolean(process.env.GEMINI_API_KEY);
  const data = HealthCheckResponse.parse({
    ok: configured,
    status: configured ? "ok" : "missing_credentials",
    provider: "Google Gemini",
    model: GEMINI_MODEL,
  });
  res.json(data);
});

export default router;
