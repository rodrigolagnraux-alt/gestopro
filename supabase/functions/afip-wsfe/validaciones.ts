/**
 * Chequeo de Consumidor Final ANTES de gastar una llamada a ARCA: si el
 * receptor es Consumidor Final sin identificar (DocTipo 99) y el importe
 * supera el tope vigente (facturacion_parametros_vigentes), hay que pedir
 * identificación en vez de intentar el comprobante — ARCA lo rechazaría
 * igual, pero con un error mucho menos claro para el usuario final.
 */
export function validarTopeConsumidorFinal(docTipo: number, importeTotal: number, topeVigente: number): string | null {
  if (docTipo === 99 && importeTotal > topeVigente) {
    return `El importe ($${importeTotal.toLocaleString('es-AR')}) supera el tope de Consumidor Final sin identificar ($${topeVigente.toLocaleString('es-AR')}). Identificá al receptor (CUIT o DNI) para poder emitir el comprobante.`;
  }
  return null;
}

const TIPOS_FACTURA = [1, 6, 11] as const; // A, B, C
const MAPA_NOTA_CREDITO: Record<number, number> = { 1: 3, 6: 8, 11: 13 };

export function validarTipoComprobante(tipo: number): string | null {
  if (!TIPOS_FACTURA.includes(tipo as any)) {
    return `tipo_comprobante inválido: ${tipo}. Debe ser 1 (A), 6 (B) o 11 (C).`;
  }
  return null;
}

export function tipoNotaCreditoPara(tipoFactura: number): number {
  const tipo = MAPA_NOTA_CREDITO[tipoFactura];
  if (!tipo) throw new Error(`No hay tipo de Nota de Crédito mapeado para tipo_comprobante ${tipoFactura}`);
  return tipo;
}
