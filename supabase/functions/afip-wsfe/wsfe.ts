// Cliente WSFEv1 (facturación electrónica). FECompUltimoAutorizado para
// pedir el próximo número de comprobante (nunca un contador local — ARCA es
// la única fuente de verdad) y FECAESolicitar para autorizar el comprobante
// y obtener el CAE.
//
// Igual que wsaa.ts: la forma de los mensajes SOAP viene de la
// documentación pública de WSFEv1 y de cómo la usan las libs open-source de
// referencia — no se pudo probar contra el servicio real (ver nota en
// wsaa.ts). Puntualmente `CondicionIVAReceptorId` es un campo que ARCA fue
// haciendo obligatorio progresivamente en los últimos años; lo mandamos con
// un valor por default razonable, pero HAY QUE confirmarlo contra la última
// versión del manual de WSFEv1 antes de emitir un comprobante real.
import { urlWsfe, type Ambiente } from './ambiente.ts';
import { escapeXml, extraerTag, extraerTagRepetido, fechaAfip } from './xml.ts';

export interface AuthWsfe {
  token: string;
  sign: string;
  cuit: string;
}

export interface AlicIva {
  id: number; // 3=0%, 4=10.5%, 5=21%, 6=27%, 8=5%, 9=2.5%
  baseImp: number;
  importe: number;
}

export interface CbteAsociado {
  tipo: number;
  ptoVta: number;
  nro: number;
}

export interface DetalleComprobante {
  ptoVta: number;
  cbteTipo: number; // 1/6/11 factura A/B/C, 3/8/13 nota de crédito A/B/C
  concepto?: number; // default 1 = Productos
  docTipo: number; // 80=CUIT, 96=DNI, 99=Consumidor Final
  docNro: string;
  numeroComprobante: number; // ya resuelto vía FECompUltimoAutorizado + 1
  fecha?: Date;
  impNeto: number;
  impIva: number;
  impTotal: number;
  ivaDesglose?: AlicIva[]; // vacío/omitido en Factura C (monotributo no discrimina IVA)
  cbtesAsoc?: CbteAsociado[]; // obligatorio en notas de crédito
  condicionIvaReceptorId?: number; // default: 5 = Consumidor Final
}

export interface ResultadoCAE {
  resultado: 'A' | 'R' | string; // Aprobado / Rechazado
  cae: string | null;
  caeVencimiento: string | null;
  observaciones: string[];
}

