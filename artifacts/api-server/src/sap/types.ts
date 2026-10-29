import { z } from "zod";

export const SolicitudSchema = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().nullable().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number().finite(),
  valor_unitario: z.number().finite(),
  valor_total: z.number().finite(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().nullable().optional(),
  condiciones_pago: z.string().nullable().optional(),
  fecha_solicitud: z.string(),
});

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()).default([]),
});

export const CotizacionSchema = z.object({
  referencia: z.string().nullable(),
  proveedor: z.string(),
  nit: z.string().nullable(),
  total: z.number().finite(),
  moneda: z.enum(["COP", "USD"]),
  validez_hasta: z.string().nullable(),
  texto: z.string(),
});

export const AprobacionSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
});

export const FacturaSchema = z.object({
  numero: z.string(),
  fecha: z.string(),
  total: z.number().finite(),
});

export const PaqueteSchema = z.object({
  correo: CorreoSchema,
  solicitud: SolicitudSchema,
  cotizacion: CotizacionSchema.nullable(),
  aprobacion: AprobacionSchema.nullable(),
  factura: FacturaSchema.nullable(),
  faltantes: z.array(z.string()).default([]),
});

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(
    z.object({
      email: z.string(),
      nombre: z.string(),
      tope: z.number().finite(),
    }),
  ),
});

export const IndicadorIvaSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number().finite(),
});

export const CondicionPagoSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  dias: z.number().int(),
});

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string(),
  }),
  posiciones: z.array(
    z.object({
      numero: z.number().int(),
      descripcion: z.string().max(40),
      cantidad: z.number().finite(),
      unidad: z.enum(["UN", "H", "MES"]),
      precio_unitario: z.number().finite(),
      centro_costo: z.string(),
      subarea: z.string(),
      indicador_iva: z.string(),
    }),
  ),
  excepciones: z.array(
    z.object({
      codigo: z.string(),
      detalle: z.string(),
      confirmado_por: z.string().nullable(),
    }),
  ),
});

export const ValidacionSchema = z.object({
  apta: z.boolean(),
  bloqueos: z.array(z.string()),
  confirmaciones: z.array(z.string()),
  derivados: z.object({
    indicador_iva: z.string().optional(),
    condiciones_pago: z.string().optional(),
    unidad: z.enum(["UN", "H", "MES"]).optional(),
  }),
  retroactiva: z.boolean(),
});

export type Solicitud = z.infer<typeof SolicitudSchema>;
export type Correo = z.infer<typeof CorreoSchema>;
export type Cotizacion = z.infer<typeof CotizacionSchema>;
export type Aprobacion = z.infer<typeof AprobacionSchema>;
export type Factura = z.infer<typeof FacturaSchema>;
export type Paquete = z.infer<typeof PaqueteSchema>;
export type Proveedor = z.infer<typeof ProveedorSchema>;
export type CentroCosto = z.infer<typeof CentroCostoSchema>;
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>;
export type CondicionPago = z.infer<typeof CondicionPagoSchema>;
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;
export type Validacion = z.infer<typeof ValidacionSchema>;

export type Evaluacion = {
  paquete: Paquete;
  validacion: Validacion;
  proveedor: Proveedor | null;
  aprobador: CentroCosto["aprobadores"][number] | null;
};
