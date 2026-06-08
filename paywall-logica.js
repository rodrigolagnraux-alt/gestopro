/* ============================================================
   GESTOPRO — LÓGICA PAYWALL / TRIAL 35 DÍAS
   Pegar este bloque al inicio del <script> principal de index.html
   ============================================================ */

// ── PLANES Y PERMISOS ─────────────────────────────────────────
const PLANES = {
  gratis:  { nombre: 'Gratis (Trial)',  dias: 35,   precio: 0      },
  basico:  { nombre: 'Básico',          dias: null, precio: 60000  },
  pro:     { nombre: 'Pro',             dias: null, precio: 75000  },
  premium: { nombre: 'Premium',         dias: null, precio: 120000 },
};

// ── VERIFICAR ACCESO AL INICIAR LA APP ───────────────────────
async function verificarAcceso() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return; // No hay sesión, el flujo de login ya maneja esto

  const userId = session.user.id;

  // Traer datos del negocio desde Supabase
  const { data: negocio, error } = await supabase
    .from('negocios')
    .select('plan, fecha_registro, plan_vencimiento, aprobado')
    .eq('user_id', userId)
    .single();

  if (error || !negocio) {
    console.error('Error cargando negocio:', error);
    return;
  }

  // ── 1. Negocio no aprobado aún ──────────────────────────────
  if (!negocio.aprobado) {
    mostrarPantallaEspera();
    return;
  }

  // ── 2. Tiene plan pago activo ───────────────────────────────
  if (['basico', 'pro', 'premium'].includes(negocio.plan)) {
    const hoy = new Date();
    const venc = negocio.plan_vencimiento ? new Date(negocio.plan_vencimiento) : null;

    if (venc && hoy > venc) {
      // Plan pago vencido → mostrar paywall
      mostrarPaywall();
      return;
    }

    // Plan activo → mostrar indicador en UI
    mostrarBadgePlan(negocio.plan);
    return;
  }

  // ── 3. Plan gratis (trial) ──────────────────────────────────
  if (negocio.plan === 'gratis' || !negocio.plan) {
    const fechaReg = new Date(negocio.fecha_registro);
    const hoy = new Date();
    const diasTranscurridos = Math.floor((hoy - fechaReg) / (1000 * 60 * 60 * 24));
    const diasRestantes = 35 - diasTranscurridos;

    if (diasRestantes <= 0) {
      // Trial vencido → paywall
      mostrarPaywall();
      return;
    }

    // Trial activo → mostrar advertencia si quedan pocos días
    mostrarBadgeTrial(diasRestantes);

    if (diasRestantes <= 5) {
      mostrarToastTrialPorVencer(diasRestantes);
    }
  }
}

// ── REDIRIGIR A PAYWALL ──────────────────────────────────────
function mostrarPaywall() {
  // Guardar la ruta actual para redirigir después del pago (opcional)
  sessionStorage.setItem('gestopro_redirect', window.location.href);
  window.location.href = 'paywall.html';
}

