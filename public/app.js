// ============================================================================
// SPA SUPERLOOK - Frontend Dashboard (Clientas + Vista Privada HMAC + Admin Mamá)
// ============================================================================

const API_BASE = window.SUPERLOOK_API_BASE || '';

const state = {
  servicios: [],
  selectedCategoria: 'Todas',
  selectedServicioId: null,
  selectedFecha: '',
  selectedHora: '',
  adminToken: sessionStorage.getItem('superlook_admin_token') || '',
  adminCitas: [],
  adminServicios: [],
  adminChats: [],
  lastAdminChatsHash: '',
  chatPollingTimer: null,
  webChatHistory: [],
};

function formatCOP(valor) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(Number(valor || 0));
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTodayBogotaYmd() {
  const bogotaNow = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return bogotaNow.toISOString().slice(0, 10);
}

function formatDateTimeLocal(isoString) {
  if (!isoString) return 'N/A';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return d.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// Cambia entre las 3 vistas: 'reservar', 'micita', 'admin'
function switchView(view) {
  const views = {
    reservar: document.getElementById('viewReservar'),
    micita: document.getElementById('viewMiCita'),
    admin: document.getElementById('viewAdmin'),
  };
  const tabs = {
    reservar: document.getElementById('tabBtnReservar'),
    micita: document.getElementById('tabBtnMiCita'),
    admin: document.getElementById('tabBtnAdmin'),
  };

  Object.keys(views).forEach((k) => {
    if (k === view) {
      views[k].classList.remove('hidden');
      tabs[k].classList.add('active');
    } else {
      views[k].classList.add('hidden');
      tabs[k].classList.remove('active');
    }
  });

  const fab = document.getElementById('fabConciergeBtn');
  if (fab) {
    fab.classList.toggle('hidden', view === 'admin');
  }

  if (view === 'admin') {
    checkAndLoadAdminPanel();
  }
}

// ============================================================================
// 1. INICIALIZACIÓN Y DETECCIÓN DE LINK FIRMADO (?cita=UUID&token=HMAC)
// ============================================================================
async function initApp() {
  const today = getTodayBogotaYmd();
  state.selectedFecha = today;
  const dateInput = document.getElementById('inputFecha');
  if (dateInput) {
    dateInput.value = today;
    dateInput.min = today;
  }

  await loadPublicServices();
  initCookieBanner();

  // Verificar si la clienta abrió un link firmado desde WhatsApp (?cita=UUID&token=HMAC)
  // o si tu mamá entró directo con ?admin=1
  const params = new URLSearchParams(window.location.search);
  const citaParam = params.get('cita');
  const tokenParam = params.get('token');
  const adminParam = params.get('admin');

  if (citaParam && tokenParam) {
    document.getElementById('inputLookupCitaId').value = citaParam;
    document.getElementById('inputLookupToken').value = tokenParam;
    switchView('micita');
    await fetchAndRenderPrivateCita(citaParam, tokenParam);
  } else if (adminParam === '1' || window.location.hash === '#admin') {
    switchView('admin');
  } else if (window.location.hash === '#micita') {
    switchView('micita');
  }
}

function initCookieBanner() {
  const banner = document.getElementById('cookieBanner');
  if (!banner) return;
  if (!localStorage.getItem('superlook_cookies_accepted')) {
    banner.classList.remove('hidden');
  }
}

function acceptCookies() {
  localStorage.setItem('superlook_cookies_accepted', new Date().toISOString());
  const banner = document.getElementById('cookieBanner');
  if (banner) banner.classList.add('hidden');
}

// ============================================================================
// 2. CATÁLOGO PÚBLICO Y AGENDAMIENTO BAJO RESERVA PREVIA
// ============================================================================
async function loadPublicServices() {
  try {
    const res = await fetch(`${API_BASE}/api/servicios`);
    const data = await res.json();
    state.servicios = data.servicios || [];

    if (state.servicios.length > 0 && !state.selectedServicioId) {
      state.selectedServicioId = state.servicios[0].id;
    }

    renderCategories();
    renderServicesCatalog();
    renderServiceSelect();
    updateFinancialBreakdown();
    await loadAvailableSlots();
  } catch (err) {
    document.getElementById('servicesCatalogList').innerHTML =
      `<div class="alert-error">Error cargando servicios: ${escapeHtml(err.message)}</div>`;
  }
}

function renderCategories() {
  const container = document.getElementById('categoryFilters');
  const categorias = ['Todas', ...new Set(state.servicios.map((s) => s.categoria || 'General'))];

  container.innerHTML = categorias
    .map(
      (cat) => `
      <button type="button" class="chip ${state.selectedCategoria === cat ? 'active' : ''}"
        onclick="selectCategory('${escapeHtml(cat)}')">
        ${escapeHtml(cat)}
      </button>
    `
    )
    .join('');
}

function selectCategory(cat) {
  state.selectedCategoria = cat;
  renderCategories();
  renderServicesCatalog();
}

function renderServicesCatalog() {
  const container = document.getElementById('servicesCatalogList');
  const filtered =
    state.selectedCategoria === 'Todas'
      ? state.servicios
      : state.servicios.filter((s) => (s.categoria || 'General') === state.selectedCategoria);

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">No hay servicios activos en esta categoría.</div>`;
    return;
  }

  container.innerHTML = filtered
    .map((srv) => {
      const reembolso80 = Math.round(srv.precio_cop * 0.8);
      const retencion20 = srv.precio_cop - reembolso80;
      const isSelected = Number(srv.id) === Number(state.selectedServicioId);
      return `
        <div class="service-item ${isSelected ? 'selected' : ''}" onclick="chooseService(${srv.id})">
          <span class="service-cat-tag">${escapeHtml(srv.categoria || 'General')}</span>
          <div class="service-top">
            <div class="service-name">${escapeHtml(srv.nombre)}</div>
            <div class="service-price">${formatCOP(srv.precio_cop)}</div>
          </div>
          <div class="service-desc">${escapeHtml(srv.descripcion)}</div>
          <div class="service-meta">
            <span>⏱️ ${srv.duracion_minutos} min</span>
            <span>•</span>
            <span>🔄 Reembolso 80% si cancelas: <strong>${formatCOP(reembolso80)}</strong> (Retención 20%: ${formatCOP(retencion20)})</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderServiceSelect() {
  const select = document.getElementById('selectServicio');
  select.innerHTML = state.servicios
    .map(
      (srv) => `
      <option value="${srv.id}" ${Number(srv.id) === Number(state.selectedServicioId) ? 'selected' : ''}>
        [${escapeHtml(srv.categoria || 'General')}] ${escapeHtml(srv.nombre)} — ${formatCOP(srv.precio_cop)} (${srv.duracion_minutos} min)
      </option>
    `
    )
    .join('');
}

async function chooseService(id) {
  state.selectedServicioId = Number(id);
  document.getElementById('selectServicio').value = String(id);
  renderServicesCatalog();
  updateFinancialBreakdown();
  await loadAvailableSlots();
}

async function onServiceSelectChange() {
  const val = Number(document.getElementById('selectServicio').value);
  await chooseService(val);
}

function updateFinancialBreakdown() {
  const srv = state.servicios.find((s) => Number(s.id) === Number(state.selectedServicioId));
  const precio = srv ? srv.precio_cop : 0;
  const reembolso80 = Math.round(precio * 0.8);
  const retencion20 = precio - reembolso80;

  document.getElementById('lblTotal100').textContent = formatCOP(precio);
  document.getElementById('lblRetencion20').textContent = formatCOP(retencion20);
  document.getElementById('lblReembolso80').textContent = formatCOP(reembolso80);
}

async function loadAvailableSlots() {
  const fecha = document.getElementById('inputFecha').value || state.selectedFecha;
  state.selectedFecha = fecha;
  state.selectedHora = '';
  document.getElementById('inputHoraSeleccionada').value = '';

  const slotsContainer = document.getElementById('slotsContainer');
  if (!fecha || !state.selectedServicioId) {
    slotsContainer.innerHTML = `<div class="empty-state">Selecciona un servicio y una fecha.</div>`;
    return;
  }

  slotsContainer.innerHTML = `<div class="loading-box">Consultando agenda disponible en D1...</div>`;

  try {
    const res = await fetch(
      `${API_BASE}/api/disponibilidad?fecha=${encodeURIComponent(fecha)}&servicio_id=${encodeURIComponent(state.selectedServicioId)}`
    );
    const data = await res.json();
    const horarios = data.horarios_disponibles || [];

    if (horarios.length === 0) {
      slotsContainer.innerHTML = `<div class="empty-state">No hay bloques disponibles para esta fecha. Prueba con otro día.</div>`;
      return;
    }

    slotsContainer.innerHTML = horarios
      .map(
        (hhmm) => `
        <button type="button" class="slot-btn ${state.selectedHora === hhmm ? 'selected' : ''}"
          onclick="selectTimeSlot('${escapeHtml(hhmm)}')">
          ${escapeHtml(hhmm)}
        </button>
      `
      )
      .join('');
  } catch (err) {
    slotsContainer.innerHTML = `<div class="alert-error">Error consultando disponibilidad: ${escapeHtml(err.message)}</div>`;
  }
}

function selectTimeSlot(hhmm) {
  state.selectedHora = hhmm;
  document.getElementById('inputHoraSeleccionada').value = hhmm;
  document.querySelectorAll('#slotsContainer .slot-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.textContent.trim() === hhmm);
  });
  const stepHorario = document.getElementById('stepPillHorario');
  if (stepHorario) stepHorario.classList.add('active');
}

async function handleBookingSubmit(event) {
  event.preventDefault();
  const resultBox = document.getElementById('bookingResultBox');
  const submitBtn = document.getElementById('btnSubmitBooking');

  if (!state.selectedHora) {
    alert('Por favor selecciona un horario disponible para tu reserva.');
    return;
  }

  const nombre = document.getElementById('inputNombre').value.trim();
  const telefono = document.getElementById('inputTelefono').value.trim();
  const fecha = document.getElementById('inputFecha').value;
  const pasarela = (document.getElementById('selectPasarela')?.value || 'BOLD').toUpperCase();
  const fechaHoraInicio = `${fecha}T${state.selectedHora}:00-05:00`;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Verificando disponibilidad y generando pago...';
  resultBox.classList.add('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/reservas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_nombre: nombre,
        cliente_telefono: telefono,
        servicio_id: Number(state.selectedServicioId),
        fecha_hora_inicio: fechaHoraInicio,
        metodo_pago: pasarela,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo crear la reserva.');
    }

    const cita = data.cita;
    const manageUrl = data.cita_manage_url;
    const token = data.cita_access_token;
    const gatewayLabel = data.gateway === 'WOMPI' ? 'Wompi' : 'Bold';
    const stepPago = document.getElementById('stepPillPago');
    if (stepPago) stepPago.classList.add('active');

    resultBox.classList.remove('hidden');
    resultBox.innerHTML = `
      <h3 style="margin-bottom:0.4rem">✅ ¡Ticket de Reserva Creado Automáticamente!</h3>
      <p style="margin-bottom:0.65rem">Tu turno ha sido bloqueado por <strong>20 minutos</strong> y enviamos tu enlace a WhatsApp. Te estamos redirigiendo automáticamente a <strong>${escapeHtml(gatewayLabel)}</strong> para completar el pago...</p>
      <div style="margin-bottom:0.75rem; font-size:0.83rem;">
        <div>• <strong>Servicio:</strong> ${escapeHtml(cita.servicio_nombre)}</div>
        <div>• <strong>Fecha/Hora:</strong> ${escapeHtml(formatDateTimeLocal(cita.fecha_hora_inicio))}</div>
        <div>• <strong>Referencia ${escapeHtml(gatewayLabel)}:</strong> <code>${escapeHtml(cita.wompi_reference)}</code></div>
        <div>• <strong>Total a pagar (100%):</strong> ${formatCOP(cita.monto_total)}</div>
        <div>• <strong>Reembolso 80% si cancelas:</strong> ${formatCOP(cita.monto_reembolso_80)} (Retención 20%: ${formatCOP(cita.monto_retencion_20)})</div>
      </div>
      <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
        <a href="${escapeHtml(data.payment_link)}" class="btn btn-primary btn-animated">
          💳 Ir a Pagar en ${escapeHtml(gatewayLabel)} (${formatCOP(cita.monto_total)})
        </a>
        <button type="button" class="btn btn-secondary" onclick="openPrivateCitaView('${escapeHtml(cita.id)}', '${escapeHtml(token)}')">
          🎟️ Ver Mi Ticket Privado
        </button>
      </div>
      <p style="margin-top:0.65rem; font-size:0.77rem; color:#383e4c;">
        🔒 Tu enlace privado de gestión: <a href="${escapeHtml(manageUrl)}">${escapeHtml(manageUrl)}</a>
      </p>
    `;

    try {
      localStorage.setItem('superlook_last_ticket_url', manageUrl);
    } catch {}

    resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await loadAvailableSlots();

    // Emitir y redirigir automáticamente al link de pago oficial de Bold / Wompi
    if (data.payment_link && data.payment_link.startsWith('https://')) {
      setTimeout(() => {
        window.location.href = data.payment_link;
      }, 1200);
    }
  } catch (err) {
    resultBox.classList.remove('hidden');
    resultBox.innerHTML = `<div class="alert-error">${escapeHtml(err.message)}</div>`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '💳 Generar Reserva y Link de Pago Wompi';
  }
}

async function openPrivateCitaView(citaId, token) {
  document.getElementById('inputLookupCitaId').value = citaId;
  document.getElementById('inputLookupToken').value = token;
  switchView('micita');
  await fetchAndRenderPrivateCita(citaId, token);
}

// ============================================================================
// 3. VISTA PRIVADA DE CITA PARA CLIENTA (CON TOKEN HMAC)
// ============================================================================
async function handleManualCitaLookup(event) {
  event.preventDefault();
  const citaId = document.getElementById('inputLookupCitaId').value.trim();
  const token = document.getElementById('inputLookupToken').value.trim();
  await fetchAndRenderPrivateCita(citaId, token);
}

async function fetchAndRenderPrivateCita(citaId, token) {
  const container = document.getElementById('clientCitaDetailBox');
  container.innerHTML = `<div class="loading-box">Verificando token de seguridad y cargando tu reserva...</div>`;

  try {
    const res = await fetch(
      `${API_BASE}/api/citas/${encodeURIComponent(citaId)}?token=${encodeURIComponent(token)}`
    );
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo consultar la cita.');
    }

    const c = data.cita;
    const canCancel = c.estado === 'CONFIRMADA' || c.estado === 'PENDIENTE_PAGO';

    container.innerHTML = `
      <div class="cita-card">
        <div class="admin-item-header">
          <div>
            <strong>Reserva #${escapeHtml(c.id.slice(0, 8).toUpperCase())}</strong>
            <div style="font-size:0.78rem; color:#687082;">ID completo: <code>${escapeHtml(c.id)}</code></div>
          </div>
          <span class="status-badge status-${escapeHtml(c.estado)}">${escapeHtml(c.estado)}</span>
        </div>

        <div style="margin: 0.75rem 0; font-size:0.88rem; display:grid; gap:0.35rem;">
          <div>👤 <strong>Clienta:</strong> ${escapeHtml(c.cliente_nombre)} (${escapeHtml(c.cliente_telefono)})</div>
          <div>💇‍♀️ <strong>Servicio:</strong> ${escapeHtml(c.servicio_nombre || 'Servicio')}</div>
          <div>🗓️ <strong>Fecha y Hora:</strong> ${escapeHtml(formatDateTimeLocal(c.fecha_hora_inicio))}</div>
          <div>🧾 <strong>Referencia Wompi:</strong> <code>${escapeHtml(c.wompi_reference || 'N/A')}</code></div>
        </div>

        <div class="financial-breakdown">
          <div class="breakdown-row">
            <span>Valor total del servicio (100%):</span>
            <strong>${formatCOP(c.monto_total)}</strong>
          </div>
          <div class="breakdown-row">
            <span>Retención administrativa del 20% por cancelación:</span>
            <strong>${formatCOP(c.monto_retencion_20)}</strong>
          </div>
          <div class="breakdown-row highlight-refund">
            <span>Monto exacto de reembolso del 80% por cancelación:</span>
            <strong>${formatCOP(c.monto_reembolso_80)}</strong>
          </div>
        </div>

        <p style="font-size:0.79rem; color:#687082; margin-bottom:0.85rem;">
          📌 ${escapeHtml(data.politica_cancelacion)}
        </p>

        ${
          canCancel
            ? `<button type="button" class="btn btn-danger btn-block" onclick="handleClientCancelCita('${escapeHtml(c.id)}', '${escapeHtml(token)}', ${c.monto_reembolso_80}, ${c.monto_retencion_20})">
                 ⚠️ Cancelar Mi Reserva (Solicitar Reembolso del 80%: ${formatCOP(c.monto_reembolso_80)})
               </button>`
            : `<div class="empty-state">Esta reserva ya se encuentra en estado <strong>${escapeHtml(c.estado)}</strong>.</div>`
        }
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="alert-error">${escapeHtml(err.message)}</div>`;
  }
}

async function handleClientCancelCita(citaId, token, reembolso80, retencion20) {
  const confirmed = confirm(
    `¿Confirmas la cancelación de tu cita en Spa Superlook?\n\n` +
      `De acuerdo con nuestra política obligatoria:\n` +
      `• Se retiene el 20% (${formatCOP(retencion20)}) por gastos administrativos y reserva de agenda.\n` +
      `• Se registrará tu reembolso del 80% por valor de ${formatCOP(reembolso80)} y se notificará de inmediato a la administración.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(
      `${API_BASE}/api/citas/${encodeURIComponent(citaId)}/cancelar?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }
    );
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Error al cancelar la cita.');
    }

    alert(
      `Cita cancelada correctamente.\nEstado: ${data.nuevo_estado}\nMonto a reembolsar (80%): ${formatCOP(data.monto_reembolso_80)}`
    );
    await fetchAndRenderPrivateCita(citaId, token);
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ============================================================================
// 4. PANEL ADMINISTRATIVO PROTEGIDO (MAMÁ)
// ============================================================================
async function checkAndLoadAdminPanel() {
  const loginCard = document.getElementById('adminLoginCard');
  const dashboardContent = document.getElementById('adminDashboardContent');

  if (!state.adminToken) {
    loginCard.classList.remove('hidden');
    dashboardContent.classList.add('hidden');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/verify`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
    });
    if (!res.ok) {
      throw new Error('Sesión expirada');
    }

    loginCard.classList.add('hidden');
    dashboardContent.classList.remove('hidden');
    if (window.innerWidth <= 768) {
      switchAdminSection('turnos');
    }
    await loadAdminData();
    startAdminChatPolling();
  } catch {
    stopAdminChatPolling();
    state.adminToken = '';
    sessionStorage.removeItem('superlook_admin_token');
    loginCard.classList.remove('hidden');
    dashboardContent.classList.add('hidden');
  }
}

