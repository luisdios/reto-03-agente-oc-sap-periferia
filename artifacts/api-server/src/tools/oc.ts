import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { appendControlRecord, recordValidationAttempt } from "../lib/control";
import { hasUnambiguousApproval } from "../lib/approval";
import { caseDirectory, outputDirectory } from "../lib/workspace-paths";
import { MockSapAdapter } from "../sap/mock";
import {
  AprobacionSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoSchema,
  CotizacionSchema,
  FacturaSchema,
  IndicadorIvaSchema,
  OrdenCompraSchema,
  PaqueteSchema,
  ProveedorSchema,
  SolicitudSchema,
  ValidacionSchema,
  type Aprobacion,
  type CentroCosto,
  type CondicionPago,
  type Cotizacion,
  type Evaluacion,
  type Factura,
  type IndicadorIva,
  type OrdenCompra,
  type Paquete,
  type Proveedor,
  type Solicitud,
  type Validacion,
} from "../sap/types";

export type ToolContext = {
  directory: string;
  sessionId: string;
  humanConfirmedCase?: string | null;
  allowAutomaticCreateCase?: string | null;
  allowedCase?: string | null;
  expectedPayload?: OrdenCompra;
};

export type Tool<TArgs extends z.ZodObject<z.ZodRawShape>> = {
  description: string;
  args: TArgs;
  execute(args: z.infer<TArgs>, ctx: ToolContext): Promise<string>;
};

type ToolResult<TData> =
  | { ok: true; data: TData }
  | { ok: false; error: string };

type Masters = {
  proveedores: Proveedor[];
  centros: CentroCosto[];
  iva: IndicadorIva[];
  pagos: CondicionPago[];
};

type PayloadBuild = {
  payload: OrdenCompra;
  trazabilidadPath: string;
  fuentes: Record<string, string>;
};

function success<TData>(data: TData): string {
  return JSON.stringify({ ok: true, data } satisfies ToolResult<TData>);
}

function failure(error: string): string {
  return JSON.stringify({ ok: false, error } satisfies ToolResult<never>);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Error inesperado al procesar el caso.";
}

async function readJson(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as unknown;
}

async function readMasters(root: string): Promise<Masters> {
  const directory = join(root, "fixtures", "reto-03", "maestros");
  const [providers, costCenters, iva, payments] = await Promise.all([
    readJson(join(directory, "proveedores.json")),
    readJson(join(directory, "centros-costo.json")),
    readJson(join(directory, "indicadores-iva.json")),
    readJson(join(directory, "condiciones-pago.json")),
  ]);

  return {
    proveedores: z.array(ProveedorSchema).parse(providers),
    centros: z.array(CentroCostoSchema).parse(costCenters),
    iva: z.array(IndicadorIvaSchema).parse(iva),
    pagos: z.array(CondicionPagoSchema).parse(payments),
  };
}

function nitBase(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length > 9 ? digits.slice(0, 9) : digits;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseMoney(value: string): number {
  const withoutGroupSeparators = value
    .trim()
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const amount = Number(withoutGroupSeparators);
  if (!Number.isFinite(amount)) {
    throw new Error(`No se pudo interpretar el monto «${value}».`);
  }
  return amount;
}

function parseCurrency(text: string): "COP" | "USD" {
  const match = text.match(/\b(COP|USD)\b/i);
  if (!match) {
    throw new Error("No se encontró la moneda en la cotización o factura.");
  }
  return match[1].toUpperCase() as "COP" | "USD";
}

function parseQuote(text: string): Cotizacion {
  const supplier = text.match(/^Proveedor\s*:\s*(.+)$/im)?.[1]?.trim();
  const nit = text.match(/^NIT\s*:\s*(.+)$/im)?.[1]?.trim() ?? null;
  const reference =
    text.match(/^COTIZACI[ÓO]N\s+([^\r\n]+)/im)?.[1]?.trim() ?? null;
  const totalMatch = text.match(
    /TOTAL(?:\s*\([^)]*\))?\s*:\s*(?:COP|USD)\s*([\d.,]+)/i,
  );

  if (!supplier || !totalMatch) {
    throw new Error("La cotización no contiene proveedor o total legible.");
  }

  return CotizacionSchema.parse({
    referencia: reference,
    proveedor: supplier,
    nit,
    total: parseMoney(totalMatch[1]),
    moneda: parseCurrency(totalMatch[0]),
    validez_hasta: null,
    texto: text,
  });
}

