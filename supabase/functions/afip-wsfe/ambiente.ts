// Switch homologación/producción. AFIP_ENV es un secret de Edge Function que
// el usuario tiene que cargar a mano (no hay tool de MCP para secrets) — el
// default es SIEMPRE homologación, para que la ausencia del secret nunca
// termine apuntando a producción por accidente.
export type Ambiente = 'homologacion' | 'produccion';

export function ambienteActual(): Ambiente {
  const raw = (Deno.env.get('AFIP_ENV') ?? 'homologacion').trim().toLowerCase();
  return raw === 'produccion' ? 'produccion' : 'homologacion';
}

/**
 * Doble traba de seguridad: el negocio SOLO factura en producción si el
 * secret global AFIP_ENV dice producción *y* su propia facturacion_config
 * también dice producción — cualquiera de los dos en homologación (o en
 * cualquier otro valor, incluido null/undefined) fuerza homologación.
 * El secret global es el interruptor maestro (lo administra quien tiene
 * acceso a los secrets del proyecto); el valor por negocio solo puede
 * bajar el nivel, nunca subirlo por encima de lo que el secret permite.
 */
export function ambienteEfectivo(ambienteGlobal: Ambiente, ambienteNegocio: string | null | undefined): Ambiente {
  return ambienteGlobal === 'produccion' && ambienteNegocio === 'produccion' ? 'produccion' : 'homologacion';
}

export function urlWsaa(ambiente: Ambiente): string {
  return ambiente === 'produccion'
    ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
    : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
}

export function urlWsfe(ambiente: Ambiente): string {
  return ambiente === 'produccion'
    ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
    : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';
}