function startAdminChatPolling() {
  stopAdminChatPolling();
  state.chatPollingTimer = setInterval(() => {
    const adminVisible = !document.getElementById('viewAdmin')?.classList.contains('hidden');
    const activeEl = document.activeElement;
    const isTypingReply = activeEl && activeEl.id && activeEl.id.startsWith('replyInput_');
    if (state.adminToken && adminVisible && !isTypingReply) {
      loadAdminChats();
    }
  }, 8000);
}

function stopAdminChatPolling() {
  if (state.chatPollingTimer) {
    clearInterval(state.chatPollingTimer);
    state.chatPollingTimer = null;
  }
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const pwd = document.getElementById('inputAdminPassword').value.trim();
  const errBox = document.getElementById('adminLoginError');
  errBox.classList.add('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Clave incorrecta');
    }

    state.adminToken = data.token;
    sessionStorage.setItem('superlook_admin_token', data.token);
    document.getElementById('inputAdminPassword').value = '';
    await checkAndLoadAdminPanel();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
}

function handleAdminLogout() {
  stopAdminChatPolling();
  state.adminToken = '';
  state.lastAdminChatsHash = '';
  sessionStorage.removeItem('superlook_admin_token');
  checkAndLoadAdminPanel();
}

async function loadAdminData() {
  if (!state.adminToken) return;

  try {
    const [citasRes, srvRes] = await Promise.all([
      fetch(`${API_BASE}/api/citas`, {
        headers: { Authorization: `Bearer ${state.adminToken}` },
      }),
      fetch(`${API_BASE}/api/admin/servicios`, {
        headers: { Authorization: `Bearer ${state.adminToken}` },
      }),
    ]);

    if (citasRes.status === 401 || srvRes.status === 401) {
      handleAdminLogout();
      return;
    }

    const citasData = await citasRes.json();
    const srvData = await srvRes.json();

    state.adminCitas = citasData.citas || [];
    state.adminServicios = srvData.servicios || [];

    renderAdminKpis();
    renderAdminPaymentBreakdown();
    populateManualServiceDropdown();
    renderAdminTurnosPorJornada();
    renderAdminCitas();
    renderAdminServices();
    await Promise.all([loadPublicServices(), loadAdminChats()]);
  } catch (err) {
    console.error('Error cargando datos admin:', err);
  }
}

