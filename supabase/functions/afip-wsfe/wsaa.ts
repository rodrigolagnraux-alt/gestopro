// Cliente WSAA (Web Service de Autenticación y Autorización). Firma un
// Ticket de Requerimiento de Acceso (TRA) en CMS/PKCS#7 con el certificado y
// clave privada del negocio, y lo canjea por un Ticket de Acceso (TA:
// token+sign) válido ~12hs.
//
// El algoritmo de firma (node-forge, PKCS7 SignedData, digest SHA-256) se
// validó localmente contra un certificado autofirmado de prueba antes de
// escribir este archivo. Lo que NO se pudo validar todavía, porque este
// sandbox no tiene salida de red hacia *.afip.gov.ar ni *.supabase.co
// (política de egress, confirmado con 403 en el proxy): la llamada SOAP
// real a loginCms. Los nombres exactos de tags/namespace vienen de la
// documentación pública de WSAA — a confirmar en cuanto haya un certificado
// de homologación real para probar de punta a punta.
import forge from 'node-forge';
import type { SupabaseClient } from '@supabase/supabase-js';
import { urlWsaa, type Ambiente } from './ambiente.ts';
import { extraerTag, decodeXmlEntities } from './xml.ts';

export interface TicketAcceso {
  token: string;
  sign: string;
  expiracion: string; // ISO
}

function buildTraXml(): string {
  const now = new Date();
  // Márgenes generosos (1 min atrás, 10 min adelante) para tolerar desfasaje
  // de reloj entre este runtime y los servidores de ARCA.
  const gen = new Date(now.getTime() - 60_000);
  const exp = new Date(now.getTime() + 10 * 60_000);
  const uniqueId = Math.floor(now.getTime() / 1000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, '-00:00');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<loginTicketRequest version="1.0">\n  <header>\n    <uniqueId>${uniqueId}</uniqueId>\n    <generationTime>${iso(gen)}</generationTime>\n    <expirationTime>${iso(exp)}</expirationTime>\n  </header>\n  <service>wsfe</service>\n</loginTicketRequest>`;
}

/** Firma el TRA en CMS/PKCS#7 (SignedData, contenido embebido, no detached). */
export function firmarTra(traXml: string, certificadoPem: string, clavePrivadaPem: string): string {
  const cert = forge.pki.certificateFromPem(certificadoPem);
  const privateKey = forge.pki.privateKeyFromPem(clavePrivadaPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

/** POST SOAP a loginCms y parseo de la respuesta (token/sign/expirationTime). */
async function loginCms(ambiente: Ambiente, cmsBase64: string): Promise<TicketAcceso> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desarrollo.afip.gov">\n  <soapenv:Header/>\n  <soapenv:Body>\n    <wsaa:loginCms>\n      <wsaa:in0>${cmsBase64}</wsaa:in0>\n    </wsaa:loginCms>\n  </soapenv:Body>\n</soapenv:Envelope>`;

  const res = await fetch(urlWsaa(ambiente), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: envelope,
  });
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`WSAA respondió ${res.status}: ${bodyText.slice(0, 500)}`);
  }

  const faultString = extraerTag(bodyText, 'faultstring');
  if (faultString) {
    // Ej.: "El CEE ya posee un TA valido para el acceso solicitado" (hay que
    // usar el cacheado) o rechazo de certificado no reconocido por ARCA.
    throw new Error(`WSAA devolvió un fault: ${decodeXmlEntities(faultString)}`);
  }

  const loginCmsReturn = extraerTag(bodyText, 'loginCmsReturn');
  if (!loginCmsReturn) {
    throw new Error(`No se encontró loginCmsReturn en la respuesta de WSAA: ${bodyText.slice(0, 500)}`);
  }
  const innerXml = decodeXmlEntities(loginCmsReturn);

  const token = extraerTag(innerXml, 'token');
  const sign = extraerTag(innerXml, 'sign');
  const expirationTime = extraerTag(innerXml, 'expirationTime');
  if (!token || !sign || !expirationTime) {
    throw new Error(`Respuesta de WSAA incompleta (faltan token/sign/expirationTime): ${innerXml.slice(0, 500)}`);
  }

  return { token, sign, expiracion: expirationTime };
}

/**
 * Devuelve un Ticket de Acceso vigente para el negocio, usando el cacheado
 * en facturacion_credenciales si todavía no venció (con 5 min de margen —
 * ARCA rechaza un loginCms nuevo mientras haya uno vigente), o pidiendo uno
 * nuevo si no.
 */
export async function obtenerTicketAcceso(
  supabaseAdmin: SupabaseClient,
  negocioId: string,
  ambiente: Ambiente
): Promise<TicketAcceso> {
  const { data: cred, error } = await supabaseAdmin
    .from('facturacion_credenciales')
    .select('certificado_pem, clave_privada_pem, wsaa_token, wsaa_sign, wsaa_expiracion')
    .eq('negocio_id', negocioId)
    .maybeSingle();

  if (error) throw new Error(`Error leyendo facturacion_credenciales: ${error.message}`);
  if (!cred || !cred.certificado_pem || !cred.clave_privada_pem) {
    throw new Error('El negocio todavía no cargó su certificado digital en facturacion_credenciales.');
  }

  if (cred.wsaa_token && cred.wsaa_sign && cred.wsaa_expiracion) {
    const vencimiento = new Date(cred.wsaa_expiracion).getTime();
    const margenMs = 5 * 60_000;
    if (vencimiento - margenMs > Date.now()) {
      return { token: cred.wsaa_token, sign: cred.wsaa_sign, expiracion: cred.wsaa_expiracion };
    }
  }

  const traXml = buildTraXml();
  const cmsBase64 = firmarTra(traXml, cred.certificado_pem, cred.clave_privada_pem);
  const ta = await loginCms(ambiente, cmsBase64);

  const { error: updError } = await supabaseAdmin
    .from('facturacion_credenciales')
    .update({ wsaa_token: ta.token, wsaa_sign: ta.sign, wsaa_expiracion: ta.expiracion })
    .eq('negocio_id', negocioId);
  if (updError) console.log('No se pudo cachear el TA (se sigue usando igual):', updError.message);

  return ta;
}