async function soapPost(ambiente: Ambiente, soapAction: string, envelope: string): Promise<string> {
  const res = await fetch(urlWsfe(ambiente), {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `http://ar.gov.afip.dif.FEV1/${soapAction}`,
    },
    body: envelope,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WSFEv1 (${soapAction}) respondió ${res.status}: ${text.slice(0, 500)}`);
  const faultString = extraerTag(text, 'faultstring');
  if (faultString) throw new Error(`WSFEv1 (${soapAction}) devolvió un fault: ${faultString}`);
  return text;
}

function authXml(auth: AuthWsfe): string {
  return `<ar:Auth><ar:Token>${escapeXml(auth.token)}</ar:Token><ar:Sign>${escapeXml(auth.sign)}</ar:Sign><ar:Cuit>${escapeXml(auth.cuit)}</ar:Cuit></ar:Auth>`;
}

/** Último número de comprobante autorizado por ARCA para ese punto de venta + tipo. */
export async function ultimoAutorizado(ambiente: Ambiente, auth: AuthWsfe, ptoVta: number, cbteTipo: number): Promise<number> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">\n  <soapenv:Header/>\n  <soapenv:Body>\n    <ar:FECompUltimoAutorizado>\n      ${authXml(auth)}\n      <ar:PtoVta>${ptoVta}</ar:PtoVta>\n      <ar:CbteTipo>${cbteTipo}</ar:CbteTipo>\n    </ar:FECompUltimoAutorizado>\n  </soapenv:Body>\n</soapenv:Envelope>`;

  const respuesta = await soapPost(ambiente, 'FECompUltimoAutorizado', envelope);
  const cbteNro = extraerTag(respuesta, 'CbteNro');
  if (cbteNro === null) throw new Error(`No se pudo leer CbteNro de FECompUltimoAutorizado: ${respuesta.slice(0, 500)}`);
  return parseInt(cbteNro, 10) || 0;
}

function ivaXml(desglose: AlicIva[] | undefined): string {
  if (!desglose || !desglose.length) return '';
  const items = desglose
    .map(
      (a) =>
        `<ar:AlicIva><ar:Id>${a.id}</ar:Id><ar:BaseImp>${a.baseImp.toFixed(2)}</ar:BaseImp><ar:Importe>${a.importe.toFixed(2)}</ar:Importe></ar:AlicIva>`
    )
    .join('');
  return `<ar:Iva>${items}</ar:Iva>`;
}

function cbtesAsocXml(asociados: CbteAsociado[] | undefined): string {
  if (!asociados || !asociados.length) return '';
  const items = asociados
    .map((c) => `<ar:CbteAsoc><ar:Tipo>${c.tipo}</ar:Tipo><ar:PtoVta>${c.ptoVta}</ar:PtoVta><ar:Nro>${c.nro}</ar:Nro></ar:CbteAsoc>`)
    .join('');
  return `<ar:CbtesAsoc>${items}</ar:CbtesAsoc>`;
}

/** Solicita el CAE de un comprobante (factura o nota de crédito) ya numerado. */
export async function solicitarCAE(ambiente: Ambiente, auth: AuthWsfe, detalle: DetalleComprobante): Promise<ResultadoCAE> {
  const fecha = fechaAfip(detalle.fecha ?? new Date());
  const concepto = detalle.concepto ?? 1;
  const condicionIvaReceptorId = detalle.condicionIvaReceptorId ?? 5;

  const detalleXml = `<ar:FECAEDetRequest>\n    <ar:Concepto>${concepto}</ar:Concepto>\n    <ar:DocTipo>${detalle.docTipo}</ar:DocTipo>\n    <ar:DocNro>${escapeXml(detalle.docNro)}</ar:DocNro>\n    <ar:CbteDesde>${detalle.numeroComprobante}</ar:CbteDesde>\n    <ar:CbteHasta>${detalle.numeroComprobante}</ar:CbteHasta>\n    <ar:CbteFch>${fecha}</ar:CbteFch>\n    <ar:ImpTotal>${detalle.impTotal.toFixed(2)}</ar:ImpTotal>\n    <ar:ImpTotConc>0.00</ar:ImpTotConc>\n    <ar:ImpNeto>${detalle.impNeto.toFixed(2)}</ar:ImpNeto>\n    <ar:ImpOpEx>0.00</ar:ImpOpEx>\n    <ar:ImpIVA>${detalle.impIva.toFixed(2)}</ar:ImpIVA>\n    <ar:ImpTrib>0.00</ar:ImpTrib>\n    <ar:MonId>PES</ar:MonId>\n    <ar:MonCotiz>1</ar:MonCotiz>\n    <ar:CondicionIVAReceptorId>${condicionIvaReceptorId}</ar:CondicionIVAReceptorId>\n    ${ivaXml(detalle.ivaDesglose)}\n    ${cbtesAsocXml(detalle.cbtesAsoc)}\n  </ar:FECAEDetRequest>`;

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">\n  <soapenv:Header/>\n  <soapenv:Body>\n    <ar:FECAESolicitar>\n      ${authXml(auth)}\n      <ar:FeCAEReq>\n        <ar:FeCabReq>\n          <ar:CantReg>1</ar:CantReg>\n          <ar:PtoVta>${detalle.ptoVta}</ar:PtoVta>\n          <ar:CbteTipo>${detalle.cbteTipo}</ar:CbteTipo>\n        </ar:FeCabReq>\n        <ar:FeDetReq>\n          ${detalleXml}\n        </ar:FeDetReq>\n      </ar:FeCAEReq>\n    </ar:FECAESolicitar>\n  </soapenv:Body>\n</soapenv:Envelope>`;

  const respuesta = await soapPost(ambiente, 'FECAESolicitar', envelope);

  const resultado = extraerTag(respuesta, 'Resultado') ?? 'R';
  const cae = extraerTag(respuesta, 'CAE');
  const caeVencimiento = extraerTag(respuesta, 'CAEFchVto');
  const observaciones = extraerTagRepetido(respuesta, 'Msg');

  return { resultado, cae, caeVencimiento, observaciones };
}
