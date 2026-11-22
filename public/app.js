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
  }
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

    resultBox.classList.remove('hidden');
    resultBox.innerHTML = `
      <h3 style="margin-bottom:0.4rem">✅ ¡Reserva Previa Creada (Pendiente de Pago)!</h3>
      <p style="margin-bottom:0.65rem">Tu horario ha sido bloqueado por <strong>20 minutos</strong>. Completa tu pago del 100% en Wompi para confirmar tu cita en <strong>Spa Superlook</strong>.</p>
      <div style="margin-bottom:0.75rem; font-size:0.83rem;">
        <div>• <strong>Servicio:</strong> ${escapeHtml(cita.servicio_nombre)}</div>
        <div>• <strong>Fecha/Hora:</strong> ${escapeHtml(formatDateTimeLocal(cita.fecha_hora_inicio))}</div>
        <div>• <strong>Referencia Wompi:</strong> <code>${escapeHtml(cita.wompi_reference)}</code></div>
        <div>• <strong>Total a pagar (100%):</strong> ${formatCOP(cita.monto_total)}</div>
        <div>• <strong>Reembolso 80% si cancelas:</strong> ${formatCOP(cita.monto_reembolso_80)} (Retención 20%: ${formatCOP(cita.monto_retencion_20)})</div>
      </div>
      <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
        <a href="${escapeHtml(data.payment_link)}" target="_blank" rel="noopener" class="btn btn-primary">
          💳 Pagar Ahora en Wompi (${formatCOP(cita.monto_total)})
        </a>
        <button type="button" class="btn btn-secondary" onclick="openPrivateCitaView('${escapeHtml(cita.id)}', '${escapeHtml(token)}')">
          🎟️ Ver / Gestionar Mi Reserva Privada
        </button>
      </div>
      <p style="margin-top:0.65rem; font-size:0.77rem; color:#383e4c;">
        🔒 Guarda tu enlace privado de gestión: <a href="${escapeHtml(manageUrl)}">${escapeHtml(manageUrl)}</a>
      </p>
    `;

    await loadAvailableSlots();
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
    await loadAdminData();
  } catch {
    state.adminToken = '';
    sessionStorage.removeItem('superlook_admin_token');
    loginCard.classList.remove('hidden');
    dashboardContent.classList.add('hidden');
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
  state.adminToken = '';
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
    renderAdminTurnosPorJornada();
    renderAdminCitas();
    renderAdminServices();
    await loadPublicServices();
  } catch (err) {
    console.error('Error cargando datos admin:', err);
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
  const filtroFecha = document.getElementById('adminFilterFecha')?.value || '';

  const filtradas = state.adminCitas
    .filter((c) => (filtroEstado === 'TODOS' ? true : c.estado === filtroEstado))
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
                const waPhone = String(c.cliente_telefono || '').replace(/\D/g, '');
                const waUrl = waPhone
                  ? `https://wa.me/${waPhone.startsWith('57') ? waPhone : '57' + waPhone}`
                  : '#';
                return `
                  <div class="ticket-mini-card">
                    <div class="admin-item-header">
                      <span class="ticket-time-pill">🗓️ ${escapeHtml(c._ymd)} · ⏰ ${escapeHtml(c._hhmm)}</span>
                      <span class="status-badge status-${escapeHtml(c.estado)}">${escapeHtml(c.estado)}</span>
                    </div>
                    <div style="font-weight:700; margin-top:0.25rem;">💇‍♀️ ${escapeHtml(c.servicio_nombre || 'Servicio')}</div>
                    <div>👤 ${escapeHtml(c.cliente_nombre)} · <a href="${escapeHtml(waUrl)}" target="_blank" rel="noopener" style="color:#157347; font-weight:700; text-decoration:none;">📲 ${escapeHtml(c.cliente_telefono)}</a></div>
                    <div style="font-size:0.77rem; color:#667085; margin-top:0.2rem;">
                      Ticket: <code>#${escapeHtml(c.id.slice(0, 8).toUpperCase())}</code> · Pago: <strong>${formatCOP(c.monto_total)}</strong> (80%: ${formatCOP(reembolso80)})
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

  const lista =
    filtro === 'TODOS'
      ? state.adminCitas
      : state.adminCitas.filter((c) => c.estado === filtro);

  if (lista.length === 0) {
    container.innerHTML = `<div class="empty-state">No hay citas registradas para este filtro.</div>`;
    return;
  }

  container.innerHTML = lista
    .map((c) => {
      const reembolso80 = c.monto_reembolso_80 || Math.round(c.monto_total * 0.8);
      const retencion20 = c.monto_total - reembolso80;
      const canCancel = c.estado === 'CONFIRMADA' || c.estado === 'PENDIENTE_PAGO';
      const canMarkRefunded = c.estado === 'REEMBOLSO_MANUAL_PENDIENTE';

      return `
        <div class="admin-item">
          <div class="admin-item-header">
            <strong>${escapeHtml(c.cliente_nombre)} (${escapeHtml(c.cliente_telefono)})</strong>
            <span class="status-badge status-${escapeHtml(c.estado)}">${escapeHtml(c.estado)}</span>
          </div>
          <div>💇‍♀️ <strong>${escapeHtml(c.servicio_nombre || 'Servicio')}</strong> · 🗓️ ${escapeHtml(formatDateTimeLocal(c.fecha_hora_inicio))}</div>
          <div>💳 Total (100%): <strong>${formatCOP(c.monto_total)}</strong> | Retención (20%): <strong>${formatCOP(retencion20)}</strong> | Reembolso (80%): <strong style="color:#185170;">${formatCOP(reembolso80)}</strong></div>
          <div style="font-size:0.76rem; color:#687082;">Ref Wompi: <code>${escapeHtml(c.wompi_reference || 'N/A')}</code> · ID: <code>${escapeHtml(c.id)}</code></div>
          <div class="admin-item-actions">
            ${
              c.client_manage_url
                ? `<button type="button" class="btn btn-secondary btn-sm" onclick="copyTextToClipboard('${escapeHtml(c.client_manage_url)}')">🔗 Copiar Link Clienta</button>`
                : ''
            }
            ${
              canCancel
                ? `<button type="button" class="btn btn-danger btn-sm" onclick="handleAdminCancelCita('${escapeHtml(c.id)}', ${reembolso80})">⚠️ Cancelar (Reembolsar 80%: ${formatCOP(reembolso80)})</button>`
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

window.addEventListener('DOMContentLoaded', initApp);