// ============================================================================
// 4B. BANDEJA DE CHATS EN VIVO WHATSAPP BUSINESS (+57 312 4597896)
// ============================================================================
async function loadAdminChats(forceRender = false) {
  if (!state.adminToken) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/chats`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const incomingChats = data.chats || [];
    const nextHash = JSON.stringify(incomingChats);

    // Evitar re-renderizar si no hay mensajes nuevos (así el scroll nunca brinca mientras lees)
    if (!forceRender && nextHash === state.lastAdminChatsHash) {
      return;
    }

    state.lastAdminChatsHash = nextHash;
    state.adminChats = incomingChats;
    renderAdminChats();
  } catch (err) {
    console.error('Error cargando chats WhatsApp:', err);
  }
}

function renderAdminChats() {
  const container = document.getElementById('adminChatsContainer');
  if (!container) return;

  // Guardar posición de scroll y borradores escritos antes de actualizar el DOM
  const scrollStateByPhone = new Map();
  const draftsByPhone = new Map();

  container.querySelectorAll('.chat-messages-box[data-chat-phone]').forEach((box) => {
    const phone = box.getAttribute('data-chat-phone');
    if (!phone) return;
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    scrollStateByPhone.set(phone, {
      scrollTop: box.scrollTop,
      wasNearBottom: distanceFromBottom < 48,
    });
  });

  container.querySelectorAll('input[id^="replyInput_"]').forEach((inp) => {
    const phone = inp.id.replace('replyInput_', '');
    if (inp.value) draftsByPhone.set(phone, inp.value);
  });

  if (state.adminChats.length === 0) {
    container.innerHTML =
      `<div class="empty-state">Aún no hay conversaciones recibidas en el WhatsApp Business (+57 312 4597896). Apenas una clienta escriba, aparecerá aquí en tiempo real.</div>`;
    return;
  }

  container.innerHTML = state.adminChats
    .map((chat) => {
      const safePhone = escapeHtml(chat.telefono);
      const messagesHtml = (chat.turns || [])
        .map((t) => {
          const cls =
            t.role === 'user'
              ? 'chat-bubble-client'
              : t.sender === 'admin'
                ? 'chat-bubble-admin'
                : 'chat-bubble-bot';
          const label =
            t.role === 'user'
              ? 'Clienta'
              : t.sender === 'admin'
                ? 'Mamá (Spa Superlook)'
                : 'Bot IA';
          return `
            <div class="chat-bubble ${cls}">
              <div style="font-size:0.68rem; font-weight:800; opacity:0.75; margin-bottom:0.15rem;">${label}</div>
              <div>${linkifySafeText(t.text)}</div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="chat-thread-card">
          <div class="admin-item-header">
            <div>
              <strong>📱 +${safePhone}</strong>
              <div style="font-size:0.72rem; color:#667085;">Último msg: ${escapeHtml(formatDateTimeLocal(chat.updated_at))}</div>
            </div>
            <button type="button" class="btn btn-sm ${chat.human_takeover ? 'btn-success' : 'btn-secondary'}"
              onclick="toggleChatBotMode('${safePhone}', ${!chat.human_takeover})">
              ${chat.human_takeover ? '✋ Atendiendo Mamá (Reactivar Bot)' : '🤖 Bot Activo (Pausar Bot)'}
            </button>
          </div>
          <div class="chat-messages-box" data-chat-phone="${safePhone}">${messagesHtml || '<div class="empty-state">Sin mensajes</div>'}</div>
          <form class="chat-reply-row" onsubmit="sendAdminChatReply(event, '${safePhone}')">
            <input type="text" id="replyInput_${safePhone}" class="form-control" placeholder="Escribe como Spa Superlook (+57 312 4597896)..." required />
            <button type="submit" class="btn btn-primary btn-sm">Enviar</button>
          </form>
        </div>
      `;
    })
    .join('');

  // Restaurar scroll exacto (o bajar al último mensaje solo si es carga inicial / estaba al final)
  container.querySelectorAll('.chat-messages-box[data-chat-phone]').forEach((box) => {
    const phone = box.getAttribute('data-chat-phone');
    if (!phone) return;
    const prev = scrollStateByPhone.get(phone);
    if (!prev || prev.wasNearBottom) {
      box.scrollTop = box.scrollHeight;
    } else {
      box.scrollTop = prev.scrollTop;
    }
  });

  draftsByPhone.forEach((val, phone) => {
    const inp = document.getElementById(`replyInput_${phone}`);
    if (inp) inp.value = val;
  });
}

async function sendAdminChatReply(event, telefono) {
  event.preventDefault();
  const input = document.getElementById(`replyInput_${telefono}`);
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;

  input.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/admin/chats/${encodeURIComponent(telefono)}/responder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
      },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo enviar el mensaje de WhatsApp');
    }
    input.value = '';
    await loadAdminChats();
  } catch (err) {
    alert(`Error enviando mensaje: ${err.message}`);
  } finally {
    input.disabled = false;
  }
}

async function toggleChatBotMode(telefono, pauseBot) {
  try {
    const res = await fetch(`${API_BASE}/api/admin/chats/${encodeURIComponent(telefono)}/bot-mode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
      },
      body: JSON.stringify({ human_takeover: pauseBot }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo cambiar el modo del Bot');
    }
    await loadAdminChats();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function classifyPaymentMethod(rawMetodo) {
  const m = String(rawMetodo || 'ONLINE').toUpperCase();
  if (m === 'EFECTIVO') return { group: 'EFECTIVO', label: '💵 Efectivo', cls: 'method-EFECTIVO' };
  if (m === 'QR' || m === 'QR_BOLD') return { group: 'QR', label: '📲 Código QR', cls: 'method-QR' };
  if (m === 'TRANSFERENCIA') {
    return { group: 'TRANSFERENCIA', label: '🏦 Transferencia', cls: 'method-TRANSFERENCIA' };
  }
  return {
    group: 'ONLINE',
    label: `💳 ${m === 'WOMPI' ? 'Wompi' : m === 'BOLD' ? 'Bold' : m}`,
    cls: 'method-ONLINE',
  };
}

