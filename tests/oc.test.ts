import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { executeAgentTool, evaluateCase } from "../artifacts/api-server/src/tools/oc";
import {
  appendControlRecord,
  readControlRecords,
} from "../artifacts/api-server/src/lib/control";
import { workspaceRoot } from "../artifacts/api-server/src/lib/workspace-paths";

let testRoot = "";

async function createIsolatedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sap-purchase-agent-rule-"));
  await cp(join(workspaceRoot(), "fixtures"), join(root, "fixtures"), {
    recursive: true,
  });
  return root;
}

async function withIsolatedRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await createIsolatedRoot();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readCaseJson(
  root: string,
  caso: string,
  filename: string,
): Promise<Record<string, unknown>> {
  const path = join(root, "fixtures", "reto-03", "solicitudes", caso, filename);
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

async function writeCaseJson(
  root: string,
  caso: string,
  filename: string,
  value: Record<string, unknown>,
): Promise<void> {
  const path = join(root, "fixtures", "reto-03", "solicitudes", caso, filename);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

before(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "sap-purchase-agent-"));
  await cp(join(workspaceRoot(), "fixtures"), join(testRoot, "fixtures"), {
    recursive: true,
  });
});

after(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

test("RC1–RC10 producen el resultado esperado en los seis fixtures", async () => {
  const normalized = await executeAgentTool(
    "oc_leer_paquete",
    { caso: "sol-001" },
    { directory: testRoot, sessionId: "test-normalized" },
  );
  const normalizedData = JSON.parse(normalized.result).data;
  assert.equal(normalizedData.aprobacion.aprobado, true);
  assert.equal(typeof normalizedData.aprobacion.texto, "string");
  assert.equal(normalizedData.solicitud.solicitud_id, "SOL-2026-001");
  const results = new Map(
    await Promise.all(
      ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"].map(
        async (caso) => [caso, (await evaluateCase(testRoot, caso)).validacion] as const,
      ),
    ),
  );

  assert.equal(results.get("sol-001")?.apta, true);
  assert.deepEqual(results.get("sol-001")?.bloqueos, []);
  assert.deepEqual(results.get("sol-001")?.confirmaciones, []);

  assert.ok(results.get("sol-002")?.bloqueos.some((item) => item.startsWith("RC1")));
  assert.ok(results.get("sol-003")?.bloqueos.some((item) => item.startsWith("RC2")));
  assert.ok(
    results
      .get("sol-004")
      ?.confirmaciones.some((item) => item.startsWith("[RC5_")),
  );
  assert.equal(results.get("sol-005")?.retroactiva, true);
  assert.ok(
    results
      .get("sol-005")
      ?.confirmaciones.some((item) => item.startsWith("[RC8_")),
  );
  assert.ok(
    results
      .get("sol-006")
      ?.confirmaciones.some((item) => item.startsWith("[RC6_")),
  );
});

test("sol-001 crea una orden y los reintentos devuelven el mismo número", async () => {
  const context = { directory: testRoot, sessionId: "test-sol-001" };
  const evidence = await executeAgentTool(
    "oc_generar_evidencia",
    { caso: "sol-001" },
    context,
  );
  assert.equal(evidence.ok, true);

  const build = await executeAgentTool(
    "oc_construir_payload",
    { caso: "sol-001" },
    context,
  );
  assert.equal(build.ok, true);

  const first = await executeAgentTool(
    "oc_crear",
    { caso: "sol-001" },
    { ...context, allowAutomaticCreateCase: "sol-001" },
  );
  assert.equal(first.ok, true);
  const firstData = JSON.parse(first.result).data as {
    numero_oc: string;
    idempotente: boolean;
  };
  assert.equal(firstData.numero_oc, "4500000001");
  assert.equal(firstData.idempotente, false);

  const retry = await executeAgentTool(
    "oc_crear",
    { caso: "sol-001" },
    { ...context, allowAutomaticCreateCase: "sol-001" },
  );
  assert.equal(retry.ok, true);
  const retryData = JSON.parse(retry.result).data as {
    numero_oc: string;
    idempotente: boolean;
  };
  assert.equal(retryData.numero_oc, firstData.numero_oc);
  assert.equal(retryData.idempotente, true);
});

test("sol-004 no se crea hasta que el servidor recibe confirmación humana", async () => {
  const context = { directory: testRoot, sessionId: "test-sol-004" };
  await executeAgentTool("oc_generar_evidencia", { caso: "sol-004" }, context);
  await executeAgentTool("oc_construir_payload", { caso: "sol-004" }, context);

  const denied = await executeAgentTool(
    "oc_crear",
    { caso: "sol-004", confirmado: true },
    { ...context, allowAutomaticCreateCase: "sol-004" },
  );
  assert.equal(denied.ok, false);
  assert.match(denied.result, /confirmación humana explícita/i);

  const confirmed = await executeAgentTool(
    "oc_crear",
    { caso: "sol-004" },
    { ...context, humanConfirmedCase: "sol-004" },
  );
  assert.equal(confirmed.ok, true);
  assert.equal(JSON.parse(confirmed.result).data.numero_oc, "4500000002");
});

