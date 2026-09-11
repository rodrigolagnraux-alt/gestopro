// Helpers chicos de XML. Las respuestas de WSAA/WSFEv1 tienen una forma
// estable y bien conocida, así que un extractor por regex alcanza sin sumar
// una dependencia de parser XML completo solo para esto.

export function escapeXml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Contenido de la primera ocurrencia de <tag> o <ns:tag>, o null si no está. */
export function extraerTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Todas las ocurrencias de <tag>, en orden — para arrays tipo <Obs>...</Obs>. */
export function extraerTagRepetido(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Fecha AAAAMMDD que exige WSFEv1 (no ISO 8601). */
export function fechaAfip(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
