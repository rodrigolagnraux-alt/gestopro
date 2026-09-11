// Router HTTP de la Edge Function afip-wsfe. Acciones por body.accion:
//   - "diagnostico": self-test de firma CMS, no toca ARCA ni credenciales reales.
//   - "guardar_credenciales": guarda certificado_pem/clave_privada_pem del negocio.
//   - "emitir_factura": FECompUltimoAutorizado + FECAESolicitar para Factura A/B/C.
//   - "emitir_nota_credito": ídem, tipo espejo, ligada a la factura original.
//
// verify_jwt=true (seteado en el deploy): el gateway de Supabase ya validó
// que el JWT es de un usuario autenticado antes de que este código corra.
// Acá, además, se verifica que ESE usuario sea dueño del negocio_id que pide
// facturar — con un cliente scoped a su propio JWT, dejando que la RLS de
// `negocios` (negocio.user_id = auth.uid()) haga el chequeo sola. Recién
// después se usa el cliente service_role para leer facturacion_credenciales
// (tabla sin ninguna policy para authenticated/anon a propósito).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ambienteActual, ambienteEfectivo, type Ambiente } from './ambiente.ts';
import { obtenerTicketAcceso } from './wsaa.ts';
import { ultimoAutorizado, solicitarCAE, type AlicIva, type CbteAsociado, type AuthWsfe } from './wsfe.ts';
import { validarTopeConsumidorFinal, validarTipoComprobante, tipoNotaCreditoPara } from './validaciones.ts';
import { diagnosticoCms } from './diagnostico.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

interface ConfigNegocio {
  cuit: string;
  punto_venta: number;
  condicion_iva: string | null;
  activo: boolean;
  ambiente: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({ ok: false, error: 'Body inválido' }, 400);
  }

  const accion = body?.accion;

  if (accion === 'diagnostico') {
    const resultado = diagnosticoCms();
    return jsonResponse({ ok: resultado.ok, ambiente: ambienteActual(), diagnostico: resultado.detalle });
  }

  if (accion !== 'emitir_factura' && accion !== 'emitir_nota_credito' && accion !== 'guardar_credenciales') {
    return jsonResponse({ ok: false, error: `accion desconocida: ${accion}` }, 400);
  }

  const negocioId = body?.negocio_id;
  if (!negocioId) return jsonResponse({ ok: false, error: 'Falta negocio_id' }, 400);

  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: negocio, error: negocioError } = await callerClient
    .from('negocios')
    .select('id')
    .eq('id', negocioId)
    .maybeSingle();
  if (negocioError || !negocio) {
    return jsonResponse({ ok: false, error: 'No autorizado para este negocio' }, 403);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (accion === 'guardar_credenciales') {
    try {
      return await guardarCredenciales(admin, negocioId, body);
    } catch (e) {
      console.log('Error guardando credenciales afip-wsfe:', e);
      return jsonResponse({ ok: false, error: String(e) }, 500);
    }
  }

  try {
    const { data: config, error: configError } = await admin
      .from('facturacion_config')
      .select('cuit, punto_venta, condicion_iva, activo, ambiente')
      .eq('negocio_id', negocioId)
      .maybeSingle();
    if (configError || !config) return jsonResponse({ ok: false, error: 'El negocio no tiene facturacion_config cargada' }, 400);
    if (!config.activo) return jsonResponse({ ok: false, error: 'Facturación electrónica desactivada para este negocio' }, 400);
    if (!config.cuit || !config.punto_venta) return jsonResponse({ ok: false, error: 'Falta CUIT o punto de venta en facturacion_config' }, 400);

    // Doble traba: solo pega a producción si el secret global Y la config
    // del negocio dicen producción los dos — ver comentario en ambiente.ts.
    const ambiente = ambienteEfectivo(ambienteActual(), config.ambiente);

    const { data: topeRow } = await admin
      .from('facturacion_parametros_vigentes')
      .select('valor')
      .eq('clave', 'tope_consumidor_final')
      .maybeSingle();
    const topeVigente = topeRow?.valor ? Number(topeRow.valor) : Infinity;

    if (accion === 'emitir_factura') {
      return await emitirFactura(admin, ambiente, negocioId, config as ConfigNegocio, topeVigente, body);
    } else {
      return await emitirNotaCredito(admin, ambiente, negocioId, config as ConfigNegocio, body);
    }
  } catch (e) {
    console.log('Error en afip-wsfe:', e);
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }
});