function parseInvoice(text: string): Factura {
  const number =
    text.match(/Factura(?:\s+electr[óo]nica[^.\r\n]*)?\s+No\.?\s*([^\r\n]+)/i)?.[1]
      ?.trim() ?? text.match(/No\.\s*([A-Z0-9-]+)/i)?.[1]?.trim();
  const date = text.match(/Fecha de emisi[óo]n\s*:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  const totalMatch = text.match(
    /TOTAL(?:\s*\([^)]*\))?\s*:\s*(?:COP|USD)\s*([\d.,]+)/i,
  );

  if (!number || !date || !totalMatch) {
    throw new Error("La factura no contiene número, fecha o total legible.");
  }

  return FacturaSchema.parse({
    numero: number,
    fecha: date,
    total: parseMoney(totalMatch[1]),
  });
}

async function optionalText(path: string): Promise<string | null> {
  try {
    await access(path, constants.F_OK);
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadCanonicalPackage(
  root: string,
  caso: string,
): Promise<Paquete> {
  const directory = caseDirectory(root, caso);
  const correo = CorreoSchema.parse(await readJson(join(directory, "correo.json")));
  const solicitud = SolicitudSchema.parse(
    await readJson(join(directory, "solicitud.json")),
  );
  const quoteText = await optionalText(join(directory, "cotizacion.txt"));
  const approvalPath = join(directory, "aprobacion.json");
  const invoiceText = await optionalText(join(directory, "factura.txt"));
  const attachedNames = correo.adjuntos.map((item) => item.toLowerCase());
  const faltantes: string[] = [];

  if (attachedNames.includes("cotizacion.pdf") && quoteText === null) {
    faltantes.push("cotizacion.pdf (archivo normalizado: cotizacion.txt)");
  }
  if (
    attachedNames.includes("aprobacion.eml") &&
    !(await optionalText(approvalPath))
  ) {
    faltantes.push("aprobacion.eml (archivo normalizado: aprobacion.json)");
  }
  if (attachedNames.includes("factura.pdf") && invoiceText === null) {
    faltantes.push("factura.pdf (archivo normalizado: factura.txt)");
  }

  const approvalText = await optionalText(approvalPath);
  const quote = quoteText === null ? null : parseQuote(quoteText);
  const approval: Aprobacion | null =
    approvalText === null
      ? null
      : AprobacionSchema.parse(JSON.parse(approvalText) as unknown);
  const invoice: Factura | null =
    invoiceText === null ? null : parseInvoice(invoiceText);

  return PaqueteSchema.parse({
    correo,
    solicitud,
    cotizacion: quote,
    aprobacion: approval
      ? {
          ...approval,
          aprobado: hasUnambiguousApproval(approval.cuerpo),
          texto: approval.cuerpo,
        }
      : null,
    factura: invoice,
    faltantes,
  });
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function confirmation(code: string, detail: string): string {
  return `[${code}] ${detail}`;
}

function detectUnit(paquete: Paquete): "UN" | "H" | "MES" {
  const searchableText = [
    paquete.solicitud.descripcion,
    paquete.cotizacion?.texto ?? "",
  ]
    .join(" ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  if (/\bhoras?\b/.test(searchableText)) return "H";
  if (/\bmes(?:es)?\b/.test(searchableText)) return "MES";
  return "UN";
}

export async function evaluateCase(
  root: string,
  caso: string,
): Promise<Evaluacion> {
  const paquete = await loadCanonicalPackage(root, caso);
  const masters = await readMasters(root);
  const request = paquete.solicitud;
  const bloqueos: string[] = [];
  const confirmaciones: string[] = [];
  const derivados: Validacion["derivados"] = {};
  let retroactiva = false;

  const proveedor = request.proveedor_nit
    ? masters.proveedores.find(
        (item) => nitBase(item.nit) === nitBase(request.proveedor_nit ?? ""),
      ) ?? null
    : masters.proveedores.find(
        (item) =>
          normalizeName(item.nombre) === normalizeName(request.proveedor_nombre),
      ) ?? null;

  if (!proveedor) {
    addUnique(
      bloqueos,
      `RC1: proveedor «${request.proveedor_nombre}» no existe en el maestro.`,
    );
  } else if (!proveedor.activo) {
    addUnique(
      bloqueos,
      `RC1: proveedor «${proveedor.nombre}» está inactivo en el maestro.`,
    );
  }

  const centro = masters.centros.find(
    (item) => item.centro_costo === request.centro_costo,
  );
  if (!centro) {
    addUnique(
      bloqueos,
      `RC4: el centro de costo «${request.centro_costo}» no existe.`,
    );
  } else if (!centro.subareas.includes(request.subarea)) {
    addUnique(
      bloqueos,
      `RC4: la subárea «${request.subarea}» no pertenece a ${request.centro_costo}.`,
    );
  }

  let aprobador: CentroCosto["aprobadores"][number] | null = null;
  if (!paquete.aprobacion) {
    addUnique(bloqueos, "RC2: falta el correo de aprobación.");
  } else {
    const approved = hasUnambiguousApproval(paquete.aprobacion.cuerpo);
    if (!approved) {
      addUnique(
        bloqueos,
        "RC2: se requiere una aprobación afirmativa inequívoca: «Aprobado», sin negaciones, preguntas ni condiciones.",
      );
    }

    aprobador =
      centro?.aprobadores.find(
        (item) => item.email.toLowerCase() === paquete.aprobacion?.de.toLowerCase(),
      ) ?? null;
    if (!aprobador) {
      addUnique(
        bloqueos,
        `RC2: ${paquete.aprobacion.de} no figura como aprobador del centro de costo.`,
      );
    } else if (request.valor_total > aprobador.tope) {
      addUnique(
        bloqueos,
        `RC3: el monto ${request.valor_total} supera el tope de ${aprobador.tope} de ${aprobador.nombre}.`,
      );
    }

    const requestTime = Date.parse(`${request.fecha_solicitud}T00:00:00Z`);
    const approvalTime = Date.parse(paquete.aprobacion.fecha);
    if (
      Number.isFinite(requestTime) &&
      Number.isFinite(approvalTime) &&
      approvalTime < requestTime
    ) {
      addUnique(
        confirmaciones,
        confirmation(
          "RC9_APROBACION_ANTERIOR",
          `La aprobación (${paquete.aprobacion.fecha.slice(0, 10)}) es anterior a la solicitud (${request.fecha_solicitud}).`,
        ),
      );
    }
  }

  if (!Number.isFinite(request.valor_total) || request.valor_total <= 0) {
    addUnique(bloqueos, "El valor total debe ser un monto positivo y numérico.");
  }
  const calculatedTotal = request.cantidad * request.valor_unitario;
  if (Math.abs(calculatedTotal - request.valor_total) > 1) {
    addUnique(
      bloqueos,
      `RC10: cantidad × precio unitario (${calculatedTotal}) no coincide con el total de solicitud (${request.valor_total}), con tolerancia de 1 unidad monetaria.`,
    );
  }

  if (!paquete.cotizacion) {
    addUnique(
      confirmaciones,
      confirmation("RC5_COTIZACION_AUSENTE", "No se adjuntó una cotización."),
    );
  } else {
    if (paquete.cotizacion.moneda !== request.moneda) {
      addUnique(
        confirmaciones,
        confirmation(
          "RC5_MONEDA_DIFERENTE",
          `La cotización está en ${paquete.cotizacion.moneda} y la solicitud en ${request.moneda}.`,
        ),
      );
    }
    const difference =
      Math.abs(paquete.cotizacion.total - request.valor_total) /
      Math.abs(request.valor_total || 1);
    if (difference > 0.02) {
      addUnique(
        confirmaciones,
        confirmation(
          "RC5_COTIZACION_DIFERENTE",
          `La solicitud indica ${request.valor_total} ${request.moneda} y la cotización ${paquete.cotizacion.total} ${paquete.cotizacion.moneda}; diferencia ${(difference * 100).toFixed(2)} %, mayor al 2 %.`,
        ),
      );
    }
  }

  const ivaCode = request.indicador_iva?.trim() || null;
  if (!ivaCode) {
    if (proveedor && masters.iva.some((item) => item.codigo === proveedor.indicador_iva_default)) {
      derivados.indicador_iva = proveedor.indicador_iva_default;
      addUnique(
        confirmaciones,
        confirmation(
          "RC6_IVA_DERIVADO",
          `La solicitud no informa IVA; se propone ${proveedor.indicador_iva_default} (${masters.iva.find((item) => item.codigo === proveedor.indicador_iva_default)?.descripcion ?? "código del proveedor"}).`,
        ),
      );
    } else {
      addUnique(
        bloqueos,
        "RC6: no se puede derivar un IVA válido: falta el proveedor o su indicador predeterminado no existe en el maestro autorizado.",
      );
    }
  } else if (!masters.iva.some((item) => item.codigo === ivaCode)) {
    addUnique(
      bloqueos,
      `RC6: el indicador de IVA «${ivaCode}» no existe en el maestro.`,
    );
  } else {
    derivados.indicador_iva = ivaCode;
  }

  const paymentCode =
    request.condiciones_pago?.trim() || proveedor?.condiciones_pago_default;
  if (!paymentCode) {
    addUnique(
      bloqueos,
      "RC7: no se encontró una condición de pago en la solicitud ni en el maestro del proveedor.",
    );
  } else if (!masters.pagos.some((item) => item.codigo === paymentCode)) {
    addUnique(
      bloqueos,
      `RC7: la condición de pago «${paymentCode}» no existe en el maestro.`,
    );
  } else {
    derivados.condiciones_pago = paymentCode;
  }

  derivados.unidad = detectUnit(paquete);

  if (paquete.factura) {
    const invoiceDate = Date.parse(`${paquete.factura.fecha}T00:00:00Z`);
    const requestDate = Date.parse(`${request.fecha_solicitud}T00:00:00Z`);
    if (
      Number.isFinite(invoiceDate) &&
      Number.isFinite(requestDate) &&
      invoiceDate < requestDate
    ) {
      retroactiva = true;
      addUnique(
        confirmaciones,
        confirmation(
          "RC8_RETROACTIVA",
          `La factura ${paquete.factura.numero} está fechada ${paquete.factura.fecha}, antes de la solicitud ${request.fecha_solicitud}.`,
        ),
      );
    }
  }

  const validacion = ValidacionSchema.parse({
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva,
  });

  return {
    paquete,
    validacion,
    proveedor,
    aprobador,
  };
}

function exceptionCode(message: string): string {
  return message.match(/^\[([^\]]+)\]/)?.[1] ?? "CONFIRMACION";
}

async function buildCanonicalPayload(
  root: string,
  caso: string,
): Promise<PayloadBuild> {
  const evaluation = await evaluateCase(root, caso);
  const { paquete, validacion, proveedor, aprobador } = evaluation;
  const request: Solicitud = paquete.solicitud;

  if (!validacion.apta) {
    throw new Error(
      `La orden no se puede construir porque tiene bloqueos: ${validacion.bloqueos.join(" ")}`,
    );
  }
  if (!proveedor || !paquete.aprobacion || !aprobador) {
    throw new Error("Faltan datos maestros o aprobación para construir la orden.");
  }

  const caseOutDirectory = join(outputDirectory(root), caso);
  const evidencePath = join(caseOutDirectory, "aprobacion.txt");
  let evidenceText: string;
  try {
    evidenceText = await readFile(evidencePath, "utf8");
  } catch {
    throw new Error("Genera primero la evidencia de aprobación.");
  }
  const evidenceHash = createHash("sha256").update(evidenceText, "utf8").digest("hex");
  const description = request.descripcion.slice(0, 40);
  const fuentes: Record<string, string> = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": paquete.cotizacion
      ? "cotizacion.txt (encabezado)"
      : "null: no se adjuntó cotización",
    sociedad: "derivado: sociedad del escenario SAP simulado",
    organizacion_compras: "derivado: organización del escenario SAP simulado",
    "proveedor.codigo_sap": "maestro.proveedores.codigo_sap",
    "proveedor.nit": request.proveedor_nit
      ? "solicitud.proveedor_nit"
      : "maestro.proveedores.nit",
    "proveedor.nombre": "maestro.proveedores.nombre",
    moneda: "solicitud.moneda",
    condiciones_pago: request.condiciones_pago
      ? "solicitud.condiciones_pago"
      : "derivado: maestro.proveedores.condiciones_pago_default",
    "aprobador.email": "aprobacion.de validado contra maestro.centros-costo",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado: SHA-256 de aprobacion.txt",
    "posiciones[0].numero": "derivado: primera posición SAP",
    "posiciones[0].descripcion": request.descripcion.length > 40
      ? "solicitud.descripcion truncada al límite SAP de 40 caracteres"
      : "solicitud.descripcion",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": paquete.cotizacion
      ? "derivado del texto de cotización y solicitud"
      : "derivado: UN cuando la unidad no aparece en los documentos",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": request.indicador_iva
      ? "solicitud.indicador_iva"
      : "derivado: maestro.proveedores.indicador_iva_default",
    excepciones: "confirmaciones RC5, RC6, RC7, RC8 y RC9 de oc_validar",
  };
  const payload = OrdenCompraSchema.parse({
    referencia: {
      solicitud_id: request.solicitud_id,
      correo_id: paquete.correo.id,
      cotizacion_ref: paquete.cotizacion?.referencia ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: {
      codigo_sap: proveedor.codigo_sap,
      nit: request.proveedor_nit ?? proveedor.nit,
      nombre: proveedor.nombre,
    },
    moneda: request.moneda,
    condiciones_pago: validacion.derivados.condiciones_pago,
    aprobador: {
      email: paquete.aprobacion.de,
      fecha_aprobacion: paquete.aprobacion.fecha,
      evidencia_sha256: evidenceHash,
    },
    posiciones: [
      {
        numero: 10,
        descripcion: description,
        cantidad: request.cantidad,
        unidad: validacion.derivados.unidad ?? "UN",
        precio_unitario: request.valor_unitario,
        centro_costo: request.centro_costo,
        subarea: request.subarea,
        indicador_iva: validacion.derivados.indicador_iva,
      },
    ],
    excepciones: validacion.confirmaciones.map((detalle) => ({
      codigo: exceptionCode(detalle),
      detalle: detalle.replace(/^\[[^\]]+\]\s*/, ""),
      confirmado_por: null,
    })),
  });

  return {
    payload,
    trazabilidadPath: join(caseOutDirectory, "trazabilidad.json"),
    fuentes,
  };
}

async function saveTrace(build: PayloadBuild): Promise<void> {
  await mkdir(join(build.trazabilidadPath, ".."), { recursive: true });
  await writeFile(
    build.trazabilidadPath,
    `${JSON.stringify(
      {
        payload: build.payload,
        fuentes: build.fuentes,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function generateEvidence(
  root: string,
  caso: string,
): Promise<{ ruta: string; sha256: string }> {
  const packageData = await loadCanonicalPackage(root, caso);
  if (!packageData.aprobacion) {
    throw new Error("No se encontró el correo de aprobación para crear evidencia.");
  }

  const approval = packageData.aprobacion;
  const content = [
    `De: ${approval.de}`,
    `Para: ${approval.para}`,
    `Fecha: ${approval.fecha}`,
    `Asunto: ${approval.asunto}`,
    "",
    approval.cuerpo,
    "",
  ].join("\n");
  const directory = join(outputDirectory(root), caso);
  const ruta = join(directory, "aprobacion.txt");
  await mkdir(directory, { recursive: true });
  await writeFile(ruta, content, "utf8");

  return {
    ruta: ruta.replace(`${root}/`, ""),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

const CaseArgs = z.object({
  caso: z.string().describe("Carpeta del caso: sol-001 a sol-006."),
});

export const leer_paquete: Tool<typeof CaseArgs> = {
  description:
    "Lee y normaliza el correo, solicitud, cotización, aprobación y factura disponibles para un caso.",
  args: CaseArgs,
  async execute(args, ctx) {
    try {
      const paquete = await loadCanonicalPackage(ctx.directory, args.caso);
      return success({ ...paquete, paquete, faltantes: paquete.faltantes });
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
};

const ValidationArgs = z.object({
  caso: z.string().describe("Carpeta del caso: sol-001 a sol-006."),
  paquete: z
    .unknown()
    .optional()
    .describe("Paquete leído previamente; el servidor vuelve a usar los fixtures."),
});

export const validar: Tool<typeof ValidationArgs> = {
  description:
    "Valida proveedor, centro de costo, aprobación, monto, cotización, IVA, pagos y retroactividad contra los maestros.",
  args: ValidationArgs,
  async execute(args, ctx) {
    try {
      const evaluation = await evaluateCase(ctx.directory, args.caso);
      await recordValidationAttempt(
        ctx.directory,
        evaluation.paquete.solicitud.solicitud_id,
        evaluation.validacion,
      );
      return success(evaluation.validacion);
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
};

const EvidenceArgs = CaseArgs;

export const generar_evidencia: Tool<typeof EvidenceArgs> = {
  description:
    "Genera el archivo de evidencia de aprobación en texto plano y calcula su SHA-256.",
  args: EvidenceArgs,
  async execute(args, ctx) {
    try {
      return success(await generateEvidence(ctx.directory, args.caso));
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
};

const PayloadArgs = z.object({
  caso: z.string().describe("Carpeta del caso: sol-001 a sol-006."),
  paquete: z
    .unknown()
    .optional()
    .describe("Paquete leído; el servidor vuelve a usar los fixtures."),
  derivados: z
    .unknown()
    .optional()
    .describe("Valores derivados de validación; el servidor vuelve a calcularlos."),
});

export const construir_payload: Tool<typeof PayloadArgs> = {
  description:
    "Construye y valida el payload SAP a partir de los fixtures y registra la trazabilidad de cada campo.",
  args: PayloadArgs,
  async execute(args, _ctx) {
    try {
      const build = await buildCanonicalPayload(_ctx.directory, args.caso);
      await saveTrace(build);
      return success({
        payload: build.payload,
        trazabilidad: build.trazabilidadPath.replace(`${_ctx.directory}/`, ""),
        fuentes: build.fuentes,
      });
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
};

const CreateArgs = z.object({
  caso: z.string().describe("Carpeta del caso: sol-001 a sol-006."),
  payload: z.unknown().describe("Payload generado por oc_construir_payload."),
  confirmado: z
    .boolean()
    .optional()
    .describe("Confirmación explícita de la analista para las excepciones."),
});

export const crear: Tool<typeof CreateArgs> = {
  description:
    "Crea la orden solo si la validación no tiene bloqueos y las confirmaciones humanas requeridas están completas.",
  args: CreateArgs,
  async execute(args, ctx) {
    try {
      const evaluation = await evaluateCase(ctx.directory, args.caso);
      const solicitudId = evaluation.paquete.solicitud.solicitud_id;
      const validation = evaluation.validacion;

      if (!validation.apta) {
        await appendControlRecord(ctx.directory, {
          solicitudId,
          resultado: "bloqueada",
          numeroOc: null,
          retroactiva: validation.retroactiva,
          bloqueos: validation.bloqueos,
          confirmaciones: validation.confirmaciones,
          ts: new Date().toISOString(),
        });
        return failure(
          `No se creó la orden: hay bloqueos. ${validation.bloqueos.join(" ")}`,
        );
      }

      const humanConfirmed =
        args.confirmado === true && ctx.humanConfirmedCase === args.caso;
      if (validation.confirmaciones.length > 0 && !humanConfirmed) {
        await appendControlRecord(ctx.directory, {
          solicitudId,
          resultado: "pendiente",
          numeroOc: null,
          retroactiva: validation.retroactiva,
          bloqueos: [],
          confirmaciones: validation.confirmaciones,
          ts: new Date().toISOString(),
        });
        return failure(
          "Falta una confirmación humana explícita. No se creó la orden.",
        );
      }
      if (
        validation.confirmaciones.length === 0 &&
        !humanConfirmed &&
        ctx.allowAutomaticCreateCase !== args.caso
      ) {
        return failure(
          "La analista indicó que no se cree todavía. No se creó la orden sin su confirmación.",
        );
      }

      const build = await buildCanonicalPayload(ctx.directory, args.caso);
      if (ctx.expectedPayload && !isDeepStrictEqual(ctx.expectedPayload, build.payload)) {
        return failure(
          "Los datos o las excepciones cambiaron desde la revisión. No se creó la orden. Cancela y vuelve a procesar el caso antes de confirmar.",
        );
      }
      if (!isDeepStrictEqual(args.payload, build.payload)) {
        return failure(
          "El payload recibido no coincide exactamente con el payload canónico generado desde los fixtures. No se creó la orden.",
        );
      }

      if (humanConfirmed) {
        build.payload.excepciones = build.payload.excepciones.map((exception) => ({
          ...exception,
          confirmado_por: "analista (confirmación explícita en la sesión)",
        }));
        await saveTrace(build);
      }

      const adapter = new MockSapAdapter(ctx.directory);
      const existing = await adapter.buscarOrdenPorReferencia(solicitudId);
      const created = await adapter.crearOrden(build.payload);
      const numeroOc = created.numero_oc;
      const idempotente = existing !== null;

      await appendControlRecord(ctx.directory, {
        solicitudId,
        resultado: "creada",
        numeroOc,
        retroactiva: validation.retroactiva,
        bloqueos: [],
        confirmaciones: validation.confirmaciones,
        ts: new Date().toISOString(),
      });

      return success({
        numero_oc: numeroOc,
        fecha: created.fecha,
        idempotente,
        evidencia: join("out", args.caso, "aprobacion.txt"),
        trazabilidad: join("out", args.caso, "trazabilidad.json"),
      });
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
};

export const toolDefinitions = {
  oc_leer_paquete: leer_paquete,
  oc_validar: validar,
  oc_construir_payload: construir_payload,
  oc_generar_evidencia: generar_evidencia,
  oc_crear: crear,
};

export const toolNames = Object.keys(toolDefinitions);

export type ToolName = keyof typeof toolDefinitions;

export async function executeAgentTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<{ ok: boolean; result: string }> {
  const tool = toolDefinitions[name as ToolName];
  if (!tool) {
    return {
      ok: false,
      result: failure(`La herramienta «${name}» no está disponible.`),
    };
  }

  const CreateIntentArgs = z.object({
    caso: z.string(),
    confirmado: z.boolean().optional(),
  });
  const rawParse =
    name === "oc_crear"
      ? CreateIntentArgs.safeParse(rawArgs)
      : tool.args.safeParse(rawArgs);

  if (!rawParse.success) {
    return {
      ok: false,
      result: failure(`Argumentos inválidos: ${rawParse.error.message}`),
    };
  }
  if (ctx.allowedCase) {
    const parsedRecord =
      typeof rawParse.data === "object" && rawParse.data !== null
        ? (rawParse.data as Record<string, unknown>)
        : null;
    if (parsedRecord?.caso !== ctx.allowedCase) {
      return {
        ok: false,
        result: failure(
          `La herramienta solo puede procesar el caso seleccionado ${ctx.allowedCase}.`,
        ),
      };
    }
  }

  try {
    const parsed = rawParse;
    let args: unknown = parsed.data;

    if (name === "oc_validar") {
      const typedArgs = parsed.data as { caso: string };
      const canonical = await loadCanonicalPackage(ctx.directory, typedArgs.caso);
      args = { caso: typedArgs.caso, paquete: canonical };
    } else if (name === "oc_construir_payload") {
      const typedArgs = parsed.data as { caso: string };
      const canonical = await loadCanonicalPackage(ctx.directory, typedArgs.caso);
      const evaluation = await evaluateCase(ctx.directory, typedArgs.caso);
      args = {
        caso: typedArgs.caso,
        paquete: canonical,
        derivados: evaluation.validacion.derivados,
      };
    } else if (name === "oc_crear") {
      const typedArgs = parsed.data as {
        caso: string;
        confirmado?: boolean;
      };
      const build = await buildCanonicalPayload(ctx.directory, typedArgs.caso);
      args = {
        caso: typedArgs.caso,
        payload: build.payload,
        confirmado: ctx.humanConfirmedCase === typedArgs.caso,
      };
    }

    const finalArgs = tool.args.safeParse(args);
    if (!finalArgs.success) {
      return {
        ok: false,
        result: failure(
          `No se pudieron completar argumentos confiables: ${finalArgs.error.message}`,
        ),
      };
    }

    const result = await tool.execute(finalArgs.data, ctx);
    let ok = false;
    try {
      const parsedResult: unknown = JSON.parse(result);
      ok =
        typeof parsedResult === "object" &&
        parsedResult !== null &&
        "ok" in parsedResult &&
        parsedResult.ok === true;
    } catch {
      ok = false;
    }
    return { ok, result };
  } catch (error) {
    return { ok: false, result: failure(errorMessage(error)) };
  }
}

export async function readOrderEvidence(
  root: string,
  caso: string,
): Promise<{ ruta: string; sha256: string }> {
  return generateEvidence(root, caso);
}
