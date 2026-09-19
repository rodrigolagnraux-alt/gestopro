# Handoff — Revalidación periódica de vencimiento de plan (parte 2)

Este archivo se sobrescribe cada vez que hay un diagnóstico o código largo
para pasar. No tiene historial — lo que importa es el contenido actual.

## Estado: implementado, commiteado y pusheado

Commit: c1db72e — "Revalidar el vencimiento de plan en el cliente cada 5 min y al volver el foco"
Rama: claude/chat-greeting-once-96wt0k (pusheado a origin)

## Los 4 puntos que pediste confirmar, uno por uno

1. Intervalo corregido: 300000 (5 minutos en milisegundos). El bug anterior
   era que escribí el cálculo con asteriscos ("5 por 60 por 1000") en el
   chat, y el asterisco es carácter de markdown — el copy-paste se comió
   los asteriscos y pegó los números en 5601000. Ya no queda ningún cálculo
   con asteriscos en el código ni en lo que te mando por chat.

2. Select con exento agregado: la consulta de revalidarAccesoNegocio() trae
   aprobado, plan, plan_vencimiento y exento. Nota que ya te había hecho:
   verificarAccesoNegocio() en el cliente hoy no usa exento (solo lo usa la
   función del servidor, negocio_puede_operar). Lo dejé cargado en el select
   por las dudas, pero no cambia el comportamiento actual del cliente. Si
   querés que el cliente también lo use, es un cambio aparte que no hice.

3. currentNegocioId: confirmado que es una variable preexistente del
   archivo, no algo que agregué yo.
   - Declaración: línea 8472, "var currentNegocioId = null;"
   - Se carga con el id real: línea 8871, dentro de cargarNegocio(),
     "currentNegocioId=negocio.id;"
   - Se limpia al cerrar sesión: línea 8642, dentro de resetSesionLocal()
   Es la misma variable que usa el resto de toda la app.

4. Rama SIGNED_OUT: aplicada tal cual se confirmó. Línea actual en el
   archivo (el número puede correrse un poco con futuros cambios, pero el
   contenido es exacto):
   if(event === 'SIGNED_OUT'){ gpSesionActivaId = null; detenerRevalidacionPeriodica(); return; }

## La corrección de detenerCamara

Confirmé el nombre real de la función que cierra la cámara del escáner
antes de aplicar nada. No se llama detenerScanner (eso era una suposición
mía sin confirmar, que había marcado explícitamente como pendiente de
verificar). El nombre real es detenerCamara(), declarada en la línea 7396,
y además de limpiar scannerInterval también detiene los tracks de
scannerStream (la cámara físicamente). La línea aplicada en
mostrarPantallaEspera() usa el nombre correcto:
if(typeof detenerCamara==='function') detenerCamara();

## Validación de sintaxis

Extraje todos los bloques <script> inline del archivo con un regex de
Python y corrí "node --check" sobre el resultado combinado.

Resultado: SYNTAX_OK — sin errores.

## Lo que se corrió después (por si no llegó a verse en el chat)

- Test funcional dedicado (smoke-revalidacion-plan.js), 7 casos, los 7
  pasaron: iniciar/detener el timer, revalidarAccesoNegocio trae datos
  frescos y actualiza planActual, el throttle de 60s funciona, el
  visibilitychange dispara la revalidación al volver el foco (y deja de
  hacerlo después de detenerRevalidacionPeriodica), mostrarPantallaEspera
  para los 3 timers (revalidación, polling de pedidos, cámara), y
  cerrarSesion para el timer de revalidación. También un chequeo de
  código fuente aparte confirmando la línea exacta de la rama SIGNED_OUT.
- Regresión completa de los 67 tests acumulados de toda la sesión: 67/67
  limpios, sin ningún fallo.
- Recién después de eso se hizo el commit y el push.

## Qué falta

Nada pendiente de esta parte 2. Lo único que quedó abierto (mencionado en
el chat) es si querés probarlo ahora contra Supabase real con una cuenta
vencida (por ejemplo Mr Chicken), o revisar el código primero vos mismo
en el repo.
