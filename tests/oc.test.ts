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
    { caso: "sol-004" },
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
