import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MockSapAdapter } from "../artifacts/api-server/src/sap/mock";
import { OrdenCompraSchema } from "../artifacts/api-server/src/sap/types";
import { executeAgentTool } from "../artifacts/api-server/src/tools/oc";
import { workspaceRoot } from "../artifacts/api-server/src/lib/workspace-paths";

test("SAP: solo ENOENT significa historial vacío; corrupción o lectura fallida impiden crear", async () => {
  const root = await mkdtemp(join(tmpdir(), "sap-storage-regression-"));
  try {
    await cp(join(workspaceRoot(), "fixtures"), join(root, "fixtures"), { recursive: true });
    const adapter = new MockSapAdapter(root);
    assert.deepEqual(await adapter.listarOrdenes(), []);
    const context = { directory: root, sessionId: "storage-regression", allowAutomaticCreateCase: "sol-001" };
    await executeAgentTool("oc_generar_evidencia", { caso: "sol-001" }, context);
    const built = await executeAgentTool("oc_construir_payload", { caso: "sol-001" }, context);
    assert.equal(built.ok, true);
    const payload = OrdenCompraSchema.parse(JSON.parse(built.result).data.payload);
    await adapter.crearOrden(payload);
    const path = join(root, "out/sap/ordenes.jsonl");
    const validLine = await readFile(path, "utf8");
    for (const content of [
      "{corrupt-json}\n",
      "{}\n",
      JSON.stringify({ ...JSON.parse(validLine), numero_oc: "999999999999999999999" }) + "\n",
      validLine + "{corrupt-tail}\n",
      validLine + validLine,
    ]) {
      await writeFile(path, content);
      const before = await stat(path);
      await assert.rejects(adapter.buscarOrdenPorReferencia("SOL-2026-001"), /Historial SAP/);
      await assert.rejects(adapter.crearOrden(payload), /Historial SAP/);
      const attempt = await executeAgentTool("oc_crear", { caso: "sol-001" }, context);
      assert.equal(attempt.ok, false);
      assert.match(JSON.parse(attempt.result).error, /Historial SAP/);
      assert.equal(await readFile(path, "utf8"), content);
      assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    }
    await rm(path);
    await mkdir(path);
    await assert.rejects(adapter.listarOrdenes(), /No se pudo leer el historial SAP/);
    const unreadable = await executeAgentTool("oc_crear", { caso: "sol-001" }, context);
    assert.equal(unreadable.ok, false);
    assert.ok((await stat(path)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