// Pisa cualquier ticket WSAA cacheado: un certificado nuevo invalida el
// Ticket de Acceso que estuviera vigente para el certificado anterior.
async function guardarCredenciales(admin: SupabaseClient, negocioId: string, body: any): Promise<Response> {
  const certificadoPem = String(body.certificado_pem ?? '').trim();
  const clavePrivadaPem = String(body.clave_privada_pem ?? '').trim();

  if (!certificadoPem.includes('BEGIN CERTIFICATE') || !clavePrivadaPem.includes('PRIVATE KEY')) {
    return jsonResponse({ ok: false, error: 'El certificado o la clave privada no tienen el formato PEM esperado (revisá que hayas pegado el archivo completo, con las líneas BEGIN/END)' }, 400);
  }

  const { error: credError } = await admin
    .from('facturacion_credenciales')
    .upsert({
      negocio_id: negocioId,
      certificado_pem: certificadoPem,
      clave_privada_pem: clavePrivadaPem,
      cargado_en: new Date().toISOString(),
      wsaa_token: null,
      wsaa_sign: null,
      wsaa_expiracion: null,
    });
  if (credError) return jsonResponse({ ok: false, error: `No se pudo guardar el certificado: ${credError.message}` }, 500);

  const { error: configError } = await admin
    .from('facturacion_config')
    .update({ certificado_cargado: true })
    .eq('negocio_id', negocioId);
  if (configError) {
    return jsonResponse({ ok: true, aviso: `Certificado guardado, pero no se pudo marcar facturacion_config: ${configError.message}` });
  }

  return jsonResponse({ ok: true });
}

async function emitirFactura(
  admin: SupabaseClient,
  ambiente: Ambiente,
  negocioId: string,
  config: ConfigNegocio,
  topeVigente: number,
  body: any
): Promise<Response> {
  const tipoComprobante = Number(body.tipo_comprobante);
  const errTipo = validarTipoComprobante(tipoComprobante);
  if (errTipo) return jsonResponse({ ok: false, error: errTipo }, 400);

  const docTipo = Number(body.doc_tipo ?? 99);
  const docNro = String(body.doc_nro ?? '0');
  const importeNeto = Number(body.importe_neto ?? 0);
  const importeIva = Number(body.importe_iva ?? 0);
  const importeTotal = Number(body.importe_total ?? importeNeto + importeIva);
  const ivaDesglose: AlicIva[] = tipoComprobante === 11 ? [] : body.iva_desglose ?? [];

  const errTope = validarTopeConsumidorFinal(docTipo, importeTotal, topeVigente);
  if (errTope) return jsonResponse({ ok: false, error: errTope }, 400);

  const ta = await obtenerTicketAcceso(admin, negocioId, ambiente);
  const auth: AuthWsfe = { token: ta.token, sign: ta.sign, cuit: config.cuit };

  const ultimo = await ultimoAutorizado(ambiente, auth, config.punto_venta, tipoComprobante);
  const numeroComprobante = ultimo + 1;

  const resultadoCAE = await solicitarCAE(ambiente, auth, {
    ptoVta: config.punto_venta,
    cbteTipo: tipoComprobante,
    docTipo,
    docNro,
    numeroComprobante,
    impNeto: importeNeto,
    impIva: importeIva,
    impTotal: importeTotal,
    ivaDesglose,
  });

  const estado = resultadoCAE.resultado === 'A' ? 'autorizado' : 'rechazado';

  const { data: inserted, error: insertError } = await admin
    .from('facturas_electronicas')
    .insert({
      negocio_id: negocioId,
      movimiento_id: body.movimiento_id ?? null,
      tipo_comprobante: tipoComprobante,
      punto_venta: config.punto_venta,
      numero_comprobante: numeroComprobante,
      doc_tipo: docTipo,
      doc_nro: docNro,
      importe_neto: importeNeto,
      importe_iva: importeIva,
      importe_total: importeTotal,
      iva_desglose: ivaDesglose,
      cae: resultadoCAE.cae,
      cae_vencimiento: resultadoCAE.caeVencimiento,
      estado,
      ambiente,
      error_detalle: resultadoCAE.observaciones.join(' | ') || null,
    })
    .select()
    .single();

  if (insertError) {
    return jsonResponse({ ok: false, error: `CAE resuelto pero no se pudo guardar: ${insertError.message}`, resultadoCAE }, 500);
  }
  return jsonResponse({ ok: estado === 'autorizado', factura: inserted });
}

