import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const apiPort = process.env.API_SERVER_PORT ?? "8080";
const webPort = process.env.WEB_PORT ?? "22663";
let stopping = false;
const children = [];

function start(name, args, extraEnv) {
  const child = spawn(command, args, {
    env: { ...process.env, ...extraEnv },
    stdio: ["inherit", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) process.stdout.write(`[${name}] ${line}\n`);
      }
    });
  }
  child.on("error", (error) => {
    process.stderr.write(`[${name}] ${error.message}\n`);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  children.push(child);
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1_500).unref();
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

start(
  "api",
  ["--filter", "@workspace/api-server", "run", "dev"],
  { NODE_ENV: "development", PORT: apiPort },
);
start(
  "web",
  ["--filter", "@workspace/sap-purchase-agent", "run", "dev"],
  {
    PORT: webPort,
    BASE_PATH: process.env.BASE_PATH ?? "/",
    API_SERVER_PORT: apiPort,
  },
);

process.stdout.write(
  `Desarrollo iniciado. Interfaz: http://localhost:${webPort} · API: http://localhost:${apiPort}/api\n`,
);
