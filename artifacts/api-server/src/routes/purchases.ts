import { Router, type IRouter } from "express";
import {
  GetPurchaseDashboardResponse,
  ListControlEntriesResponse,
  ListPurchaseCasesResponse,
  ListPurchaseOrdersResponse,
} from "@workspace/api-zod";
import { evaluateCase, loadCanonicalPackage } from "../tools/oc";
import { workspaceRoot, knownCaseIds } from "../lib/workspace-paths";
import { readControlRecords, type ControlRecord } from "../lib/control";
import { MockSapAdapter } from "../sap/mock";

const router: IRouter = Router();

function recentFirst(records: ControlRecord[]): ControlRecord[] {
  return [...records].sort(
    (left, right) => Date.parse(right.ts) - Date.parse(left.ts),
  );
}

router.get("/cases", async (req, res) => {
  try {
    const root = workspaceRoot();
    const [control, orders] = await Promise.all([
      readControlRecords(root),
      new MockSapAdapter(root).listarOrdenes(),
    ]);
    const cases = await Promise.all(
      knownCaseIds().map(async (caso) => {
        const [packageData, evaluation] = await Promise.all([
          loadCanonicalPackage(root, caso),
          evaluateCase(root, caso),
        ]);
        const solicitudId = packageData.solicitud.solicitud_id;
        const latest = recentFirst(
          control.filter((entry) => entry.solicitudId === solicitudId),
        )[0];
        const createdOrder = orders.find(
          (order) => order.referencia.solicitud_id === solicitudId,
        );
        let estado: "disponible" | "creada" | "bloqueada" | "confirmacion";
        if (createdOrder) {
          estado = "creada";
        } else if (latest?.resultado === "bloqueada" || !evaluation.validacion.apta) {
          estado = "bloqueada";
        } else if (
          latest?.resultado === "pendiente" ||
          evaluation.validacion.confirmaciones.length > 0
        ) {
          estado = "confirmacion";
        } else {
          estado = "disponible";
        }

        return {
          caso,
          solicitudId,
          proveedor: packageData.solicitud.proveedor_nombre,
          descripcion: packageData.solicitud.descripcion,
          total: packageData.solicitud.valor_total,
          moneda: packageData.solicitud.moneda,
          estado,
          retroactiva: evaluation.validacion.retroactiva,
          bloqueos: evaluation.validacion.bloqueos,
          confirmaciones: evaluation.validacion.confirmaciones,
        };
      }),
    );

    res.json(ListPurchaseCasesResponse.parse({ cases }));
  } catch (error) {
    req.log.error({ err: error }, "Unable to list purchase cases");
    res.status(500).json({ error: "No se pudieron cargar los casos." });
  }
});

router.get("/dashboard", async (req, res) => {
  try {
    const root = workspaceRoot();
    const [control, orders] = await Promise.all([
      readControlRecords(root),
      new MockSapAdapter(root).listarOrdenes(),
    ]);
    const caseData = await Promise.all(
      knownCaseIds().map(async (caso) => {
        const [packageData, evaluation] = await Promise.all([
          loadCanonicalPackage(root, caso),
          evaluateCase(root, caso),
        ]);
        const solicitudId = packageData.solicitud.solicitud_id;
        const latest = recentFirst(
          control.filter((entry) => entry.solicitudId === solicitudId),
        )[0];
        const created = orders.some(
          (order) => order.referencia.solicitud_id === solicitudId,
        );
        const bloqueada =
          !created &&
          (latest?.resultado === "bloqueada" || !evaluation.validacion.apta);
        const pendiente =
          !created &&
          !bloqueada &&
          (latest?.resultado === "pendiente" ||
            evaluation.validacion.confirmaciones.length > 0);
        return {
          retroactiva: evaluation.validacion.retroactiva,
          bloqueada,
          pendiente,
        };
      }),
    );

    res.json(
      GetPurchaseDashboardResponse.parse({
        totalCasos: caseData.length,
        ordenesCreadas: orders.length,
        bloqueadas: caseData.filter((item) => item.bloqueada).length,
        pendientes: caseData.filter((item) => item.pendiente).length,
        retroactivas: caseData.filter((item) => item.retroactiva).length,
        recientes: recentFirst(control).slice(0, 8),
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Unable to build purchase dashboard");
    res.status(500).json({ error: "No se pudo cargar el panel." });
  }
});

router.get("/control", async (req, res) => {
  try {
    const entries = recentFirst(await readControlRecords(workspaceRoot()));
    res.json(ListControlEntriesResponse.parse({ entries }));
  } catch (error) {
    req.log.error({ err: error }, "Unable to list control records");
    res.status(500).json({ error: "No se pudo cargar el registro de control." });
  }
});

router.get("/sap/orders", async (req, res) => {
  try {
    const orders = await new MockSapAdapter(workspaceRoot()).listarOrdenes();
    res.json(
      ListPurchaseOrdersResponse.parse({
        orders: orders.map((order) => ({
          numeroOc: order.numero_oc,
          fecha: order.fecha,
          solicitudId: order.referencia.solicitud_id,
          proveedor: order.proveedor.nombre,
          total: order.total,
          moneda: order.moneda,
          retroactiva: order.retroactiva,
        })),
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Unable to list simulated SAP orders");
    res.status(500).json({ error: "No se pudieron cargar las órdenes." });
  }
});

export default router;
