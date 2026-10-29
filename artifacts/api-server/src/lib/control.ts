import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ControlRecord = {
  solicitudId: string;
  resultado: string;
  numeroOc: string | null;
  retroactiva: boolean;
  bloqueos: string[];
  confirmaciones: string[];
  ts: string;
};

const HEADER =
  "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n";

let writeChain: Promise<void> = Promise.resolve();

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function toCsvRow(record: ControlRecord): string {
  return [
    record.solicitudId,
    record.resultado,
    record.numeroOc ?? "",
    String(record.retroactiva),
    JSON.stringify(record.bloqueos),
    JSON.stringify(record.confirmaciones),
    record.ts,
  ]
    .map(csvField)
    .join(",")
    .concat("\n");
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  fields.push(value);
  return fields;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export async function readControlRecords(root: string): Promise<ControlRecord[]> {
  const path = join(root, "out", "control.csv");
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }

  return content
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.length > 0)
    .map((line) => splitCsvLine(line))
    .filter((fields) => fields.length >= 7)
    .map((fields) => ({
      solicitudId: fields[0],
      resultado: fields[1],
      numeroOc: fields[2] || null,
      retroactiva: fields[3] === "true",
      bloqueos: parseJsonArray(fields[4]),
      confirmaciones: parseJsonArray(fields[5]),
      ts: fields[6],
    }));
}

export async function appendControlRecord(
  root: string,
  record: ControlRecord,
): Promise<void> {
  const operation = async (): Promise<void> => {
    const directory = join(root, "out");
    const path = join(directory, "control.csv");
    await mkdir(directory, { recursive: true });

    try {
      await readFile(path);
    } catch {
      await writeFile(path, HEADER, "utf8");
    }

    await appendFile(path, toCsvRow(record), "utf8");
  };

  const next = writeChain.then(operation, operation);
  writeChain = next.catch(() => undefined);
  await next;
}

export async function recordValidationAttempt(
  root: string,
  solicitudId: string,
  validacion: {
    apta: boolean;
    bloqueos: string[];
    confirmaciones: string[];
    retroactiva: boolean;
  },
): Promise<void> {
  if (validacion.bloqueos.length === 0 && validacion.confirmaciones.length === 0) {
    return;
  }

  await appendControlRecord(root, {
    solicitudId,
    resultado: validacion.bloqueos.length > 0 ? "bloqueada" : "pendiente",
    numeroOc: null,
    retroactiva: validacion.retroactiva,
    bloqueos: validacion.bloqueos,
    confirmaciones: validacion.confirmaciones,
    ts: new Date().toISOString(),
  });
}
