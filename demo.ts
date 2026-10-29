import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { executeAgentTool } from "./artifacts/api-server/src/tools/oc";
import { outputDirectory, workspaceRoot } from "./artifacts/api-server/src/lib/workspace-paths";

const CASES = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];
const root = workspaceRoot();
const out = outputDirectory(root);
const sessionId = "demo";

async function call(
  name: string,
  args: Record<string, unknown>,
  context: {
    directory: string;
    sessionId: string;
    humanConfirmedCase?: string | null;
    allowAutomaticCreateCase?: string | null;
  },
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const execution = await executeAgentTool(name, args, context);
  const parsed: unknown = JSON.parse(execution.result);
  const result =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};

  const logDirectory = out;
  await mkdir(logDirectory, { recursive: true });
  await appendFile(
    join(logDirectory, "log.jsonl"),
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

  return {
    ok: execution.ok,
    ...(result.data &&
    typeof result.data === "object" &&
    result.data !== null
      ? { data: result.data as Record<string, unknown> }
      : {}),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
  };
}

async function processCase(
  caso: string,
): Promise<{
  apta: boolean;
  bloqueos: string[];
  confirmaciones: string[];
  retroactiva: boolean;
  numeroOc: string | null;
  idempotente: boolean;
  motivo: string | null;
}> {
  const baseContext = { directory: root, sessionId };
  await call("oc_leer_paquete", { caso }, baseContext);

  const validationCall = await call("oc_validar", { caso }, baseContext);
  if (!validationCall.ok || !validationCall.data) {
    return {
      apta: false,
      bloqueos: [],
      confirmaciones: [],
      retroactiva: false,
      numeroOc: null,
      idempotente: false,
      motivo: validationCall.error ?? "No se pudo validar el caso.",
    };
  }

  const validation = validationCall.data;
  const bloqueos = Array.isArray(validation.bloqueos)
    ? validation.bloqueos.filter((value): value is string => typeof value === "string")
    : [];
  const confirmaciones = Array.isArray(validation.confirmaciones)
    ? validation.confirmaciones.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const retroactiva = validation.retroactiva === true;
  const apta = validation.apta === true;

  if (!apta) {
    return {
      apta,
      bloqueos,
      confirmaciones,
      retroactiva,
      numeroOc: null,
      idempotente: false,
      motivo: "Bloqueada por reglas de control.",
    };
  }

  const evidence = await call("oc_generar_evidencia", { caso }, baseContext);
  if (!evidence.ok) {
    return {
      apta,
      bloqueos,
      confirmaciones,
      retroactiva,
      numeroOc: null,
      idempotente: false,
      motivo: evidence.error ?? "No se pudo generar la evidencia.",
    };
  }

  const payloadResult = await call(
    "oc_construir_payload",
    { caso },
    baseContext,
  );
  if (!payloadResult.ok) {
    return {
      apta,
      bloqueos,
      confirmaciones,
      retroactiva,
      numeroOc: null,
      idempotente: false,
      motivo: payloadResult.error ?? "No se pudo construir el payload.",
    };
  }

  if (confirmaciones.length > 0) {
    return {
      apta,
      bloqueos,
      confirmaciones,
      retroactiva,
      numeroOc: null,
      idempotente: false,
      motivo: "Requiere confirmación humana; no se creó la orden.",
    };
  }

  const created = await call(
    "oc_crear",
    { caso, confirmado: false },
    { ...baseContext, allowAutomaticCreateCase: caso },
  );
  if (!created.ok || !created.data) {
    return {
      apta,
      bloqueos,
      confirmaciones,
      retroactiva,
      numeroOc: null,
      idempotente: false,
      motivo: created.error ?? "El adaptador no confirmó la creación.",
    };
  }

  return {
    apta,
    bloqueos,
    confirmaciones,
    retroactiva,
    numeroOc:
      typeof created.data.numero_oc === "string" ? created.data.numero_oc : null,
    idempotente: created.data.idempotente === true,
    motivo: null,
  };
}

function printCase(
  caso: string,
  result: Awaited<ReturnType<typeof processCase>>,
): void {
  console.log(
    JSON.stringify({
      caso,
      apta: result.apta,
      bloqueos: result.bloqueos,
      confirmaciones: result.confirmaciones,
      retroactiva: result.retroactiva,
      numero_oc: result.numeroOc,
      idempotente: result.idempotente,
      motivo: result.motivo,
    }),
  );
}

async function main(): Promise<void> {
  if (existsSync(out)) {
    throw new Error(
      "out/ ya existe. Conserva o mueve esos resultados antes de ejecutar la demo; no se sobrescribirán.",
    );
  }

  console.log(
    "Demo determinística · SAP simulado · sin llamadas a Gemini · aprobación de sol-004 simulada explícitamente",
  );

  for (const caso of CASES) {
    const result = await processCase(caso);
    printCase(caso, result);

    if (
      caso === "sol-004" &&
      result.apta &&
      result.confirmaciones.length > 0 &&
      result.numeroOc === null
    ) {
      console.log(
        "Confirmación explícita simulada en la demo: «Confirmo la creación de sol-004».",
      );
      const confirmed = await call(
        "oc_crear",
        { caso, confirmado: true },
        { directory: root, sessionId, humanConfirmedCase: caso },
      );
      const numeroOc =
        typeof confirmed.data?.numero_oc === "string"
          ? confirmed.data.numero_oc
          : null;
      if (!confirmed.ok || !numeroOc) {
        throw new Error(
          confirmed.error ?? "No se creó sol-004 tras la confirmación explícita de demo.",
        );
      }
      printCase(`${caso} (tras confirmación explícita)`, {
        ...result,
        numeroOc,
        idempotente: confirmed.data?.idempotente === true,
        motivo: null,
      });
    }

    if (caso === "sol-001" && result.numeroOc) {
      const repeated = await processCase(caso);
      printCase(`${caso} (reintento idempotente)`, repeated);
      if (repeated.numeroOc !== result.numeroOc || !repeated.idempotente) {
        throw new Error("La repetición de sol-001 no fue idempotente.");
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "La demo no pudo completarse.");
  process.exitCode = 1;
});