test("RC3 bloquea montos que exceden el tope del aprobador", async () =>
  withIsolatedRoot(async (root) => {
    const request = await readCaseJson(root, "sol-001", "solicitud.json");
    request.valor_total = 100_000_000;
    await writeCaseJson(root, "sol-001", "solicitud.json", request);

    const result = (await evaluateCase(root, "sol-001")).validacion;
    assert.ok(result.bloqueos.some((item) => item.startsWith("RC3")));
  }));

test("RC2 acepta aprobación positiva y bloquea negaciones o lenguaje ambiguo", async () =>
  withIsolatedRoot(async (root) => {
    const approval = await readCaseJson(root, "sol-001", "aprobacion.json");
    assert.equal((await evaluateCase(root, "sol-001")).validacion.apta, true);
    for (const body of [
      "No aprobado. No autorizo esta compra.",
      "Aprobado. No autorizo esta compra.",
      "Aprobado si se ajusta el monto.",
      "¿Aprobado?",
      "Pendiente de aprobación.",
      "Aprobado para revisión.",
      "Aprobado probablemente.",
      "Aprobado, depende de confirmar el presupuesto.",
      "Confirmo recepción de la información.",
    ]) {
      await writeCaseJson(root, "sol-001", "aprobacion.json", { ...approval, cuerpo: body });
      const validation = (await evaluateCase(root, "sol-001")).validacion;
      assert.equal(validation.apta, false, body);
      assert.ok(validation.bloqueos.some((block) => block.startsWith("RC2")));
      const attempted = await executeAgentTool("oc_crear", { caso: "sol-001", confirmado: true },
        { directory: root, sessionId: "test-approval", humanConfirmedCase: "sol-001" });
      assert.equal(attempted.ok, false, body);
    }
  }));

test("RC6 valida el IVA derivado y un humano no puede autorizar un código inexistente", async () =>
  withIsolatedRoot(async (root) => {
    const valid = await evaluateCase(root, "sol-006");
    assert.equal(valid.validacion.derivados.indicador_iva, "C1");
    assert.ok(valid.validacion.confirmaciones.some((item) => item.includes("RC6_IVA_DERIVADO")));
    const path = join(root, "fixtures/reto-03/maestros/proveedores.json");
    const providers = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    const provider = providers.find((item) => item.codigo_sap === valid.proveedor?.codigo_sap);
    assert.ok(provider);
    provider.indicador_iva_default = "ZZ_INEXISTENTE";
    await writeFile(path, JSON.stringify(providers));
    const invalid = (await evaluateCase(root, "sol-006")).validacion;
    assert.equal(invalid.apta, false);
    assert.ok(invalid.bloqueos.some((block) => block.startsWith("RC6")));
    const attempted = await executeAgentTool("oc_crear", { caso: "sol-006", confirmado: true },
      { directory: root, sessionId: "test-derived-iva", humanConfirmedCase: "sol-006" });
    assert.equal(attempted.ok, false);
    await assert.rejects(readFile(join(root, "out/sap/ordenes.jsonl")));
  }));

test("RC4 bloquea subáreas ajenas y RC7 deriva condiciones del proveedor", async () =>
  withIsolatedRoot(async (root) => {
    const request = await readCaseJson(root, "sol-001", "solicitud.json");
    request.subarea = "Subárea inexistente";
    request.condiciones_pago = "";
    await writeCaseJson(root, "sol-001", "solicitud.json", request);

    const result = (await evaluateCase(root, "sol-001")).validacion;
    assert.ok(result.bloqueos.some((item) => item.startsWith("RC4")));
    assert.equal(result.derivados.condiciones_pago, "Z030");
    assert.ok(!result.bloqueos.some((item) => item.startsWith("RC7")));
  }));

test("RC5 pide confirmación cuando falta la cotización", async () =>
  withIsolatedRoot(async (root) => {
    await rm(
      join(
        root,
        "fixtures",
        "reto-03",
        "solicitudes",
        "sol-001",
        "cotizacion.txt",
      ),
    );

    const result = (await evaluateCase(root, "sol-001")).validacion;
    assert.ok(
      result.confirmaciones.some((item) =>
        item.startsWith("[RC5_COTIZACION_AUSENTE]"),
      ),
    );
  }));

test("RC6 bloquea indicadores IVA desconocidos", async () =>
  withIsolatedRoot(async (root) => {
    const request = await readCaseJson(root, "sol-001", "solicitud.json");
    request.indicador_iva = "CODIGO-DESCONOCIDO";
    await writeCaseJson(root, "sol-001", "solicitud.json", request);

    const result = (await evaluateCase(root, "sol-001")).validacion;
    assert.ok(result.bloqueos.some((item) => item.startsWith("RC6")));
  }));

