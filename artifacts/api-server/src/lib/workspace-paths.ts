import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const CASE_IDS = new Set([
  "sol-001",
  "sol-002",
  "sol-003",
  "sol-004",
  "sol-005",
  "sol-006",
]);

export function workspaceRoot(): string {
  const workingDirectory = process.cwd();
  const candidates = [
    workingDirectory,
    resolve(workingDirectory, "../.."),
  ];
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, "fixtures", "reto-03")),
  );

  if (!root) {
    throw new Error(
      "No se encontró fixtures/reto-03 desde el directorio de ejecución.",
    );
  }

  return root;
}

export function caseDirectory(root: string, caso: string): string {
  if (!CASE_IDS.has(caso)) {
    throw new Error("Caso no válido. Usa uno de sol-001 a sol-006.");
  }

  return join(root, "fixtures", "reto-03", "solicitudes", caso);
}

export function knownCaseIds(): string[] {
  return [...CASE_IDS];
}

export function outputDirectory(root: string): string {
  return join(root, "out");
}
