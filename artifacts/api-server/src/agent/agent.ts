import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type, type Content, type FunctionDeclaration } from "@google/genai";
import { logger } from "../lib/logger";
import { outputDirectory, workspaceRoot } from "../lib/workspace-paths";
import {
  executeAgentTool,
  type ToolContext,
} from "../tools/oc";
import {
  OrdenCompraSchema,
  PaqueteSchema,
  ValidacionSchema,
  type OrdenCompra,
  type Paquete,
  type Validacion,
} from "../sap/types";
import { GEMINI_MODEL, GeminiAdapter } from "./llm/gemini";
import type { LlmAdapter } from "./llm/adapter";

export type ToolCallView = {
  name: string;
  args: string;
  result: string;
  ok: boolean;
};

export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls: ToolCallView[];
};

export type SessionView = {
  sessionId: string;
  messages: AgentMessage[];
  pendingCase: string | null;
  needsConfirmation: boolean;
};

export type ChatResult = {
  sessionId: string;
  reply: string;
  toolCalls: ToolCallView[];
  needsConfirmation: boolean;
  pendingCase: string | null;
};

type PendingConfirmation = {
  caso: string;
  payload: OrdenCompra;
};

type SessionState = {
  sessionId: string;
  messages: AgentMessage[];
  contents: Content[];
  pending: PendingConfirmation | null;
  lastCase: string | null;
  totalTokens: number;
};

type ToolEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

type ToolRun = {
  name: string;
  rawResult: string;
  view: ToolCallView;
  envelope: ToolEnvelope;
};

const sessions = new Map<string, SessionState>();
const adapter: LlmAdapter = new GeminiAdapter();
const MAX_ITERATIONS = readBoundedNumber("AGENT_MAX_ITERATIONS", 25, 1, 25);
const MAX_SESSION_TOKENS = readBoundedNumber(
  "AGENT_MAX_SESSION_TOKENS",
  40_000,
  8_192,
  1_000_000,
);
const MAX_DAILY_TOKENS = readBoundedNumber(
  "AGENT_MAX_PROCESS_TOKENS_PER_DAY",
  200_000,
  1_000,
  10_000_000,
);
let dailyTokenDate = new Date().toISOString().slice(0, 10);
let dailyTokensUsed = 0;

function resetDailyBudgetIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyTokenDate) {
    dailyTokenDate = today;
    dailyTokensUsed = 0;
  }
}

function readBoundedNumber(
  variable: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[variable]);
  return Number.isInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

const toolDescriptions: FunctionDeclaration[] = [
  {
    name: "oc_leer_paquete",
    description:
      "Lee el paquete de documentos original del caso seleccionado. Solo requiere el identificador.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: {
          type: Type.STRING,
          description: "Identificador de carpeta: sol-001 a sol-006.",
        },
      },
      required: ["caso"],
    },
  },
  {
    name: "oc_validar",
    description:
      "Valida los datos originales contra los maestros y las reglas RC1 a RC10.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: {
          type: Type.STRING,
          description: "Identificador de carpeta: sol-001 a sol-006.",
        },
      },
      required: ["caso"],
    },
  },
  {
    name: "oc_generar_evidencia",
    description:
      "Genera el archivo de evidencia del correo de aprobación y calcula su hash SHA-256.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: {
          type: Type.STRING,
          description: "Identificador de carpeta: sol-001 a sol-006.",
        },
      },
      required: ["caso"],
    },
  },
  {
    name: "oc_construir_payload",
    description:
      "Construye el payload SAP y su trazabilidad usando los documentos y maestros originales.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: {
          type: Type.STRING,
          description: "Identificador de carpeta: sol-001 a sol-006.",
        },
      },
      required: ["caso"],
    },
  },
  {
    name: "oc_crear",
    description:
      "Crea la orden SAP simulada; el servidor rechaza bloqueos o confirmaciones no autorizadas.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        caso: {
          type: Type.STRING,
          description: "Identificador de carpeta: sol-001 a sol-006.",
        },
        confirmado: {
          type: Type.BOOLEAN,
          description: "Confirmación explícita de la analista, cuando corresponda.",
        },
      },
      required: ["caso"],
    },
  },
];