function renderAdminPaymentBreakdown() {
  const container = document.getElementById('adminPaymentBreakdown');
  if (!container) return;

  const confirmadas = state.adminCitas.filter((c) => c.estado === 'CONFIRMADA');
  const buckets = {
    EFECTIVO: { total: 0, count: 0 },
    QR: { total: 0, count: 0 },
    TRANSFERENCIA: { total: 0, count: 0 },
    ONLINE: { total: 0, count: 0 },
  };

  confirmadas.forEach((c) => {
    const info = classifyPaymentMethod(c.metodo_pago);
    buckets[info.group].total += Number(c.monto_total || 0);
    buckets[info.group].count += 1;
  });

  container.innerHTML = `
    <div class="pay-summary-card pay-efectivo">
      <div class="pay-summary-title">💵 Ingresos Efectivo</div>
      <div class="pay-summary-amount">${formatCOP(buckets.EFECTIVO.total)}</div>
      <div class="pay-summary-count">${buckets.EFECTIVO.count} pago(s)</div>
    </div>
    <div class="pay-summary-card pay-qr">
      <div class="pay-summary-title">📲 Ingresos Código QR</div>
      <div class="pay-summary-amount">${formatCOP(buckets.QR.total)}</div>
      <div class="pay-summary-count">${buckets.QR.count} pago(s)</div>
    </div>
    <div class="pay-summary-card pay-transferencia">
      <div class="pay-summary-title">🏦 Transferencias</div>
      <div class="pay-summary-amount">${formatCOP(buckets.TRANSFERENCIA.total)}</div>
      <div class="pay-summary-count">${buckets.TRANSFERENCIA.count} pago(s)</div>
    </div>
    <div class="pay-summary-card pay-online">
      <div class="pay-summary-title">💳 Pasarela Online</div>
      <div class="pay-summary-amount">${formatCOP(buckets.ONLINE.total)}</div>
      <div class="pay-summary-count">${buckets.ONLINE.count} pago(s) (Bold/Wompi)</div>
    </div>
  `;
}

