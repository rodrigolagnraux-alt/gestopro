// Self-test que NO toca facturacion_credenciales ni llama a ARCA: genera un
// certificado autofirmado de prueba en memoria, firma un TRA de muestra, y
// confirma que el CMS resultante decodifica bien (certificado + firma
// presentes). Prueba que la lógica de firma de wsaa.ts funciona en el
// runtime real de Deno — lo más cerca que se puede llegar a "probar WSAA"
// sin un certificado real de ARCA.
import forge from 'node-forge';
import { firmarTra } from './wsaa.ts';

export function diagnosticoCms(): { ok: boolean; detalle: Record<string, unknown> } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'diagnostico-afip-wsfe' }, { name: 'countryName', value: 'AR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  const traXml = `<?xml version="1.0" encoding="UTF-8"?>\n<loginTicketRequest version="1.0"><header><uniqueId>1</uniqueId><generationTime>2026-01-01T00:00:00-00:00</generationTime><expirationTime>2026-01-01T00:10:00-00:00</expirationTime></header><service>wsfe</service></loginTicketRequest>`;

  try {
    const cmsBase64 = firmarTra(traXml, certPem, keyPem);
    const der = forge.util.decode64(cmsBase64);
    const asn1 = forge.asn1.fromDer(der);
    const p7 = forge.pkcs7.messageFromAsn1(asn1) as any;

    const tieneCertificados = Array.isArray(p7.certificates) && p7.certificates.length === 1;
    const tieneFirmantes = !!(p7.rawCapture && p7.rawCapture.signature);

    return {
      ok: tieneCertificados && tieneFirmantes,
      detalle: {
        longitudCmsBase64: cmsBase64.length,
        tieneCertificados,
        tieneFirmantes,
        contentType: p7.type,
      },
    };
  } catch (e) {
    return { ok: false, detalle: { error: String(e) } };
  }
}
