import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { workspaceRoot } from "../artifacts/api-server/src/lib/workspace-paths";

async function outputSnapshot(directory: string, base = directory): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) Object.assign(result, await outputSnapshot(path, base));
    else {
      const info = await stat(path);
      result[relative(base, path)] = `${info.mtimeMs}:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
    }
  }
  return result;
}

test("pnpm run demo: funciona sin clave en copia limpia y rechaza out existente sin modificarlo", async () => {
  const source = workspaceRoot();
  const root = await mkdtemp(join(tmpdir(), "sap-demo-regression-"));
  try {
    await mkdir(join(root, "artifacts/api-server"), { recursive: true });
    for (const file of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json", "demo.ts"]) {
      await cp(join(source, file), join(root, file));
    }
    for (const file of ["package.json", "tsconfig.json", "src"]) {
      await cp(join(source, "artifacts/api-server", file), join(root, "artifacts/api-server", file), { recursive: true });
    }
    await cp(join(source, "fixtures"), join(root, "fixtures"), { recursive: true });
    await symlink(join(source, "node_modules"), join(root, "node_modules"), "dir");
    await symlink(join(source, "artifacts/api-server/node_modules"), join(root, "artifacts/api-server/node_modules"), "dir");
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;
    delete env.SESSION_SECRET;
    const run = () => spawnSync("pnpm", ["run", "demo"], { cwd: root, env, encoding: "utf8", timeout: 90_000 });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const events = first.stdout.split("\n").filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events.length, 8);
    assert.equal(events[0].numero_oc, "4500000001");
    assert.equal(events[1].idempotente, true);
    for (const caso of ["sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]) {
      assert.equal(events.find((item) => item.caso === caso)?.numero_oc, null, caso);
    }
    assert.match(first.stdout, /Confirmación explícita simulada/);
    assert.equal(events.find((item) => String(item.caso).includes("tras confirmación"))?.numero_oc, "4500000002");
    assert.equal(events.find((item) => item.caso === "sol-005")?.retroactiva, true);
    const orders = (await readFile(join(root, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n");
    assert.equal(orders.length, 2);
    const before = await outputSnapshot(join(root, "out"));
    const second = run();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /out\/ ya existe/);
    assert.deepEqual(await outputSnapshot(join(root, "out")), before);
    console.log("Demo aislada: pnpm run demo = 0; repetición protegida = 1; 2 OC; salida intacta; sin clave.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
