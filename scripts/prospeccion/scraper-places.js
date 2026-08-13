// Consulta Google Places API (New) — Text Search — por ciudad + rubro, y
// guarda cada resultado en prospectos_locales (Supabase, service_role).
// Nunca scrapea Maps/Instagram directo: ver SKILL.md.
//
// FieldMask limitado a campos tier Essentials/Pro (id, displayName,
// formattedAddress, location) — evita a propósito los campos tier
// Enterprise (rating, userRatingCount, internationalPhoneNumber,
// websiteUri), que son más caros y no hacen falta para este primer paso.
// El teléfono se resuelve más adelante, aparte, solo para los prospectos
// que ya filtramos (ver nota en SKILL.md / generar-link-wa.js).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ciudad') args.ciudad = argv[++i];
    else if (argv[i] === '--rubro') args.rubro = argv[++i];
  }
  return args;
}

async function buscarComercios(ciudad, rubro, apiKey) {
  const res = await fetch(PLACES_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: `${rubro} en ${ciudad}` }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Places API respondió ${res.status}: ${JSON.stringify(data)}`);
  }
  // Nota: Text Search devuelve hasta 20 resultados por página (nextPageToken
  // para más) — esta primera versión solo trae la primera página.
  return data.places || [];
}

function mapearProspecto(place, ciudad, rubro) {
  return {
    place_id: place.id,
    ciudad,
    rubro,
    nombre: place.displayName ? place.displayName.text : null,
    direccion: place.formattedAddress || null,
    lat: place.location ? place.location.latitude : null,
    lng: place.location ? place.location.longitude : null,
  };
}

async function main() {
  const { ciudad, rubro } = parseArgs(process.argv.slice(2));
  if (!ciudad || !rubro) {
    console.error('Uso: node scraper-places.js --ciudad "Mar del Plata" --rubro "almacen"');
    process.exit(1);
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !supabaseUrl || !supabaseKey) {
    console.error('Faltan variables de entorno — revisá .env contra .env.example');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log(`Buscando "${rubro}" en "${ciudad}"...`);
  const places = await buscarComercios(ciudad, rubro, apiKey);
  console.log(`Places API devolvió ${places.length} resultado(s).`);

  let guardados = 0;
  let errores = 0;
  for (const place of places) {
    if (!place.id) continue;
    const prospecto = mapearProspecto(place, ciudad, rubro);
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