// ── PANTALLA DE ESPERA (cuenta no aprobada aún) ───────────────
function mostrarPantallaEspera() {
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1rem;font-family:'DM Sans',sans-serif;background:#F7F6F2;padding:2rem;text-align:center;">
      <div style="font-size:40px;">⏳</div>
      <h2 style="font-family:'Sora',sans-serif;font-size:22px;color:#2C2C2A;">Tu cuenta está siendo revisada</h2>
      <p style="color:#5F5E5A;max-width:340px;line-height:1.6;">En breve recibirás acceso. Si tenés urgencia, escribinos por WhatsApp.</p>
      <a href="https://wa.me/5492473XXXXXX?text=Hola!%20Me%20registré%20en%20GestoPro%20y%20estoy%20esperando%20aprobación"
         style="background:#25D366;color:white;padding:10px 22px;border-radius:50px;text-decoration:none;font-weight:600;font-size:14px;margin-top:0.5rem;">
        Consultar por WhatsApp
      </a>
      <button onclick="supabase.auth.signOut().then(()=>location.reload())"
        style="background:transparent;border:1px solid #D3D1C7;color:#5F5E5A;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:13px;margin-top:0.5rem;">
        Cerrar sesión
      </button>
    </div>
  `;
}

// ── BADGE DE PLAN EN EL HEADER ────────────────────────────────
function mostrarBadgePlan(plan) {
  const colores = {
    basico:  { bg: '#E3F2FD', color: '#1976D2' },
    pro:     { bg: '#E1F5EE', color: '#0F6E56' },
    premium: { bg: '#F3E5F5', color: '#6A1B9A' },
  };
  const c = colores[plan] || colores.pro;

  // Buscar contenedor del header donde poner el badge
  const header = document.querySelector('.header-usuario') || document.querySelector('header');
  if (!header) return;

  const badge = document.createElement('span');
  badge.style.cssText = `background:${c.bg};color:${c.color};padding:3px 10px;border-radius:50px;font-size:12px;font-weight:600;`;
  badge.textContent = 'Plan ' + plan.charAt(0).toUpperCase() + plan.slice(1);
  header.appendChild(badge);
}

// ── BADGE + AVISO DE TRIAL ────────────────────────────────────
function mostrarBadgeTrial(diasRestantes) {
  const header = document.querySelector('.header-usuario') || document.querySelector('header');
  if (!header) return;

  const badge = document.createElement('span');
  badge.style.cssText = `background:#FFF8E1;color:#7B5800;padding:3px 10px;border-radius:50px;font-size:12px;font-weight:600;cursor:pointer;`;
  badge.textContent = `Trial: ${diasRestantes} días`;
  badge.onclick = () => window.location.href = 'paywall.html';
  header.appendChild(badge);
}

// ── TOAST "TRIAL POR VENCER" ──────────────────────────────────
function mostrarToastTrialPorVencer(dias) {
  // Evitar mostrar el toast más de una vez por sesión
  if (sessionStorage.getItem('gestopro_toast_trial')) return;
  sessionStorage.setItem('gestopro_toast_trial', '1');

  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:#fff;border:1.5px solid #FFB74D;border-radius:12px;
    padding:14px 20px;box-shadow:0 4px 20px rgba(0,0,0,0.12);
    display:flex;align-items:center;gap:12px;z-index:9999;
    font-family:'DM Sans',sans-serif;max-width:340px;
    animation:slideUp 0.3s ease;
  `;
  toast.innerHTML = `
    <span style="font-size:22px;">⚠️</span>
    <div>
      <strong style="display:block;font-size:13.5px;color:#2C2C2A;">
        Te quedan ${dias} día${dias !== 1 ? 's' : ''} de prueba
      </strong>
      <span style="font-size:12.5px;color:#5F5E5A;">
        <a href="paywall.html" style="color:#0F6E56;font-weight:600;text-decoration:none;">Activar un plan →</a>
      </span>
    </div>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#888;line-height:1;padding:0 0 0 4px;">×</button>
  `;

  const style = document.createElement('style');
  style.textContent = '@keyframes slideUp{from{opacity:0;transform:translateX(-50%) translateY(20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
  document.head.appendChild(style);
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 8000);
}

// ── LLAMAR AL VERIFICAR ACCESO ────────────────────────────────
// Este llamado debe ir DESPUÉS de inicializar Supabase:
// verificarAcceso();

/* ============================================================
   CAMBIOS NECESARIOS EN LA TABLA "negocios" DE SUPABASE:
   
   ALTER TABLE negocios ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'gratis';
   ALTER TABLE negocios ADD COLUMN IF NOT EXISTS plan_vencimiento DATE;
   ALTER TABLE negocios ADD COLUMN IF NOT EXISTS aprobado BOOLEAN DEFAULT false;
   
   En el admin panel, al activar un plan:
   UPDATE negocios SET plan = 'pro', plan_vencimiento = '2026-07-08', aprobado = true
   WHERE user_id = 'xxx';
   ============================================================ */
