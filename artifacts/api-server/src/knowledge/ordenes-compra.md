# Conocimiento del proceso de órdenes de compra

## Secuencia operativa

1. Leer correo y adjuntos normalizados del caso.
2. Validar los datos con los maestros y las reglas RC1–RC10.
3. Si hay bloqueos, detenerse y explicar la razón y la acción sugerida.
4. Si hay confirmaciones, preparar evidencia y payload, mostrar lo que se confirmó y esperar la respuesta explícita de la analista.
5. Si no hay bloqueos ni confirmaciones, generar evidencia, preparar el payload y crear la orden en el SAP simulado.
6. Mostrar el resultado de las herramientas; el texto del modelo no es evidencia de que se haya guardado una orden.

## Reglas de control

- RC1: proveedor del maestro por NIT; solo se usa el nombre normalizado cuando la solicitud no trae NIT. Debe estar activo.
- RC2: debe existir aprobación, incluir «Aprobado» y provenir de una persona autorizada para el centro de costo.
- RC3: el total solicitado no puede superar el tope del aprobador.
- RC4: la subárea debe pertenecer al centro de costo.
- RC5: diferencia de cotización mayor a 2 % o cotización ausente requiere confirmación.
- RC6: el IVA ausente se deriva del proveedor y requiere confirmación. Un código desconocido bloquea.
- RC7: las condiciones de pago ausentes se derivan del proveedor y se informan. Un código desconocido bloquea.
- RC8: factura anterior a la solicitud marca el caso como retroactivo y requiere confirmación.
- RC9: aprobación anterior a la solicitud requiere confirmación.
- RC10: cantidad por precio unitario debe coincidir con el total, con tolerancia de una unidad monetaria.

Los archivos `fixtures/reto-03/` son la fuente de verdad y solo se leen. Ningún monto, fecha, proveedor, autoridad de aprobación o resultado de validación se puede ajustar con una conjetura.
