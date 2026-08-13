// Consulta Nominatim (OpenStreetMap) por ciudad + rubro, y guarda cada
// resultado en prospectos_locales (Supabase, service_role). $0 sin
// excepciones: sin API key, sin tarjeta, sin registro. Nunca scrapea
// Maps/Instagram directo: ver SKILL.md.
//
// Nominatim no da teléfono ni un campo de "nombre de negocio" separado
// (solo display_name, la dirección completa formateada) — cobertura de
// comercios en OSM es más floja que la de Google Maps, es la contrapartida
// de que sea gratis sin condiciones. El teléfono se resuelve más adelante,
// aparte, con otra fuente a definir, solo para los prospectos ya filtrados.
//
// Política de uso de Nominatim (dura, no opcional): máximo 1 request/seg y
// User-Agent identificable obligatorio, si no bloquea. Esta versión hace
// una sola consulta por corrida, así que no necesita esperar entre
// llamadas — pero cualquier código futuro que loopee varias ciudades/rubros
// en una sola corrida (ej. orchestrator.js) SÍ tiene que esperar ≥1s entre
// cada llamada a este endpoint.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'GestoPro-Prospeccion (contacto@gestopro.com.ar)';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ciudad') args.ciudad = argv[++i];
    else if (argv[i] === '--rubro') args.rubro = argv[++i];
  }
  return args;
}

async function buscarComercios(ciudad, rubro) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', `${rubro} en ${ciudad}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(`Nominatim respondió ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function mapearProspecto(result, ciudad, rubro) {
  // Nominatim no separa "nombre del negocio" de la dirección — display_name
  // es todo junto ("Nombre, Calle Número, Ciudad, ..."). El primer segmento
  // suele ser el nombre del lugar cuando está tageado en OSM; si no, queda
  // el primer tramo de la dirección — mejor esfuerzo, no garantizado.
  const nombre = (result.display_name || '').split(',')[0].trim() || null;
  return {
    // osm_type+osm_id es el identificador estable de Nominatim — el
    // place_id que devuelve la API es un id interno de su base que puede
    // cambiar entre actualizaciones, no sirve para deduplicar en el tiempo.
    place_id: `${result.osm_type}/${result.osm_id}`,
    ciudad,
    rubro,
    nombre,
    direccion: result.display_name || null,
    lat: result.lat ? parseFloat(result.lat) : null,
    lng: result.lon ? parseFloat(result.lon) : null,
  };
}

async function main() {
  const { ciudad, rubro } = parseArgs(process.argv.slice(2));
  if (!ciudad || !rubro) {
    console.error('Uso: node scraper-places.js --ciudad "Mar del Plata" --rubro "almacen"');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Faltan variables de entorno — revisá .env contra .env.example');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log(`Buscando "${rubro}" en "${ciudad}"...`);
  const resultados = await buscarComercios(ciudad, rubro);
  console.log(`Nominatim devolvió ${resultados.length} resultado(s).`);

  let guardados = 0;
  let errores = 0;
  for (const result of resultados) {
    if (!result.osm_id) continue;
    const prospecto = mapearProspecto(result, ciudad, rubro);
    const { error } = await supabase
      .from('prospectos_locales')
      .upsert(prospecto, { onConflict: 'place_id', ignoreDuplicates: false });
    if (error) {
      console.error(`No se pudo guardar "${prospecto.nombre}": ${error.message}`);
      errores++;
    } else {
      guardados++;
    }
  }

  console.log(`Listo: ${guardados} prospecto(s) guardados en prospectos_locales, ${errores} error(es).`);
}

main().catch((e) => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