function populateManualServiceDropdown() {
  const select = document.getElementById('manServicio');
  const fechaInput = document.getElementById('manFecha');
  if (fechaInput && !fechaInput.value) {
    fechaInput.value = getTodayBogotaYmd();
  }
  if (!select) return;

  const activos = state.adminServicios.filter((s) => s.activo === 1);
  const lista = activos.length > 0 ? activos : state.adminServicios;
  const currentVal = select.value;

  select.innerHTML = lista
    .map(
      (s) => `
      <option value="${s.id}" data-price="${s.precio_cop}">
        [${escapeHtml(s.categoria || 'General')}] ${escapeHtml(s.nombre)} — ${formatCOP(s.precio_cop)}
      </option>
    `
    )
    .join('');

  if (currentVal) select.value = currentVal;
  onManualServiceChange();
}

function onManualServiceChange() {
  const select = document.getElementById('manServicio');
  const montoInput = document.getElementById('manMonto');
  if (!select || !montoInput) return;
  const opt = select.options[select.selectedIndex];
  const price = opt ? Number(opt.dataset.price || 0) : 0;
  if (price > 0) {
    montoInput.value = String(price);
  }
}

function selectManualPaymentMethod(method) {
  const hidden = document.getElementById('manMetodoPago');
  if (hidden) hidden.value = method;
  document.querySelectorAll('#manMetodoPills .pay-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.method === method);
  });
}

