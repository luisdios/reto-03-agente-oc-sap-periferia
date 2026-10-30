import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import app from "../artifacts/api-server/src/app";
import { readControlRecords } from "../artifacts/api-server/src/lib/control";
import { workspaceRoot } from "../artifacts/api-server/src/lib/workspace-paths";

const sourceRoot = workspaceRoot();
const initialCwd = process.cwd();
let root = "";
let server: Server;
let baseUrl = "";

type ChatResult = {
  sessionId: string;
  reply: string;
  needsConfirmation: boolean;
  pendingCase: string | null;
  toolCalls: Array<{ name: string; args: string; result: string; ok: boolean }>;
};
type SavedOrder = {
  numero_oc: string;
  retroactiva: boolean;
  referencia: { solicitud_id: string };
};

beforeEach(async () => {
  assert.equal(Boolean(process.env.GEMINI_API_KEY), false, "HTTP tests must run without a model key");
  root = await mkdtemp(join(tmpdir(), "sap-agent-http-"));
  await cp(join(sourceRoot, "fixtures"), join(root, "fixtures"), { recursive: true });
  await cp(join(sourceRoot, "agent"), join(root, "agent"), { recursive: true });
  const parent = join(root, "artifacts", "api-server", "src");
  await mkdir(parent, { recursive: true });
  await cp(join(sourceRoot, "artifacts/api-server/src/knowledge"), join(parent, "knowledge"), { recursive: true });
  process.chdir(root);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
  process.chdir(initialCwd);
  if (root) await rm(root, { recursive: true, force: true });
});

async function message(sessionId: string, text: string): Promise<ChatResult> {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message: text }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as ChatResult;
  assert.equal(result.sessionId, sessionId);
  return result;
}

