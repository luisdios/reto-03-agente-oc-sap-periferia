import { Router, type IRouter } from "express";
import {
  GetAgentSessionParams,
  GetAgentSessionResponse,
  SendAgentMessageBody,
  SendAgentMessageResponse,
} from "@workspace/api-zod";
import { getSession, sendMessage } from "../agent/agent";

const router: IRouter = Router();

router.get("/sessions/:sessionId", (req, res) => {
  const parsed = GetAgentSessionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Identificador de sesión inválido." });
    return;
  }

  res.json(GetAgentSessionResponse.parse(getSession(parsed.data.sessionId)));
});

router.post("/chat", async (req, res) => {
  const parsed = SendAgentMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "El mensaje requiere un identificador de sesión y contenido.",
    });
    return;
  }

  try {
    const result = await sendMessage(
      parsed.data.sessionId,
      parsed.data.message,
    );
    res.json(SendAgentMessageResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Agent message processing failed");
    res.status(500).json({ error: "No se pudo procesar el mensaje." });
  }
});

export default router;
