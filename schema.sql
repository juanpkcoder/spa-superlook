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
-- CATÁLOGO OFICIAL REAL DE SERVICIOS - SPA SUPERLOOK (EXTRAÍDO DE AUDIOS MAMÁ)
-- ============================================================================
INSERT INTO servicios (categoria, nombre, descripcion, duracion_minutos, precio_cop, activo) VALUES
  -- 1. UÑAS & MANICURE
  (
    'Uñas & Manicure',
    'Manicure Tradicional',
    'Limpieza profunda de cutícula, limado, exfoliación suave, hidratación y esmaltado tradicional. Mantenimiento sugerido cada 25 días.',
    45,
    22000,
    1
  ),
  (
    'Uñas & Manicure',
    'Manicure Semipermanente Unicolor',
    'Manicure detallado y esmaltado semipermanente en tono plano de larga duración (21–25 días). Tarifa base sin decoración.',
    60,
    25000,
    1
  ),
  (
    'Uñas & Manicure',
    'Manicure Semipermanente con Diseño',
    'Esmaltado semipermanente con decoración personalizada o nail art. Tarifa establecida promedio (rango $25.000–$60.000 según diseño o retiro; cotizable con foto).',
    75,
    45000,
    1
  ),
  (
    'Uñas & Manicure',
    'Uñas en Acrílico (Esculpidas)',
    'Extensión y estructura resistente en acrílico con acabado profesional. Tarifa base (rango $60.000–$90.000 según largo y diseño; envíanos foto para cotización exacta).',
    120,
    65000,
    1
  ),
  (
    'Uñas & Manicure',
    'Uñas Soft Gel / Press-On',
    'Sistema Soft Gel / Press-On liviano, elegante y de acabado natural. Tarifa base (rango $75.000–$100.000 según largo y decoración; cotizable con foto).',
    90,
    75000,
    1
  ),
  (
    'Uñas & Manicure',
    'Extensiones en Gel / Poligel',
    'Extensión y refuerzo en gel o poligel de alta durabilidad y ligereza. Tarifa base (rango $75.000–$110.000 según largo y diseño; cotizable con foto).',
    120,
    80000,
    1
  ),

  -- 2. PEDICURE & SPA PIES
  (
    'Pedicure & Spa Pies',
    'Pedicure Esmaltado Tradicional',
    'Limpieza profunda de pies, exfoliación, retiro de durezas, hidratación y esmaltado tradicional.',
    50,
    28000,
    1
  ),
  (
    'Pedicure & Spa Pies',
    'Pedicure Esmaltado Semipermanente',
    'Pedicure spa completo con esmaltado semipermanente de larga duración (rango $40.000–$55.000 según diseño; cotizable con foto).',
    65,
    40000,
    1
  ),

  -- 3. TRATAMIENTOS CAPILARES
  (
    'Tratamientos Capilares',
    'Keratina (Alisado Profesional)',
    'Alisado profesional y control profundo de frizz con brillo espejo. Tarifa base cabello corto/medio ($160.000–$320.000 según largo y volumen; cotizable con foto).',
    180,
    160000,
    1
  ),
  (
    'Tratamientos Capilares',
    'Cirugía Capilar',
    'Reconstrucción intensiva, sellado de cutícula y reducción de volumen y frizz. Tarifa base ($140.000–$280.000 según largo y abundancia; cotizable con foto).',
    150,
    140000,
    1
  ),
  (
    'Tratamientos Capilares',
    'Laminado Capilar',
    'Sellado térmico efecto espejo para suavidad extrema, hidratación y brillo seda. Tarifa base ($95.000–$180.000 según largo del cabello; cotizable con foto).',
    90,
    95000,
    1
  ),
  (
    'Tratamientos Capilares',
    'Ampolleta de Reestructuración Capilar',
    'Terapia intensiva de nutrición y reparación profunda de la fibra capilar maltratada o procesada.',
    45,
    45000,
    1
  ),

  -- 4. CABELLO, CORTE & COLOR
  (
    'Cabello, Corte & Color',
    'Corte de Cabello & Asesoría de Imagen',
    'Diagnóstico capilar, asesoría de imagen personalizada según tu rostro y corte profesional con lavado y secado.',
    45,
    35000,
    1
  ),
  (
    'Cabello, Corte & Color',
    'Analogía de Color / Colorimetría',
    'Asesoría cromática personalizada, tintura global o retoque de color profesional. Tarifa base ($110.000–$220.000 según largo y cantidad de tinte; cotizable con foto).',
    120,
    110000,
    1
  ),
  (
    'Cabello, Corte & Color',
    'Balayage Profesional',
    'Técnica degradada de iluminación a mano alzada con matización y protección capilar. Tarifa base ($220.000–$420.000 según largo, base actual y tono; cotizable con foto).',
    210,
    220000,
    1
  ),
  (
    'Cabello, Corte & Color',
    'Babylights (Baby Highlights)',
    'Micro-reflejos ultrafinos de efecto natural y luminoso con matización profesional. Tarifa base ($190.000–$360.000 según largo y abundancia; cotizable con foto).',
    180,
    190000,
    1
  ),
  (
    'Cabello, Corte & Color',
    'Mechas / Iluminaciones / Rayitos',
    'Diseño de mechas, iluminaciones o rayitos personalizados según tu colorimetría. Tarifa base ($160.000–$320.000 según largo y técnica; cotizable con foto).',
    165,
    160000,
    1
  ),

  -- 5. PESTAÑAS & MIRADA
  (
    'Pestañas & Mirada',
    'Pestañas en Tira (Aplicación Profesional)',
    'Postura profesional de pestañas en tira adaptadas a la forma de tu ojo, ideales para eventos y ocasiones especiales.',
    20,
    25000,
    1
  ),
  (
    'Pestañas & Mirada',
    'Pestañas Punto a Punto',
    'Aplicación de racimos ligeros punto a punto para realce y volumen inmediato en la mirada.',
    40,
    40000,
    1
  ),
  (
    'Pestañas & Mirada',
    'Extensiones de Pestañas Pelo a Pelo (Efecto Natural)',
    'Extensión clásica fibra por fibra con acabado sutil, elegante y natural adaptado a tus pestañas.',
    105,
    85000,
    1
  ),
  (
    'Pestañas & Mirada',
    'Extensiones de Pestañas Volumen 3D',
    'Diseño de abanicos ligeros 3D para una mirada más densa, definida y glamorosa sin maltratar tu pestaña natural.',
    120,
    115000,
    1
  );