async function orders(): Promise<SavedOrder[]> {
  try {
    return (await readFile(join(root, "out/sap/ordenes.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SavedOrder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("HTTP: seis casos, confirmaciones ambiguas, cancelación, idempotencia, historial y log", async () => {
  const pending = await message("http-sol004", "Procesa sol-004. Muéstrame la OC y no la crees hasta que confirme.");
  assert.equal(pending.needsConfirmation, true);
  assert.match(pending.reply, /\| Campo SAP \|/);
  assert.match(pending.reply, /25000000|25\.000\.000/);
  assert.match(pending.reply, /26500000/);
  assert.match(pending.reply, /¿Confirmas explícitamente/);
  assert.equal((await orders()).length, 0);
  assert.ok(pending.toolCalls.every((call) => call.name && call.args && call.result));

  for (const text of [
    "¿Qué pasa si confirmo?", "Tal vez confirmo luego", "Confirmo si se corrige el monto",
    "Confirmo sol-005", "Confirmo recepción de la información", "Confirmo cancelar",
    "Sí", "OK", "Confirmo", "Autorizo la revisión",
    "Confirmo crear la orden sol-005 y acepto las excepciones mostradas.",
  ]) {
    assert.equal((await message("http-sol004", text)).needsConfirmation, true);
    assert.equal((await orders()).length, 0);
  }
  const quotePath = join(root, "fixtures/reto-03/solicitudes/sol-004/cotizacion.txt");
  const quote = await readFile(quotePath, "utf8");
  const changedQuote = quote.replace("26.500.000", "27.500.000");
  assert.notEqual(changedQuote, quote);
  await writeFile(quotePath, changedQuote);
  const stale = await message("http-sol004", "Confirmo crear la orden sol-004 y acepto las excepciones mostradas.");
  assert.match(stale.reply, /cambiaron/);
  assert.equal(stale.needsConfirmation, true);
  assert.equal((await orders()).length, 0);
  await writeFile(quotePath, quote);
  assert.equal((await message("http-sol004", "Caso seleccionado: sol-004 (SOL-2026-004). Confirmo crear la orden sol-004 y acepto las excepciones mostradas.")).needsConfirmation, false);
  assert.equal((await orders()).length, 1);

  await message("http-clean-hold", "Procesa sol-001 pero no la crees.");
  assert.equal((await orders()).length, 1);
  assert.ok((await readControlRecords(root)).some((row) =>
    row.solicitudId === "SOL-2026-001" && row.resultado === "pendiente",
  ));
  assert.match((await message("http-clean-hold", "Cancelo")).reply, /cancelada/);
  await message("http-clean-auto", "Procesa sol-001");
  const first = (await orders()).find((order) => order.referencia.solicitud_id === "SOL-2026-001");
  assert.ok(first);
  await message("http-clean-retry", "Procesa sol-001");
  assert.equal((await orders()).filter((order) => order.referencia.solicitud_id === "SOL-2026-001").length, 1);
  assert.equal((await orders()).find((order) => order.referencia.solicitud_id === "SOL-2026-001")?.numero_oc, first.numero_oc);

  for (const caso of ["sol-005", "sol-006"]) {
    const session = `http-${caso}`;
    assert.equal((await message(session, `Procesa ${caso}`)).needsConfirmation, true);
    const count = (await orders()).length;
    await message(session, "No");
    assert.equal((await orders()).length, count);
    const retry = `${session}-confirmed`;
    await message(retry, `Procesa ${caso}`);
    await message(retry, `Confirmo crear la orden ${caso} y acepto las excepciones mostradas.`);
    assert.equal((await orders()).length, count + 1);
  }
  const retroactive = (await orders()).find((order) => order.referencia.solicitud_id === "SOL-2026-005");
  assert.equal(retroactive?.retroactiva, true);
  assert.ok((await readControlRecords(root)).some((row) =>
    row.solicitudId === "SOL-2026-005" && row.resultado === "creada" && row.retroactiva,
  ));

  const count = (await orders()).length;
  for (const caso of ["sol-002", "sol-003"]) {
    const blocked = await message(`http-${caso}`, `Procesa ${caso}`);
    assert.equal(blocked.needsConfirmation, false);
    assert.match(blocked.reply, /bloque/i);
    await message(`http-${caso}`, "Confirmo");
    assert.equal((await orders()).length, count);
  }
  const history = await (await fetch(`${baseUrl}/sessions/http-sol004`)).json() as {
    messages: Array<{ toolCalls: ChatResult["toolCalls"] }>;
  };
  const calls = history.messages.flatMap((entry) => entry.toolCalls);
  const logs = (await readFile(join(root, "out/log.jsonl"), "utf8")).split("\n")
    .filter(Boolean).map((line) => JSON.parse(line) as { sessionId: string; type: string });
  assert.equal(logs.filter((row) => row.sessionId === "http-sol004" && row.type === "tool_call").length, calls.length);
});

test("Sesiones A: una solicitud explícita de otro caso descarta el pendiente y procesa el nuevo", async () => {
  const session = "switch-case-A";
  const count = (await orders()).length;
  const pending = await message(session, "Procesa sol-001 pero no la crees.");
  assert.equal(pending.pendingCase, "sol-001");
  const switched = await message(session, "Procesa sol-002");
  assert.equal(switched.pendingCase, null);
  assert.equal(switched.needsConfirmation, false);
  assert.match(switched.reply, /bloque/i);
  assert.ok(switched.toolCalls.some(call =>
    call.name === "oc_validar" && JSON.parse(call.args).caso === "sol-002",
  ));
  assert.equal((await orders()).length, count);
  const history = await (await fetch(`${baseUrl}/sessions/${session}`)).json() as {
    sessionId: string; pendingCase: string | null; messages: Array<{ content: string }>;
  };
  assert.equal(history.sessionId, session);
  assert.equal(history.pendingCase, null);
  assert.ok(history.messages.some(entry => entry.content.includes("Procesa sol-001")));
  assert.ok(history.messages.some(entry => entry.content === "Procesa sol-002"));
});

test("Sesiones B: una respuesta sin otro caso conserva la confirmación pendiente", async () => {
  const session = "switch-case-B";
  const count = (await orders()).length;
  await message(session, "Procesa sol-001 pero no la crees.");
  const response = await message(session, "Muéstrame otra vez las validaciones");
  assert.equal(response.pendingCase, "sol-001");
  assert.equal(response.needsConfirmation, true);
  assert.equal(response.toolCalls.length, 0);
  assert.equal((await orders()).length, count);
});

test("Sesiones C: confirmar otro caso no descarta el pendiente ni crea órdenes", async () => {
  const count = (await orders()).length;
  for (const [session, pendingCase, otherCase] of [
    ["switch-case-C", "sol-001", "sol-002"],
    ["switch-case-C-clean-target", "sol-004", "sol-001"],
  ]) {
    await message(session, `Procesa ${pendingCase} pero no la crees.`);
    const response = await message(session,
      `Confirmo crear la orden ${otherCase} y acepto las excepciones mostradas.`);
    assert.equal(response.pendingCase, pendingCase);
    assert.equal(response.needsConfirmation, true);
    assert.equal(response.toolCalls.length, 0);
    assert.equal((await orders()).length, count);
  }
});

test("Sesiones UI: el caso escrito prevalece sobre el prefijo y un caso limpio no pide confirmación", async () => {
  const session = "switch-case-ui";
  await message(session, "Procesa sol-004");
  const switched = await message(session,
    "Caso seleccionado: sol-004 (SOL-2026-004). Procesa sol-002");
  assert.equal(switched.pendingCase, null);
  assert.ok(switched.toolCalls.some(call =>
    call.name === "oc_validar" && JSON.parse(call.args).caso === "sol-002",
  ));
  await message(session, "Procesa sol-004");
  const automatic = await message(session,
    "Caso seleccionado: sol-001 (SOL-2026-001). Procesa");
  assert.equal(automatic.needsConfirmation, false);
  assert.equal(automatic.pendingCase, null);
  assert.ok(automatic.toolCalls.some(call => call.name === "oc_crear" && call.ok));
  const beforeRetry = await orders();
  assert.equal(beforeRetry.length, 1);
  assert.equal(beforeRetry[0].referencia.solicitud_id, "SOL-2026-001");
  const retry = await message(session, "Procesa sol-001");
  assert.equal(retry.needsConfirmation, false);
  assert.equal((await orders()).length, beforeRetry.length);
});
