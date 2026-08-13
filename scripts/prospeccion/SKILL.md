---
name: prospeccion-inbound
description: Motor de captación de leads B2B para GestoPro a costo $0 sin excepciones — usa Nominatim/OpenStreetMap (no scraping directo, sin API key ni tarjeta), IA gratuita para redactar mensajes, y links de WhatsApp pre-armados para que el prospecto escriba primero. Evita outreach en frío y automatización no oficial de WhatsApp por riesgo de bloqueo y cuestiones legales (Ley 25.326).
---

# Prospección Inbound — Filosofía y Reglas

## Principio rector
Priorizamos que el prospecto nos escriba a nosotros, no al revés. Generamos contenido con un link de WhatsApp pre-cargado (`wa.me`); el mensaje lo redacta la IA, pero lo envía el dueño del comercio al hacer clic, no nosotros a él en frío.

## Prohibido (no implementar, aunque se pida)
- Scraping directo de Google Maps o Instagram (viola ToS, riesgo de bloqueo de IP/cuenta)
- Envío automatizado/masivo de WhatsApp vía Evolution API, Baileys o similar hacia números que no iniciaron contacto (riesgo alto de baneo + roza Ley 25.326 de protección de datos)
- APIs de datos de comercios que exijan tarjeta de crédito para el tier gratuito (ej. Google Places API actual) — la condición es $0 sin excepciones, no "gratis con tarjeta cargada"

## Stack permitido
- **Datos de comercios:** Nominatim (OpenStreetMap) — gratis, sin API key, sin tarjeta, sin registro. Política de uso dura: máx. 1 request/seg, `User-Agent` identificable obligatorio. Cobertura de comercios más floja que Google Maps (contrapartida de ser gratis sin condiciones) y sin teléfono — nunca scraping directo
- **Redacción:** Gemini API (tier gratuito) u Ollama local
- **Orquestación:** n8n self-hosted o scripts locales en Node/Python
- **Almacenamiento:** Supabase, tabla `prospectos_locales`
- **Contacto:** link `wa.me/<numero>?text=<mensaje>` embebido en contenido (posts, landing, historias) — nunca envío directo

## Estructura de carpetas
/scripts/prospeccion/
  scraper-places.js       # Nominatim (OSM): ciudad + rubro → lista de comercios
  generar-mensaje.js      # Gemini/Ollama: nombre+rubro → mensaje WhatsApp + copy Instagram
  generar-link-wa.js      # arma wa.me/...?text=... con el mensaje ya generado
  orchestrator.js         # scrapear → guardar en Supabase → generar mensaje → generar link (NO envía nada)
  README.md

## Flujo del orchestrator (npm run prospectar)
1. Recibe ciudad + rubro como argumento
2. scraper-places.js consulta Nominatim (OpenStreetMap)
3. Guarda cada resultado en prospectos_locales (Supabase)
4. generar-mensaje.js genera mensaje personalizado + copy de Instagram por cada prospecto
5. generar-link-wa.js arma el link wa.me con el mensaje
6. Guarda el link en prospectos_locales para uso posterior en contenido/landing — el script termina ahí, no dispara ningún mensaje

## Antes de escribir código
Si se pide algo relacionado a "conseguir contactos" o "mandar mensajes" que no encaje en este flujo (por ejemplo, "automatizá el envío a toda la lista"), avisar explícitamente el riesgo antes de implementarlo, en vez de construirlo directo.
