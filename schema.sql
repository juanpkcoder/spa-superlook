-- ============================================================================
-- MIGRACIÓN CLOUDFLARE D1 (SQLite) - SPA SUPERLOOK (COLOMBIA)
-- Ejecutar local:  npx wrangler d1 execute estetica-db --local --file=./schema.sql
-- Ejecutar remoto: npx wrangler d1 execute estetica-db --remote --file=./schema.sql
-- ============================================================================

DROP TABLE IF EXISTS citas;
DROP TABLE IF EXISTS servicios;
DROP TABLE IF EXISTS chat_sesiones;

-- 1. Tabla de servicios de Spa Superlook (organizados por categoría)
CREATE TABLE servicios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  categoria TEXT NOT NULL DEFAULT 'General',
  nombre TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  duracion_minutos INTEGER NOT NULL,
  precio_cop INTEGER NOT NULL,
  activo INTEGER DEFAULT 1
);

-- 2. Tabla de citas y estado de pagos / reembolsos (80% devolución / 20% retención)
CREATE TABLE citas (
  id TEXT PRIMARY KEY,
  cliente_nombre TEXT NOT NULL,
  cliente_telefono TEXT NOT NULL,
  servicio_id INTEGER NOT NULL,
  fecha_hora_inicio TEXT NOT NULL,
  fecha_hora_fin TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (
    estado IN (
      'PENDIENTE_PAGO',
      'CONFIRMADA',
      'CANCELADA',
      'REEMBOLSO_MANUAL_PENDIENTE',
      'REEMBOLSADA'
    )
  ),
  monto_total INTEGER NOT NULL,
  monto_reembolso_80 INTEGER NOT NULL,
  wompi_reference TEXT UNIQUE,
  wompi_transaction_id TEXT,
  metodo_pago TEXT,
  recordatorio_24h INTEGER DEFAULT 0,
  recordatorio_2h INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (servicio_id) REFERENCES servicios(id)
);

CREATE INDEX idx_citas_fechas ON citas(fecha_hora_inicio, fecha_hora_fin);
CREATE INDEX idx_citas_estado ON citas(estado);
CREATE INDEX idx_citas_wompi_reference ON citas(wompi_reference);

-- 3. Tabla de sesiones de conversación del Bot de WhatsApp (Gemini)
CREATE TABLE chat_sesiones (
  telefono TEXT PRIMARY KEY,
  historial_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- SEMILLAS INICIALES DE SERVICIOS (SE ACTUALIZARÁN CON EL CATÁLOGO OFICIAL)
-- ============================================================================
INSERT INTO servicios (categoria, nombre, descripcion, duracion_minutos, precio_cop, activo) VALUES
  (
    'Facial & Spa',
    'Limpieza Facial Profunda',
    'Higienización ultrasónica, extracción de impurezas, mascarilla hidroplástica y fototerapia LED.',
    60,
    120000,
    1
  ),
  (
    'Mirada & Cejas',
    'Diseño de Cejas + Laminado HD',
    'Visagismo facial, perfilado con hilo orgánico, sombreado temporal con henna y nutrición.',
    45,
    65000,
    1
  ),
  (
    'Uñas & Spa',
    'Manicure Semipermanente Spa',
    'Manicure ruso suave, exfoliación hidratante y esmaltado en gel de larga duración (21 días).',
    60,
    55000,
    1
  );