function newSession(sessionId: string): SessionState {
  return {
    sessionId,
    messages: [],
    contents: [],
    pending: null,
    lastCase: null,
    totalTokens: 0,
  };
}

function getOrCreateSession(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const created = newSession(sessionId);
  sessions.set(sessionId, created);
  return created;
}

export function getSession(sessionId: string): SessionView {
  const session = sessions.get(sessionId) ?? newSession(sessionId);
  return {
    sessionId: session.sessionId,
    messages: session.messages,
    pendingCase: session.pending?.caso ?? null,
    needsConfirmation: session.pending !== null,
  };
}

function makeMessage(
  role: AgentMessage["role"],
  content: string,
  toolCalls: ToolCallView[] = [],
): AgentMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    toolCalls,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseToolEnvelope(raw: string): ToolEnvelope {
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = asRecord(parsed);
    if (record?.ok === true && "data" in record) {
      return { ok: true, data: record.data };
    }
    if (record?.ok === false && typeof record.error === "string") {
      return { ok: false, error: record.error };
    }
  } catch {
    // Return a clear error below; tools should always return JSON.
  }

  return { ok: false, error: "La herramienta devolvió una respuesta no válida." };
}

function stringify(value: unknown, maxLength = 1_800): string {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength - 1)}…`
    : serialized;
}

function summarizeResult(name: string, envelope: ToolEnvelope): string {
  if (!envelope.ok) return envelope.error;
  const data = asRecord(envelope.data);
  if (!data) return stringify(envelope.data);

  if (name === "oc_leer_paquete") {
    const packageData = asRecord(data.paquete);
    const request = asRecord(packageData?.solicitud);
    return [
      "Paquete leído desde fixtures.",
      request?.solicitud_id ? `Solicitud: ${request.solicitud_id}.` : "",
      request?.proveedor_nombre ? `Proveedor: ${request.proveedor_nombre}.` : "",
      request?.valor_total !== undefined
        ? `Total: ${request.valor_total} ${String(request.moneda ?? "")}.`
        : "",
      `Cotización: ${packageData?.cotizacion ? "presente" : "ausente"}.`,
      `Aprobación: ${packageData?.aprobacion ? "presente" : "ausente"}.`,
      `Factura: ${packageData?.factura ? "presente" : "ausente"}.`,
      Array.isArray(data.faltantes) && data.faltantes.length > 0
        ? `Adjuntos faltantes: ${data.faltantes.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (name === "oc_validar") {
    const validation = ValidacionSchema.safeParse(data);
    if (validation.success) {
      return [
        `Apta: ${validation.data.apta ? "sí" : "no"}.`,
        `Bloqueos: ${validation.data.bloqueos.length}.`,
        validation.data.bloqueos.join(" "),
        `Confirmaciones: ${validation.data.confirmaciones.length}.`,
        validation.data.confirmaciones.join(" "),
        `Retroactiva: ${validation.data.retroactiva ? "sí" : "no"}.`,
        validation.data.derivados.indicador_iva
          ? `IVA: ${validation.data.derivados.indicador_iva}.`
          : "",
        validation.data.derivados.condiciones_pago
          ? `Pago: ${validation.data.derivados.condiciones_pago}.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
  }

  if (name === "oc_generar_evidencia") {
    return `Evidencia: ${String(data.ruta ?? "sin ruta")}. SHA-256: ${String(data.sha256 ?? "no disponible")}.`;
  }

  if (name === "oc_construir_payload") {
    const parsed = OrdenCompraSchema.safeParse(data.payload);
    if (parsed.success) {
      const order = parsed.data;
      const item = order.posiciones[0];
      return [
        "Payload SAP validado.",
        `Solicitud: ${order.referencia.solicitud_id}.`,
        `Proveedor: ${order.proveedor.nombre} (${order.proveedor.codigo_sap}).`,
        `Total: ${item.cantidad * item.precio_unitario} ${order.moneda}.`,
        `Centro: ${item.centro_costo} / ${item.subarea}.`,
        `Trazabilidad: ${String(data.trazabilidad ?? "no disponible")}.`,
      ].join(" ");
    }
  }

  if (name === "oc_crear") {
    return [
      `Orden: ${String(data.numero_oc ?? "sin número")}.`,
      `Fecha: ${String(data.fecha ?? "no disponible")}.`,
      `Idempotente: ${data.idempotente === true ? "sí" : "no"}.`,
      `Evidencia: ${String(data.evidencia ?? "no disponible")}.`,
    ].join(" ");
  }

  return stringify(data);
}

async function logToolCall(
  root: string,
  sessionId: string,
  name: string,
  args: unknown,
  result: string,
): Promise<void> {
  const directory = outputDirectory(root);
  await mkdir(directory, { recursive: true });
  await appendFile(
    join(directory, "log.jsonl"),
    `${JSON.stringify({
      type: "tool_call",
      sessionId,
      name,
      arguments: args,
      result,
      ts: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}

async function logModelUsage(
  root: string,
  sessionId: string,
  usage: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  },
): Promise<void> {
  const directory = outputDirectory(root);
  await mkdir(directory, { recursive: true });
  await appendFile(
    join(directory, "log.jsonl"),
    `${JSON.stringify({
      type: "model_usage",
      sessionId,
      model: GEMINI_MODEL,
      promptTokens: usage.promptTokenCount ?? null,
      outputTokens: usage.candidatesTokenCount ?? null,
      totalTokens: usage.totalTokenCount ?? null,
      ts: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}

async function invokeTool(
  session: SessionState,
  root: string,
  name: string,
  args: unknown,
  context: ToolContext,
  displayArgs: unknown = args,
): Promise<ToolRun> {
  const execution = await executeAgentTool(name, args, context);
  const envelope = parseToolEnvelope(execution.result);
  const view: ToolCallView = {
    name,
    args: stringify(displayArgs, 1_000),
    result: summarizeResult(name, envelope),
    ok: execution.ok && envelope.ok,
  };

  try {
    await logToolCall(root, session.sessionId, name, displayArgs, execution.result);
  } catch (error) {
    logger.error(
      { err: error, tool: name, sessionId: session.sessionId },
      "Unable to append the agent tool log",
    );
  }

  return { name, rawResult: execution.result, view, envelope };
}

function findRun(runs: ToolRun[], name: string): ToolRun | undefined {
  return [...runs].reverse().find((run) => run.name === name);
}

function packageFromRuns(runs: ToolRun[]): Paquete | null {
  const run = findRun(runs, "oc_leer_paquete");
  if (!run?.envelope.ok) return null;
  const data = asRecord(run.envelope.data);
  return PaqueteSchema.safeParse(data?.paquete).success
    ? PaqueteSchema.parse(data?.paquete)
    : null;
}

function validationFromRuns(runs: ToolRun[]): Validacion | null {
  const run = findRun(runs, "oc_validar");
  if (!run?.envelope.ok) return null;
  const parsed = ValidacionSchema.safeParse(run.envelope.data);
  return parsed.success ? parsed.data : null;
}

function payloadFromRuns(runs: ToolRun[]): OrdenCompra | null {
  const run = findRun(runs, "oc_construir_payload");
  if (!run?.envelope.ok) return null;
  const data = asRecord(run.envelope.data);
  const parsed = OrdenCompraSchema.safeParse(data?.payload);
  return parsed.success ? parsed.data : null;
}

function caseFromText(message: string): string | null {
  const match = message.match(/\bsol-00[1-6]\b/i);
  return match?.[0].toLowerCase() ?? null;
}

function withoutSelectedCasePrefix(message: string): string {
  return message.replace(
    /^\s*caso seleccionado:\s*sol-00[1-6]\s*\([^)]*\)\.\s*/i,
    "",
  );
}

function requestsHold(message: string): boolean {
  const normalized = withoutSelectedCasePrefix(message)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return /\bno\s+(?:la\s+)?(?:crees|crear|generes|registres)\b/.test(normalized);
}

function explicitlyConfirms(message: string): boolean {
  const messageWithoutCase = withoutSelectedCasePrefix(message);
  const normalized = messageWithoutCase
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
  if (/^(no|no confirmo|cancelo|cancelar|rechazo)\b/.test(normalized)) return false;
  return /\b(confirmo|confirmar|autorizo|apruebo|de acuerdo|adelante|proceder)\b/.test(
    normalized,
  ) || /^(si|sí|ok|dale)[.! ]*$/.test(
    messageWithoutCase.trim().toLowerCase(),
  );
}

function explicitlyDeclines(message: string): boolean {
  const normalized = withoutSelectedCasePrefix(message)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
  return /^(no|no confirmo|cancelo|cancelar|rechazo|no,)/.test(normalized);
}

function summarizeValidation(
  packageData: Paquete,
  validation: Validacion,
  payload: OrdenCompra | null,
): string {
  const request = packageData.solicitud;
  const details = [
    `Revisión de ${request.solicitud_id}.`,
    `Proveedor: ${payload?.proveedor.nombre ?? request.proveedor_nombre}.`,
    `Total: ${request.valor_total.toLocaleString("es-CO")} ${request.moneda}.`,
    `Centro de costo: ${request.centro_costo} · ${request.subarea}.`,
    validation.bloqueos.length
      ? `Bloqueos: ${validation.bloqueos.join(" ")}`
      : "Bloqueos: ninguno.",
  ];

  if (validation.confirmaciones.length > 0) {
    details.push(`Confirmaciones pendientes: ${validation.confirmaciones.join(" ")}`);
    details.push(
      "La orden no se ha creado. Confirma explícitamente si autorizas continuar.",
    );
  } else {
    details.push("No hay excepciones que requieran confirmación.");
  }

  if (payload) {
    details.push(`Payload SAP: ${payload.posiciones[0].descripcion}.`);
  }

  return details.join("\n");
}

function suggestedAction(block: string): string {
  if (block.startsWith("RC1")) {
    return "Verifica el NIT y solicita que el proveedor se registre o active en el maestro.";
  }
  if (block.startsWith("RC2")) {
    return "Solicita la aprobación de una persona autorizada para ese centro de costo.";
  }
  if (block.startsWith("RC3")) {
    return "Solicita revisión por una autoridad con el tope requerido; no se ajustará el monto.";
  }
  if (block.startsWith("RC4")) {
    return "Verifica el centro de costo y la subárea con la persona solicitante.";
  }
  if (block.startsWith("RC10")) {
    return "Pide al solicitante que corrija cantidad, precio unitario o total en el documento fuente.";
  }
  return "Corrige el dato en el documento o maestro original y vuelve a procesar el caso.";
}

function blockedReply(validation: Validacion): string {
  const actions = validation.bloqueos.map(
    (block) => `• ${block}\n  Acción sugerida: ${suggestedAction(block)}`,
  );
  return [
    "No se creó la orden porque el caso tiene bloqueos.",
    ...actions,
    "Corrige los datos de origen y vuelve a procesar la solicitud.",
  ].join("\n");
}

function createReply(run: ToolRun | undefined): string {
  if (!run) {
    return "El servidor no confirmó que la orden se haya guardado. No puedo afirmar que fue creada.";
  }
  if (!run.envelope.ok) {
    return `La orden no se creó. ${run.envelope.error}`;
  }
  const data = asRecord(run.envelope.data);
  if (!data || typeof data.numero_oc !== "string") {
    return "El servidor no confirmó que la orden se haya guardado. No puedo afirmar que fue creada.";
  }
  const idempotente = data.idempotente === true;
  return [
    idempotente
      ? `La solicitud ya tenía una orden. Se devolvió el número existente ${data.numero_oc}.`
      : `Orden creada en SAP simulado: ${data.numero_oc}.`,
    typeof data.fecha === "string" ? `Fecha registrada: ${data.fecha}.` : "",
    typeof data.evidencia === "string"
      ? `Evidencia: ${data.evidencia}.`
      : "",
    typeof data.trazabilidad === "string"
      ? `Trazabilidad: ${data.trazabilidad}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function readSystemInstruction(root: string): Promise<string> {
  const [prompt, knowledge] = await Promise.all([
    readFile(join(root, "agent", "prompt.md"), "utf8"),
    readFile(
      join(
        root,
        "artifacts",
        "api-server",
        "src",
        "knowledge",
        "ordenes-compra.md",
      ),
      "utf8",
    ),
  ]);
  return `${prompt}\n\n---\n\nConocimiento del proceso:\n${knowledge}`;
}

function modelFunctionResponse(name: string, result: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(result);
    const record = asRecord(parsed);
    return record ?? { output: parsed };
  } catch {
    return { error: result };
  }
}

async function completeCase(
  session: SessionState,
  root: string,
  caso: string,
  userMessage: string,
  runs: ToolRun[],
): Promise<{ reply: string; pendingCase: string | null }> {
  const context: ToolContext = {
    directory: root,
    sessionId: session.sessionId,
    humanConfirmedCase: null,
    allowAutomaticCreateCase: null,
    allowedCase: caso,
  };
  const ensure = async (name: string): Promise<void> => {
    if (findRun(runs, name)?.envelope.ok) return;
    const run = await invokeTool(
      session,
      root,
      name,
      { caso },
      context,
      { caso },
    );
    runs.push(run);
  };

  await ensure("oc_leer_paquete");
  await ensure("oc_validar");

  const packageData = packageFromRuns(runs);
  const validation = validationFromRuns(runs);
  if (!packageData || !validation) {
    const errorRun = [...runs].reverse().find((run) => !run.envelope.ok);
    return {
      reply: `No pude completar la lectura o validación del caso. ${errorRun?.envelope.ok === false ? errorRun.envelope.error : "Revisa los archivos fuente y vuelve a intentarlo."}`,
      pendingCase: null,
    };
  }

  if (!validation.apta) {
    session.pending = null;
    return { reply: blockedReply(validation), pendingCase: null };
  }

  await ensure("oc_generar_evidencia");
  await ensure("oc_construir_payload");
  const payload = payloadFromRuns(runs);
  if (!payload) {
    return {
      reply: "Las validaciones pasaron, pero no pude preparar el payload SAP. No se creó la orden.",
      pendingCase: null,
    };
  }

  const createRun = findRun(runs, "oc_crear");
  if (validation.confirmaciones.length > 0 || requestsHold(userMessage)) {
    if (createRun?.envelope.ok) {
      return {
        reply:
          "El servidor indicó que la orden se creó antes de que se completara la revisión. Revisa el registro de control.",
        pendingCase: null,
      };
    }

    session.pending = { caso, payload };
    return {
      reply: summarizeValidation(packageData, validation, payload),
      pendingCase: caso,
    };
  }

  if (createRun?.envelope.ok) {
    session.pending = null;
    return { reply: createReply(createRun), pendingCase: null };
  }

  const created = await invokeTool(
    session,
    root,
    "oc_crear",
    { caso, payload, confirmado: false },
    {
      ...context,
      allowAutomaticCreateCase: caso,
    },
    { caso, confirmado: false },
  );
  runs.push(created);
  session.pending = null;
  return { reply: createReply(created), pendingCase: null };
}

async function confirmPending(
  session: SessionState,
  root: string,
  message: string,
): Promise<ChatResult> {
  const pending = session.pending;
  if (!pending) {
    throw new Error("No hay una confirmación pendiente.");
  }

  session.messages.push(makeMessage("user", message));
  session.contents.push({ role: "user", parts: [{ text: message }] });

  if (explicitlyDeclines(message)) {
    session.pending = null;
    const reply =
      "No se creó la orden. La confirmación pendiente fue cancelada.";
    session.messages.push(makeMessage("assistant", reply));
    session.contents.push({ role: "model", parts: [{ text: reply }] });
    return {
      sessionId: session.sessionId,
      reply,
      toolCalls: [],
      needsConfirmation: false,
      pendingCase: null,
    };
  }

  if (!explicitlyConfirms(message)) {
    const reply =
      "Todavía no recibí una confirmación explícita, así que no creé la orden. Responde «Confirmo» para continuar o «No» para cancelar.";
    session.messages.push(makeMessage("assistant", reply));
    session.contents.push({ role: "model", parts: [{ text: reply }] });
    return {
      sessionId: session.sessionId,
      reply,
      toolCalls: [],
      needsConfirmation: true,
      pendingCase: pending.caso,
    };
  }

  const context: ToolContext = {
    directory: root,
    sessionId: session.sessionId,
    humanConfirmedCase: pending.caso,
    allowAutomaticCreateCase: null,
    allowedCase: pending.caso,
  };
  const run = await invokeTool(
    session,
    root,
    "oc_crear",
    { caso: pending.caso, payload: pending.payload, confirmado: true },
    context,
    { caso: pending.caso, confirmado: true },
  );
  const reply = createReply(run);
  if (run.envelope.ok) {
    session.pending = null;
  }
  session.messages.push(makeMessage("assistant", reply));
  session.contents.push({ role: "model", parts: [{ text: reply }] });

  return {
    sessionId: session.sessionId,
    reply,
    toolCalls: [run.view],
    needsConfirmation: session.pending !== null,
    pendingCase: session.pending?.caso ?? null,
  };
}

export async function sendMessage(
  sessionId: string,
  message: string,
): Promise<ChatResult> {
  const session = getOrCreateSession(sessionId);
  const root = workspaceRoot();

  if (session.pending) {
    return confirmPending(session, root, message);
  }

  session.messages.push(makeMessage("user", message));
  session.contents.push({ role: "user", parts: [{ text: message }] });

  const selectedCase = caseFromText(message) ?? session.lastCase;
  if (selectedCase) session.lastCase = selectedCase;
  const runs: ToolRun[] = [];
  let reply = "";
  let providerError = false;
  let finalContentIndex: number | null = null;
  let iterations = 0;
  let reachedTokenLimit = false;
  let reachedIterationLimit = false;

  try {
    const systemInstruction = await readSystemInstruction(root);
    while (iterations < MAX_ITERATIONS) {
      resetDailyBudgetIfNeeded();
      if (session.totalTokens >= MAX_SESSION_TOKENS) {
        reachedTokenLimit = true;
        break;
      }
      if (dailyTokensUsed >= MAX_DAILY_TOKENS) {
        reachedTokenLimit = true;
        break;
      }

      const response = await adapter.enviar(
        session.contents,
        systemInstruction,
        toolDescriptions,
      );
      const usedTokens = response.usageMetadata?.totalTokenCount ?? 0;
      try {
        await logModelUsage(root, sessionId, {
          promptTokenCount: response.usageMetadata?.promptTokenCount,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount,
          totalTokenCount: response.usageMetadata?.totalTokenCount,
        });
      } catch (error) {
        logger.error({ err: error, sessionId }, "Unable to append model usage log");
      }
      session.totalTokens += usedTokens;
      dailyTokensUsed += usedTokens;
      if (session.totalTokens > MAX_SESSION_TOKENS) {
        reachedTokenLimit = true;
        break;
      }
      if (dailyTokensUsed > MAX_DAILY_TOKENS) {
        reachedTokenLimit = true;
        break;
      }

      const candidate = response.candidates?.[0];
      const content = candidate?.content;
      const parts = content?.parts ?? [];
      const functionCalls = parts.flatMap((part) =>
        part.functionCall ? [part.functionCall] : [],
      );

      if (!content) {
        reply =
          response.text?.trim() ||
          "Gemini no devolvió una respuesta. Puedes volver a intentarlo.";
        break;
      }

      session.contents.push(content);
      if (functionCalls.length === 0) {
        finalContentIndex = session.contents.length - 1;
        reply =
          parts
            .flatMap((part) => (part.text ? [part.text] : []))
            .join("\n")
            .trim() ||
          response.text?.trim() ||
          "No recibí una respuesta utilizable. Puedes volver a intentarlo.";
        break;
      }

      const responses: NonNullable<Content["parts"]> = [];
      for (const call of functionCalls) {
        const name = call.name ?? "";
        const args = call.args ?? {};
        const context: ToolContext = {
          directory: root,
          sessionId,
          humanConfirmedCase: null,
          allowAutomaticCreateCase:
            selectedCase && !requestsHold(message) ? selectedCase : null,
          allowedCase: selectedCase,
        };
        const run = await invokeTool(session, root, name, args, context, args);
        runs.push(run);
        responses.push({
          functionResponse: {
            name,
            response: modelFunctionResponse(name, run.rawResult),
          },
        });
      }
      session.contents.push({ role: "user", parts: responses });
      iterations += 1;
    }

    if (iterations >= MAX_ITERATIONS) {
      reply =
        "Llegué al límite de pasos de esta conversación. Revisa las herramientas ejecutadas y vuelve a indicar qué caso falta procesar.";
      reachedIterationLimit = true;
    } else if (reachedTokenLimit) {
      reply =
        "Se alcanzó el límite de uso configurado para esta sesión o el servicio. Vuelve a intentarlo cuando el límite se restablezca.";
    }
  } catch (error) {
    providerError = true;
    reply =
      "No pude consultar Gemini en este momento. Verifica la conexión e inténtalo de nuevo.";
    const details: Record<string, string | number> = {
      sessionId,
      errorType: error instanceof Error ? error.name : typeof error,
    };
    if (error instanceof Error) {
      details.providerMessage = error.message
        .replace(/\bAIza[\w-]{20,}\b/g, "[redacted]")
        .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]")
        .slice(0, 300);
    }
    if (typeof error === "object" && error !== null) {
      const providerFailure = error as {
        status?: unknown;
        statusCode?: unknown;
      };
      const status =
        typeof providerFailure.status === "number"
          ? providerFailure.status
          : providerFailure.statusCode;
      if (typeof status === "number") details.httpStatus = status;
    }
    logger.warn(details, "Gemini request failed");
  }

  let pendingCase: string | null = null;
  if (reachedTokenLimit) {
    reply =
      "Se alcanzó el límite de uso configurado para esta sesión o el servicio. Vuelve a intentarlo cuando el límite se restablezca.";
  } else if (reachedIterationLimit) {
    // The model/tool loop limit is a hard boundary; do not create an order in a fallback path.
  } else if (selectedCase) {
    const completed = await completeCase(
      session,
      root,
      selectedCase,
      message,
      runs,
    );
    reply = providerError
      ? `Gemini no respondió; procesé el caso con las validaciones locales. No se infirieron valores.\n\n${completed.reply}`
      : completed.reply;
    pendingCase = completed.pendingCase;
    if (finalContentIndex !== null) {
      session.contents[finalContentIndex] = {
        role: "model",
        parts: [{ text: reply }],
      };
    } else {
      session.contents.push({ role: "model", parts: [{ text: reply }] });
    }
  }

  const toolCalls = runs.map((run) => run.view);
  session.messages.push(makeMessage("assistant", reply, toolCalls));
  return {
    sessionId,
    reply,
    toolCalls,
    needsConfirmation: session.pending !== null,
    pendingCase,
  };
}