test("RC9 pide confirmación para una aprobación anterior a la solicitud", async () =>
  withIsolatedRoot(async (root) => {
    const approval = await readCaseJson(root, "sol-001", "aprobacion.json");
    approval.fecha = "2026-08-19T10:00:00-05:00";
    await writeCaseJson(root, "sol-001", "aprobacion.json", approval);

    const result = (await evaluateCase(root, "sol-001")).validacion;
    assert.ok(
      result.confirmaciones.some((item) =>
        item.startsWith("[RC9_APROBACION_ANTERIOR]"),
      ),
    );
  }));

test("RC10 bloquea el total que no coincide con cantidad por precio", async () =>
  withIsolatedRoot(async (root) => {
    const request = await readCaseJson(root, "sol-001", "solicitud.json");
    request.valor_total = 11_400_002;
    await writeCaseJson(root, "sol-001", "solicitud.json", request);

    const result = (await evaluateCase(root, "sol-001")).validacion;
    assert.ok(result.bloqueos.some((item) => item.startsWith("RC10")));
  }));

test("el CSV de control conserva un solo encabezado y omite encabezados repetidos", async () =>
  withIsolatedRoot(async (root) => {
    const record = {
      solicitudId: "SOL-TEST",
      resultado: "pendiente",
      numeroOc: null,
      retroactiva: false,
      bloqueos: [],
      confirmaciones: ["Confirmación de prueba"],
      ts: "2026-10-29T00:00:00.000Z",
    };
    await Promise.all([
      appendControlRecord(root, record),
      appendControlRecord(root, { ...record, solicitudId: "SOL-TEST-2" }),
    ]);

    const path = join(root, "out", "control.csv");
    const content = await readFile(path, "utf8");
    const header = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts";
    assert.equal(content.split(/\r?\n/).filter((line) => line === header).length, 1);

    await appendFile(path, `${header}\n`, "utf8");
    const records = await readControlRecords(root);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((item) => item.solicitudId).sort(),
      ["SOL-TEST", "SOL-TEST-2"],
    );
  }));

test("HU1/HU6: adjuntos ausentes, JSON inválido, monto no numérico y ruta no permitida", async () =>
  withIsolatedRoot(async (root) => {
    const folder = join(root, "fixtures/reto-03/solicitudes/sol-001");
    const context = { directory: root, sessionId: "test-errors" };
    await rm(join(folder, "aprobacion.json"));
    const missing = await executeAgentTool("oc_leer_paquete", { caso: "sol-001" }, context);
    assert.equal(missing.ok, true);
    assert.equal(JSON.parse(missing.result).data.paquete.aprobacion, null);
    assert.ok(JSON.parse(missing.result).data.faltantes.length > 0);

    await writeFile(join(folder, "solicitud.json"), "{malformed", "utf8");
    const malformed = await executeAgentTool("oc_leer_paquete", { caso: "sol-001" }, context);
    assert.equal(malformed.ok, false);
    assert.equal(typeof JSON.parse(malformed.result).error, "string");

    const original = await readCaseJson(workspaceRoot(), "sol-001", "solicitud.json");
    original.valor_total = "no es numérico";
    await writeCaseJson(root, "sol-001", "solicitud.json", original);
    assert.equal((await executeAgentTool("oc_validar", { caso: "sol-001" }, context)).ok, false);
    assert.equal((await executeAgentTool("oc_leer_paquete", { caso: "../../etc" }, context)).ok, false);
  }));

test("no se informa éxito cuando el adaptador no puede guardar", async () =>
  withIsolatedRoot(async (root) => {
    const context = {
      directory: root,
      sessionId: "test-save-failure",
      allowAutomaticCreateCase: "sol-001",
    };
    await executeAgentTool("oc_generar_evidencia", { caso: "sol-001" }, context);
    await writeFile(join(root, "out/sap"), "Esta ruta no es un directorio", "utf8");
    const result = await executeAgentTool("oc_crear", { caso: "sol-001" }, context);
    assert.equal(result.ok, false);
    assert.equal(JSON.parse(result.result).data, undefined);
  }));

test("los valores enviados por el modelo no alteran el payload y una confirmación no supera bloqueos", async () =>
  withIsolatedRoot(async (root) => {
    const context = { directory: root, sessionId: "test-untrusted", allowAutomaticCreateCase: "sol-001" };
    await executeAgentTool("oc_generar_evidencia", { caso: "sol-001" }, context);
    const result = await executeAgentTool(
      "oc_crear",
      { caso: "sol-001", payload: { moneda: "USD", total: 1, proveedor: "inventado" } },
      context,
    );
    assert.equal(result.ok, true, result.result);
    const saved = JSON.parse((await readFile(join(root, "out/sap/ordenes.jsonl"), "utf8")).trim());
    assert.equal(saved.total, 11_400_000);
    assert.equal(saved.orden.moneda, "COP");
    assert.equal(saved.orden.proveedor.nit, "900555111");
    assert.equal(saved.orden.posiciones[0].precio_unitario, 95_000);

    const blocked = await executeAgentTool(
      "oc_crear",
      { caso: "sol-002", confirmado: true },
      { directory: root, sessionId: "test-blocked-confirmed", humanConfirmedCase: "sol-002" },
    );
    assert.equal(blocked.ok, false);
    assert.equal((await readFile(join(root, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n").length, 1);
  }));
