import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { caseDirectory } from "../lib/workspace-paths";
import { ProveedorSchema, type OrdenCompra, type Proveedor } from "./types";
import type { SapAdapter } from "./adapter";

const StoredOrderSchema = z.object({
  numero_oc: z.string(),
  fecha: z.string(),
  referencia: z.object({
    solicitud_id: z.string(),
  }),
  proveedor: z.object({
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  total: z.number().finite(),
  retroactiva: z.boolean(),
  orden: z.unknown(),
});

type StoredOrder = z.infer<typeof StoredOrderSchema>;

let writeChain: Promise<void> = Promise.resolve();

function baseNit(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length > 9 ? digits.slice(0, 9) : digits;
}

async function readProviders(root: string): Promise<Proveedor[]> {
  const raw = await readFile(
    join(root, "fixtures", "reto-03", "maestros", "proveedores.json"),
    "utf8",
  );
  const parsed: unknown = JSON.parse(raw);
  return z.array(ProveedorSchema).parse(parsed);
}

async function readStoredOrders(root: string): Promise<StoredOrder[]> {
  try {
    const raw = await readFile(join(root, "out", "sap", "ordenes.jsonl"), "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const item: unknown = JSON.parse(line);
          const parsed = StoredOrderSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export class MockSapAdapter implements SapAdapter {
  constructor(private readonly root: string) {}

  async consultarProveedor(
    nit: string,
  ): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const proveedores = await readProviders(this.root);
    const proveedor = proveedores.find(
      (item) => baseNit(item.nit) === baseNit(nit),
    );
    return proveedor
      ? { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo }
      : null;
  }

  async buscarOrdenPorReferencia(
    solicitud_id: string,
  ): Promise<{ numero_oc: string } | null> {
    const orders = await readStoredOrders(this.root);
    const order = orders.find(
      (item) => item.referencia.solicitud_id === solicitud_id,
    );
    return order ? { numero_oc: order.numero_oc } : null;
  }

  async crearOrden(
    orden: OrdenCompra,
  ): Promise<{ numero_oc: string; fecha: string }> {
    const operation = async (): Promise<{ numero_oc: string; fecha: string }> => {
      const existing = await this.buscarOrdenPorReferencia(
        orden.referencia.solicitud_id,
      );
      if (existing) {
        const saved = (await readStoredOrders(this.root)).find(
          (item) => item.numero_oc === existing.numero_oc,
        );
        return {
          numero_oc: existing.numero_oc,
          fecha: saved?.fecha ?? new Date().toISOString(),
        };
      }

      const current = await readStoredOrders(this.root);
      const highest = current.reduce((maximum, item) => {
        const value = Number(item.numero_oc);
        return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
      }, 4500000000);
      const numero_oc = String(highest + 1);
      const fecha = new Date().toISOString();
      const total = orden.posiciones.reduce(
        (sum, position) => sum + position.cantidad * position.precio_unitario,
        0,
      );
      const retroactiva = orden.excepciones.some(
        (exception) => exception.codigo === "RC8_RETROACTIVA",
      );
      const stored: StoredOrder = {
        numero_oc,
        fecha,
        referencia: orden.referencia,
        proveedor: { nombre: orden.proveedor.nombre },
        moneda: orden.moneda,
        total,
        retroactiva,
        orden,
      };
      const directory = join(this.root, "out", "sap");
      await mkdir(directory, { recursive: true });
      await appendFile(
        join(directory, "ordenes.jsonl"),
        `${JSON.stringify(stored)}\n`,
        "utf8",
      );

      const verified = await this.buscarOrdenPorReferencia(
        orden.referencia.solicitud_id,
      );
      if (!verified || verified.numero_oc !== numero_oc) {
        throw new Error("SAP simulado no confirmó el guardado de la orden.");
      }

      return { numero_oc, fecha };
    };

    const next = writeChain.then(operation, operation);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async listarOrdenes(): Promise<StoredOrder[]> {
    return readStoredOrders(this.root);
  }
}

export function readCaseFolder(root: string, caso: string): string {
  return caseDirectory(root, caso);
}
