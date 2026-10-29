import type { OrdenCompra } from "./types";

export interface SapAdapter {
  consultarProveedor(
    nit: string,
  ): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(
    solicitud_id: string,
  ): Promise<{ numero_oc: string } | null>;
}
