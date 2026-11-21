-- ============================================================================
-- MIGRACIÓN SUPABASE (PostgreSQL) - SPA SUPERLOOK (COLOMBIA)
-- Compatible 100% con el esquema de Cloudflare D1 y el adaptador RPC d1_exec
-- ============================================================================

DROP TABLE IF EXISTS public.citas CASCADE;
DROP TABLE IF EXISTS public.servicios CASCADE;
DROP TABLE IF EXISTS public.chat_sesiones CASCADE;

-- 1. Tabla de servicios de Spa Superlook (organizados por categoría)
CREATE TABLE public.servicios (
  id SERIAL PRIMARY KEY,
  categoria TEXT NOT NULL DEFAULT 'General',
  nombre TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  duracion_minutos INTEGER NOT NULL,
  precio_cop INTEGER NOT NULL,
  activo INTEGER DEFAULT 1
);

-- 2. Tabla de citas y estado de pagos / reembolsos (80% devolución / 20% retención)
CREATE TABLE public.citas (
  id TEXT PRIMARY KEY,
  cliente_nombre TEXT NOT NULL,
  cliente_telefono TEXT NOT NULL,
  servicio_id INTEGER NOT NULL REFERENCES public.servicios(id),
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
  created_at TEXT NOT NULL
);

CREATE INDEX idx_citas_fechas ON public.citas(fecha_hora_inicio, fecha_hora_fin);
CREATE INDEX idx_citas_estado ON public.citas(estado);
CREATE INDEX idx_citas_wompi_reference ON public.citas(wompi_reference);

-- 3. Tabla de sesiones de conversación del Bot de WhatsApp (Gemini)
CREATE TABLE public.chat_sesiones (
  telefono TEXT PRIMARY KEY,
  historial_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Activar Row Level Security (RLS) para que solo el backend (service_role) acceda
ALTER TABLE public.servicios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.citas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sesiones ENABLE ROW LEVEL SECURITY;

-- 4. Función RPC segura (solo accesible por service_role) para el adaptador D1 en Vercel
CREATE OR REPLACE FUNCTION public.d1_exec(
  sql_query text,
  sql_params jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  final_sql text := sql_query;
  param_count int := COALESCE(jsonb_array_length(sql_params), 0);
  i int;
  elem jsonb;
  elem_type text;
  replacement text;
  trimmed_upper text;
  res_rows jsonb := '[]'::jsonb;
  affected int := 0;
  inserted_id int := 0;
BEGIN
  -- Reemplazar ?N de mayor a menor para no colisionar ?10 con ?1
  FOR i IN REVERSE param_count..1 LOOP
    elem := sql_params -> (i - 1);
    elem_type := jsonb_typeof(elem);
    IF elem_type = 'null' THEN
      replacement := 'NULL';
    ELSIF elem_type = 'number' THEN
      replacement := elem #>> '{}';
    ELSIF elem_type = 'boolean' THEN
      replacement := CASE WHEN (elem::boolean) THEN '1' ELSE '0' END;
    ELSE
      replacement := quote_literal(elem #>> '{}');
    END IF;
    final_sql := replace(final_sql, '?' || i::text, replacement);
  END LOOP;

  trimmed_upper := upper(btrim(final_sql));

  IF trimmed_upper LIKE 'SELECT%' THEN
    EXECUTE 'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (' || final_sql || ') t'
      INTO res_rows;
    RETURN jsonb_build_object(
      'results', COALESCE(res_rows, '[]'::jsonb),
      'changes', jsonb_array_length(COALESCE(res_rows, '[]'::jsonb)),
      'last_row_id', 0
    );
  ELSIF trimmed_upper LIKE 'INSERT INTO SERVICIOS%' THEN
    EXECUTE final_sql || ' RETURNING id' INTO inserted_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN jsonb_build_object(
      'results', '[]'::jsonb,
      'changes', affected,
      'last_row_id', COALESCE(inserted_id, 0)
    );
  ELSE
    EXECUTE final_sql;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN jsonb_build_object(
      'results', '[]'::jsonb,
      'changes', affected,
      'last_row_id', 0
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.d1_exec(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.d1_exec(text, jsonb) TO service_role;

-- 5. Semillas iniciales de servicios
INSERT INTO public.servicios (categoria, nombre, descripcion, duracion_minutos, precio_cop, activo) VALUES
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