async function handleAdminManualBooking(event) {
  event.preventDefault();
  const btn = document.getElementById('btnSaveManualBooking');
  const nombre = document.getElementById('manNombre').value.trim();
  const telefono = document.getElementById('manTelefono').value.trim();
  const servicioId = Number(document.getElementById('manServicio').value);
  const montoTotal = Number(document.getElementById('manMonto').value);
  const fecha = document.getElementById('manFecha').value;
  const hora = document.getElementById('manHora').value || '10:00';
  const metodoPago = document.getElementById('manMetodoPago').value || 'EFECTIVO';
  const estado = document.getElementById('manEstado').value || 'CONFIRMADA';
  const referenciaPago = document.getElementById('manReferencia').value.trim();
  const notificarWpp = Boolean(document.getElementById('manNotificarWpp')?.checked);

  if (!nombre || !servicioId || !fecha || !hora) {
    alert('Completa el nombre, servicio, fecha y hora.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Guardando ingreso y bloqueando turno...';

  try {
    const res = await fetch(`${API_BASE}/api/admin/citas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
      },
      body: JSON.stringify({
        cliente_nombre: nombre,
        cliente_telefono: telefono,
        servicio_id: servicioId,
        monto_total: montoTotal,
        fecha_hora_inicio: `${fecha}T${hora}:00-05:00`,
        metodo_pago: metodoPago,
        estado,
        referencia_pago: referenciaPago,
        notificar_whatsapp: notificarWpp,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo registrar el ingreso manual.');
    }

    document.getElementById('adminManualBookingForm').reset();
    document.getElementById('manFecha').value = fecha;
    document.getElementById('manHora').value = '10:00';
    selectManualPaymentMethod(metodoPago);
    alert(`✅ Ingreso registrado correctamente (${metodoPago} · ${formatCOP(data.monto_total)}).`);
    await loadAdminData();
    if (window.innerWidth <= 768) {
      switchAdminSection('turnos');
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Guardar Ingreso y Bloquear Turno en Agenda';
  }
}

async function handleAdminConfirmManualPayment(citaId, metodoPago) {
  if (
    !confirm(
      `¿Confirmar que recibiste el pago de este ticket por ${metodoPago}?\nPasará a CONFIRMADA, sumará en tu caja de ${metodoPago} y avisará a la clienta por WhatsApp.`
    )
  ) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/citas/${encodeURIComponent(citaId)}/confirmar-pago`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
      },
      body: JSON.stringify({ metodo_pago: metodoPago }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo confirmar el pago.');
    }
    await loadAdminData();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function switchAdminSection(section) {
  document.querySelectorAll('.admin-subtab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });

  const map = {
    caja: document.getElementById('adminSecCaja'),
    turnos: document.getElementById('adminSecTurnos'),
    chats: document.getElementById('adminSecChats'),
    tickets: document.getElementById('adminSecTickets'),
    servicios: document.getElementById('adminSecServicios'),
  };
  const bottomGrid = document.getElementById('adminSecBottomGrid');

  if (section === 'all') {
    Object.values(map).forEach((el) => el && el.classList.remove('hidden'));
    if (bottomGrid) bottomGrid.classList.remove('hidden');
    return;
  }

  Object.entries(map).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle('hidden', key !== section);
  });

  if (bottomGrid) {
    bottomGrid.classList.toggle('hidden', section !== 'tickets' && section !== 'servicios');
  }
}

function renderAdminKpis() {
  const confirmadas = state.adminCitas.filter((c) => c.estado === 'CONFIRMADA');
  const pendientesReembolso = state.adminCitas.filter(
    (c) => c.estado === 'REEMBOLSO_MANUAL_PENDIENTE'
  );
  const reembolsadas = state.adminCitas.filter((c) => c.estado === 'REEMBOLSADA');

  const ingresosConfirmados = confirmadas.reduce((acc, c) => acc + Number(c.monto_total || 0), 0);
  const totalPorDevolver80 = pendientesReembolso.reduce(
    (acc, c) => acc + Number(c.monto_reembolso_80 || 0),
    0
  );
  const retenciones20Ganadas = [...pendientesReembolso, ...reembolsadas].reduce(
    (acc, c) => acc + (Number(c.monto_total || 0) - Number(c.monto_reembolso_80 || 0)),
    0
  );

  document.getElementById('adminKpiGrid').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Citas Confirmadas</div>
      <div class="kpi-value">${confirmadas.length}</div>
      <div style="font-size:0.78rem; color:#16794b;">Pagadas 100%: ${formatCOP(ingresosConfirmados)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Reembolsos 80% Pendientes</div>
      <div class="kpi-value" style="color:#b42318;">${pendientesReembolso.length}</div>
      <div style="font-size:0.78rem; color:#b42318;">Por transferir (80%): ${formatCOP(totalPorDevolver80)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Retención 20% por Cancelaciones</div>
      <div class="kpi-value">${formatCOP(retenciones20Ganadas)}</div>
      <div style="font-size:0.78rem; color:#687082;">Gastos admin. y reserva de agenda</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Servicios en Catálogo</div>
      <div class="kpi-value">${state.adminServicios.filter((s) => s.activo === 1).length}</div>
      <div style="font-size:0.78rem; color:#687082;">Total registrados: ${state.adminServicios.length}</div>
    </div>
  `;
}

function clearAdminDateFilter() {
  const dateFilter = document.getElementById('adminFilterFecha');
  if (dateFilter) dateFilter.value = '';
  renderAdminTurnosPorJornada();
}

function getBogotaHourAndYmd(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return { hour: 9, ymd: '', hhmm: '' };
  const bogotaMs = d.getTime() - 5 * 60 * 60 * 1000;
  const bogotaDate = new Date(bogotaMs);
  const ymd = bogotaDate.toISOString().slice(0, 10);
  const hhmm = bogotaDate.toISOString().slice(11, 16);
  const hour = bogotaDate.getUTCHours();
  return { hour, ymd, hhmm };
}

function renderAdminTurnosPorJornada() {
  const board = document.getElementById('adminShiftsBoard');
  if (!board) return;

  const filtroEstado = document.getElementById('adminFilterEstado')?.value || 'TODOS';
  const filtroMetodo = document.getElementById('adminFilterMetodo')?.value || 'TODOS';
  const filtroFecha = document.getElementById('adminFilterFecha')?.value || '';

  const filtradas = state.adminCitas
    .filter((c) => (filtroEstado === 'TODOS' ? true : c.estado === filtroEstado))
    .filter((c) =>
      filtroMetodo === 'TODOS' ? true : classifyPaymentMethod(c.metodo_pago).group === filtroMetodo
    )
    .filter((c) => {
      if (!filtroFecha) return true;
      const { ymd } = getBogotaHourAndYmd(c.fecha_hora_inicio);
      return ymd === filtroFecha;
    })
    .sort((a, b) => new Date(a.fecha_hora_inicio).getTime() - new Date(b.fecha_hora_inicio).getTime());

  const turnos = {
    manana: { titulo: '🌅 Turno Mañana (08:00 - 11:59)', items: [] },
    mediodia: { titulo: '☀️ Turno Mediodía (12:00 - 14:59)', items: [] },
    tarde: { titulo: '🌇 Turno Tarde (15:00 - 18:00)', items: [] },
  };

  filtradas.forEach((cita) => {
    const { hour, ymd, hhmm } = getBogotaHourAndYmd(cita.fecha_hora_inicio);
    const enriched = { ...cita, _ymd: ymd, _hhmm: hhmm };
    if (hour < 12) {
      turnos.manana.items.push(enriched);
    } else if (hour < 15) {
      turnos.mediodia.items.push(enriched);
    } else {
      turnos.tarde.items.push(enriched);
    }
  });

  board.innerHTML = Object.values(turnos)
    .map((grupo) => {
      const cardsHtml =
        grupo.items.length === 0
          ? `<div class="empty-state" style="padding:0.85rem;">Sin turnos en esta jornada</div>`
          : grupo.items
              .map((c) => {
                const reembolso80 = c.monto_reembolso_80 || Math.round(c.monto_total * 0.8);
                const payInfo = classifyPaymentMethod(c.metodo_pago);
                const waPhone = String(c.cliente_telefono || '').replace(/\D/g, '');
                const waUrl =
                  waPhone && waPhone !== '0000000000'
                    ? `https://wa.me/${waPhone.startsWith('57') ? waPhone : '57' + waPhone}`
                    : '#';
                return `
                  <div class="ticket-mini-card">
                    <div class="admin-item-header">
                      <span class="ticket-time-pill">🗓️ ${escapeHtml(c._ymd)} · ⏰ ${escapeHtml(c._hhmm)}</span>
                      <span class="status-badge status-${escapeHtml(c.estado)}">${escapeHtml(c.estado)}</span>
                    </div>
                    <div style="font-weight:700; margin-top:0.25rem;">💇‍♀️ ${escapeHtml(c.servicio_nombre || 'Servicio')}</div>
                    <div>👤 ${escapeHtml(c.cliente_nombre)} ${
                      waUrl !== '#'
                        ? `· <a href="${escapeHtml(waUrl)}" target="_blank" rel="noopener" style="color:#157347; font-weight:700; text-decoration:none;">📲 ${escapeHtml(c.cliente_telefono)}</a>`
                        : ''
                    }</div>
                    <div style="font-size:0.77rem; color:#667085; margin-top:0.3rem; display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
                      <span class="method-badge ${payInfo.cls}">${payInfo.label}</span>
                      <span><strong>${formatCOP(c.monto_total)}</strong> (80%: ${formatCOP(reembolso80)})</span>
                    </div>
                  </div>
                `;
              })
              .join('');

      return `
        <div class="shift-column">
          <div class="shift-column-header">
            <span>${grupo.titulo}</span>
            <span class="shift-count-badge">${grupo.items.length}</span>
          </div>
          ${cardsHtml}
        </div>
      `;
    })
    .join('');
}

function renderAdminCitas() {
  const container = document.getElementById('adminCitasList');
  const filtro = document.getElementById('adminFilterEstado').value;
  const filtroMetodo = document.getElementById('adminFilterMetodo')?.value || 'TODOS';

  const lista = state.adminCitas
    .filter((c) => (filtro === 'TODOS' ? true : c.estado === filtro))
    .filter((c) =>
      filtroMetodo === 'TODOS' ? true : classifyPaymentMethod(c.metodo_pago).group === filtroMetodo
    );

  if (lista.length === 0) {
    container.innerHTML = `<div class="empty-state">No hay citas registradas para este filtro.</div>`;
    return;
  }

  container.innerHTML = lista
    .map((c) => {
      const reembolso80 = c.monto_reembolso_80 || Math.round(c.monto_total * 0.8);
      const retencion20 = c.monto_total - reembolso80;
      const payInfo = classifyPaymentMethod(c.metodo_pago);
      const canCancel = c.estado === 'CONFIRMADA' || c.estado === 'PENDIENTE_PAGO';
      const canConfirmManual = c.estado === 'PENDIENTE_PAGO';
      const canMarkRefunded = c.estado === 'REEMBOLSO_MANUAL_PENDIENTE';

      return `
        <div class="admin-item">
          <div class="admin-item-header">
            <strong>${escapeHtml(c.cliente_nombre)} (${escapeHtml(c.cliente_telefono)})</strong>
            <div style="display:flex; gap:0.35rem; align-items:center; flex-wrap:wrap;">
              <span class="method-badge ${payInfo.cls}">${payInfo.label}</span>
              <span class="status-badge status-${escapeHtml(c.estado)}">${escapeHtml(c.estado)}</span>
            </div>
          </div>
          <div>💇‍♀️ <strong>${escapeHtml(c.servicio_nombre || 'Servicio')}</strong> · 🗓️ ${escapeHtml(formatDateTimeLocal(c.fecha_hora_inicio))}</div>
          <div>💳 Total (100%): <strong>${formatCOP(c.monto_total)}</strong> | Retención (20%): <strong>${formatCOP(retencion20)}</strong> | Reembolso (80%): <strong style="color:#185170;">${formatCOP(reembolso80)}</strong></div>
          <div style="font-size:0.76rem; color:#687082;">Ref: <code>${escapeHtml(c.wompi_reference || 'N/A')}</code> · Nota/Tx: <code>${escapeHtml(c.wompi_transaction_id || 'Pendiente')}</code></div>
          <div class="admin-item-actions">
            ${
              canConfirmManual
                ? `<button type="button" class="btn btn-success btn-sm" onclick="handleAdminConfirmManualPayment('${escapeHtml(c.id)}', 'EFECTIVO')">💵 Cobré Efectivo</button>
                   <button type="button" class="btn btn-primary btn-sm" onclick="handleAdminConfirmManualPayment('${escapeHtml(c.id)}', 'QR')">📲 Cobré QR</button>
                   <button type="button" class="btn btn-secondary btn-sm" onclick="handleAdminConfirmManualPayment('${escapeHtml(c.id)}', 'TRANSFERENCIA')">🏦 Cobré Transf.</button>`
                : ''
            }
            ${
              c.client_manage_url
                ? `<button type="button" class="btn btn-secondary btn-sm" onclick="copyTextToClipboard('${escapeHtml(c.client_manage_url)}')">🔗 Copiar Ticket</button>`
                : ''
            }
            ${
              canCancel
                ? `<button type="button" class="btn btn-danger btn-sm" onclick="handleAdminCancelCita('${escapeHtml(c.id)}', ${reembolso80})">⚠️ Cancelar (80%: ${formatCOP(reembolso80)})</button>`
                : ''
            }
            ${
              canMarkRefunded
                ? `<button type="button" class="btn btn-success btn-sm" onclick="handleAdminMarkRefunded('${escapeHtml(c.id)}', ${reembolso80})">✅ Marcar 80% (${formatCOP(reembolso80)}) Reembolsado</button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert('Enlace privado de la clienta copiado al portapapeles.');
  } catch {
    prompt('Copia el enlace privado de la clienta:', text);
  }
}

async function handleAdminCancelCita(citaId, reembolso80) {
  if (
    !confirm(
      `¿Cancelar esta cita como Administradora?\nSe notificará por WhatsApp a la clienta y quedará pendiente el reembolso del 80% (${formatCOP(reembolso80)}).`
    )
  ) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/citas/${encodeURIComponent(citaId)}/cancelar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
      },
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo cancelar la cita');
    }
    await loadAdminData();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function handleAdminMarkRefunded(citaId, reembolso80) {
  if (
    !confirm(
      `¿Confirmas que ya transferiste el reembolso del 80% (${formatCOP(reembolso80)}) a la clienta?\nSe actualizará el estado a REEMBOLSADA y se enviará confirmación por WhatsApp.`
    )
  ) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/citas/${encodeURIComponent(citaId)}/reembolsar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
      },
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo actualizar el reembolso');
    }
    await loadAdminData();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ============================================================================