async function emitirNotaCredito(admin: SupabaseClient, ambiente: Ambiente, negocioId: string, config: ConfigNegocio, body: any): Promise<Response> {
  const facturaId = body.factura_electronica_id;
  if (!facturaId) return jsonResponse({ ok: false, error: 'Falta factura_electronica_id' }, 400);

  const { data: original, error: origError } = await admin
    .from('facturas_electronicas')
    .select('*')
    .eq('id', facturaId)
    .eq('negocio_id', negocioId)
    .maybeSingle();
  if (origError || !original) return jsonResponse({ ok: false, error: 'No se encontró la factura original' }, 404);
  if (original.estado !== 'autorizado' || !original.cae) {
    return jsonResponse({ ok: false, error: 'La factura original no está autorizada (no tiene CAE) — no se puede anular' }, 400);
  }

  const tipoNC = tipoNotaCreditoPara(original.tipo_comprobante);
  const importeNeto = Number(body.importe_neto ?? original.importe_neto);
  const importeIva = Number(body.importe_iva ?? original.importe_iva);
  const importeTotal = Number(body.importe_total ?? original.importe_total);
  const ivaDesglose: AlicIva[] = tipoNC === 13 ? [] : body.iva_desglose ?? original.iva_desglose ?? [];

  const ta = await obtenerTicketAcceso(admin, negocioId, ambiente);
  const auth: AuthWsfe = { token: ta.token, sign: ta.sign, cuit: config.cuit };

  const ultimo = await ultimoAutorizado(ambiente, auth, config.punto_venta, tipoNC);
  const numeroComprobante = ultimo + 1;

  const cbtesAsoc: CbteAsociado[] = [{ tipo: original.tipo_comprobante, ptoVta: original.punto_venta, nro: original.numero_comprobante }];

  const resultadoCAE = await solicitarCAE(ambiente, auth, {
    ptoVta: config.punto_venta,
    cbteTipo: tipoNC,
    docTipo: original.doc_tipo,
    docNro: original.doc_nro,
    numeroComprobante,
    impNeto: importeNeto,
    impIva: importeIva,
    impTotal: importeTotal,
    ivaDesglose,
    cbtesAsoc,
  });

  const estado = resultadoCAE.resultado === 'A' ? 'autorizado' : 'rechazado';

  const { data: inserted, error: insertError } = await admin
    .from('notas_credito')
    .insert({
      negocio_id: negocioId,
      factura_electronica_id: facturaId,
      tipo_comprobante: tipoNC,
      punto_venta: config.punto_venta,
      numero_comprobante: numeroComprobante,
      motivo: body.motivo ?? 'anulacion_venta',
      importe_neto: importeNeto,
      importe_iva: importeIva,
      importe_total: importeTotal,
      iva_desglose: ivaDesglose,
      cae: resultadoCAE.cae,
      cae_vencimiento: resultadoCAE.caeVencimiento,
      estado,
      ambiente,
      error_detalle: resultadoCAE.observaciones.join(' | ') || null,
    })
    .select()
    .single();

  if (insertError) {
    return jsonResponse({ ok: false, error: `CAE resuelto pero no se pudo guardar: ${insertError.message}`, resultadoCAE }, 500);
  }
  return jsonResponse({ ok: estado === 'autorizado', notaCredito: inserted });
}
