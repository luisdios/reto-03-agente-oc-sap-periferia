import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { executeAgentTool, evaluateCase } from "../artifacts/api-server/src/tools/oc";
import { workspaceRoot } from "../artifacts/api-server/src/lib/workspace-paths";

let testRoot = "";

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