// 5. GESTIÓN DEL CATÁLOGO DE SERVICIOS DESDE EL PANEL DE MAMÁ
// ============================================================================
function renderAdminServices() {
  const container = document.getElementById('adminServicesList');
  if (state.adminServicios.length === 0) {
    container.innerHTML = `<div class="empty-state">No hay servicios en el catálogo.</div>`;
    return;
  }

  container.innerHTML = state.adminServicios
    .map((s) => {
      const reembolso80 = Math.round(s.precio_cop * 0.8);
      return `
        <div class="admin-item" style="opacity:${s.activo ? '1' : '0.6'}">
          <div class="admin-item-header">
            <div>
              <span class="service-cat-tag">${escapeHtml(s.categoria || 'General')}</span>
              <strong>${escapeHtml(s.nombre)}</strong>
            </div>
            <strong>${formatCOP(s.precio_cop)} (${s.duracion_minutos} min)</strong>
          </div>
          <div style="font-size:0.8rem; color:#687082;">${escapeHtml(s.descripcion)}</div>
          <div style="font-size:0.76rem; margin-top:0.25rem;">
            Estado: <strong>${s.activo ? 'Activo' : 'Inactivo'}</strong> · Reembolso 80%: ${formatCOP(reembolso80)}
          </div>
          <div class="admin-item-actions">
            <button type="button" class="btn btn-secondary btn-sm" onclick="startEditService(${s.id})">✏️ Editar</button>
            <button type="button" class="btn btn-danger-outline btn-sm" onclick="toggleServiceActive(${s.id}, ${s.activo ? 0 : 1})">
              ${s.activo ? 'Desactivar' : 'Activar'}
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function startEditService(id) {
  const srv = state.adminServicios.find((s) => Number(s.id) === Number(id));
  if (!srv) return;

  document.getElementById('srvEditId').value = String(srv.id);
  document.getElementById('srvCategoria').value = srv.categoria || 'General';
  document.getElementById('srvNombre').value = srv.nombre;
  document.getElementById('srvDescripcion').value = srv.descripcion;
  document.getElementById('srvDuracion').value = String(srv.duracion_minutos);
  document.getElementById('srvPrecio').value = String(srv.precio_cop);

  document.getElementById('btnSaveService').textContent = '💾 Actualizar Servicio';
  document.getElementById('btnCancelEditService').classList.remove('hidden');
}

function resetServiceForm() {
  document.getElementById('srvEditId').value = '';
  document.getElementById('adminServiceForm').reset();
  document.getElementById('srvDuracion').value = '60';
  document.getElementById('btnSaveService').textContent = '➕ Guardar Servicio';
  document.getElementById('btnCancelEditService').classList.add('hidden');
}

async function handleSaveService(event) {
  event.preventDefault();
  const editId = document.getElementById('srvEditId').value.trim();
  const payload = {
    categoria: document.getElementById('srvCategoria').value.trim(),
    nombre: document.getElementById('srvNombre').value.trim(),
    descripcion: document.getElementById('srvDescripcion').value.trim(),
    duracion_minutos: Number(document.getElementById('srvDuracion').value),
    precio_cop: Number(document.getElementById('srvPrecio').value),
    activo: 1,
  };

  const url = editId
    ? `${API_BASE}/api/servicios/${encodeURIComponent(editId)}`
    : `${API_BASE}/api/servicios`;
  const method = editId ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Error guardando el servicio');
    }

    resetServiceForm();
    await loadAdminData();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function toggleServiceActive(id, nuevoActivo) {
  try {
    const res = await fetch(`${API_BASE}/api/servicios/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
      },
      body: JSON.stringify({ activo: nuevoActivo }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo cambiar el estado del servicio');
    }
    await loadAdminData();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ============================================================================
// 6. ASISTENTE IA HÍBRIDO EN LA WEB & COTIZADOR DE UÑAS / CABELLO (AVISO A MAMÁ)
// ============================================================================
function openConciergeModal(initialTab = 'cotizar') {
  const modal = document.getElementById('conciergeModal');
  if (modal) {
    modal.classList.remove('hidden');
    switchConciergeTab(initialTab);
  }
}

function closeConciergeModal() {
  const modal = document.getElementById('conciergeModal');
  if (modal) modal.classList.add('hidden');
}

function switchConciergeTab(tab) {
  const isQuote = tab === 'cotizar';
  document.getElementById('cTabCotizar')?.classList.toggle('active', isQuote);
  document.getElementById('cTabChat')?.classList.toggle('active', !isQuote);
  document.getElementById('conciergePaneCotizar')?.classList.toggle('hidden', !isQuote);
  document.getElementById('conciergePaneChat')?.classList.toggle('hidden', isQuote);
}

async function handleQuoteSubmit(event) {
  event.preventDefault();
  const btn = document.getElementById('btnQuoteSubmit');
  const box = document.getElementById('quoteResultBox');

  const payload = {
    categoria: document.getElementById('quoteCategoria').value,
    cliente_nombre: document.getElementById('quoteNombre').value.trim(),
    cliente_telefono: document.getElementById('quoteTelefono').value.trim(),
    descripcion_diseno: document.getElementById('quoteDescripcion').value.trim(),
    fecha_tentativa: document.getElementById('quoteFecha').value.trim(),
  };

  btn.disabled = true;
  btn.textContent = 'Enviando cotización y avisando a nuestra especialista...';
  box.classList.add('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/cotizaciones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'No se pudo enviar la cotización.');
    }

    document.getElementById('quoteForm').reset();
    box.classList.remove('hidden');
    box.innerHTML = `
      <strong>✨ ¡Cotización enviada con éxito!</strong>
      <p style="margin-top:0.35rem;">${escapeHtml(data.mensaje)}</p>
      <p style="margin-top:0.3rem; font-size:0.8rem;">💰 <strong>${escapeHtml(data.estimado_orientativo)}</strong></p>
      <p style="margin-top:0.35rem; font-size:0.78rem;">¿Tienes foto de inspiración? Puedes enviarla directo a nuestro WhatsApp: <a href="https://wa.me/573124597896" target="_blank" rel="noopener" style="color:var(--pink-700); font-weight:700;">+57 312 459 7896</a></p>
    `;
  } catch (err) {
    box.classList.remove('hidden');
    box.innerHTML = `<div class="alert-error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '📲 Enviar Cotización y Avisar a la Especialista';
  }
}

function linkifySafeText(rawText) {
  const escaped = escapeHtml(rawText).replace(/\n/g, '<br />');
  return escaped.replace(
    /(https:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener" style="color:var(--pink-700); font-weight:700; text-decoration:underline;">$1</a>'
  );
}

async function handleWebChatSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('webChatInput');
  const btn = document.getElementById('btnWebChatSend');
  const box = document.getElementById('webChatMessages');
  if (!input || !box) return;

  const text = input.value.trim();
  if (!text) return;

  box.innerHTML += `
    <div class="chat-bubble chat-bubble-client">
      <div style="font-size:0.68rem; font-weight:800; opacity:0.75; margin-bottom:0.15rem;">Tú</div>
      <div>${escapeHtml(text)}</div>
    </div>
  `;
  box.scrollTop = box.scrollHeight;
  input.value = '';
  input.disabled = true;
  btn.disabled = true;

  const typingId = `typing_${Date.now()}`;
  box.innerHTML += `
    <div id="${typingId}" class="chat-bubble chat-bubble-bot">
      <em>Escribiendo... ✨</em>
    </div>
  `;
  box.scrollTop = box.scrollHeight;

  try {
    const res = await fetch(`${API_BASE}/api/chat-web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: state.webChatHistory,
      }),
    });
    const data = await res.json();
    document.getElementById(typingId)?.remove();

    const reply = data.reply || data.error || 'Ocurrió un error, intenta de nuevo.';
    state.webChatHistory.push({ role: 'user', text });
    state.webChatHistory.push({ role: 'model', text: reply });
    if (state.webChatHistory.length > 12) {
      state.webChatHistory = state.webChatHistory.slice(state.webChatHistory.length - 12);
    }

    box.innerHTML += `
      <div class="chat-bubble chat-bubble-bot">
        <div style="font-size:0.68rem; font-weight:800; opacity:0.75; margin-bottom:0.15rem;">Spa Superlook Concierge ✨</div>
        <div>${linkifySafeText(reply)}</div>
      </div>
    `;
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    document.getElementById(typingId)?.remove();
    box.innerHTML += `<div class="alert-error">${escapeHtml(err.message)}</div>`;
  } finally {
    input.disabled = false;
    btn.disabled = false;
    input.focus();
  }
}

window.addEventListener('DOMContentLoaded', initApp);
