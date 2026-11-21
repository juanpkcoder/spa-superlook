/**
 * Adaptador compatible con la interfaz D1Database de Cloudflare Workers
 * respaldado por Supabase PostgreSQL (vía RPC `public.d1_exec` sobre HTTPS fetch).
 * Permite que el mismo código Hono funcione sin cambios tanto en Cloudflare Workers + D1
 * como en Vercel + Supabase.
 */
export function createSupabaseD1Adapter(
  supabaseUrl: string,
  supabaseServiceRoleKey: string
): D1Database {
  const cleanUrl = supabaseUrl.replace(/\/$/, '');

  async function callRpc(
    sql: string,
    params: unknown[]
  ): Promise<{ results: unknown[]; changes: number; last_row_id: number }> {
    const response = await fetch(`${cleanUrl}/rest/v1/rpc/d1_exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
      },
      body: JSON.stringify({
        sql_query: sql,
        sql_params: params,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Supabase D1 RPC error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      results?: unknown[];
      changes?: number;
      last_row_id?: number;
    };

    return {
      results: Array.isArray(data?.results) ? data.results : [],
      changes: Number(data?.changes || 0),
      last_row_id: Number(data?.last_row_id || 0),
    };
  }

  const db = {
    prepare(query: string) {
      let boundParams: unknown[] = [];

      const statement = {
        bind(...values: unknown[]) {
          boundParams = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          const res = await callRpc(query, boundParams);
          return {
            results: res.results as T[],
            success: true,
            meta: {
              duration: 1,
              changes: res.changes,
              last_row_id: res.last_row_id,
              changed_db: res.changes > 0,
              size_after: 0,
              rows_read: res.results.length,
              rows_written: res.changes,
            },
          };
        },
        async first<T = Record<string, unknown>>(colName?: string) {
          const res = await callRpc(query, boundParams);
          const firstRow = (res.results[0] as Record<string, unknown>) || null;
          if (!firstRow) return null;
          if (colName) return (firstRow[colName] as T) ?? null;
          return firstRow as T;
        },
        async run() {
          const res = await callRpc(query, boundParams);
          return {
            results: [],
            success: true,
            meta: {
              duration: 1,
              changes: res.changes,
              last_row_id: res.last_row_id,
              changed_db: res.changes > 0,
              size_after: 0,
              rows_read: 0,
              rows_written: res.changes,
            },
          };
        },
        async raw<T = unknown[]>() {
          const res = await callRpc(query, boundParams);
          return res.results.map((r) =>
            Object.values(r as Record<string, unknown>)
          ) as unknown as T[];
        },
      };

      return statement;
    },
    async batch(statements: Array<{ all: () => Promise<unknown> }>) {
      const out = [];
      for (const st of statements) {
        out.push(await st.all());
      }
      return out;
    },
    async exec(query: string) {
      await callRpc(query, []);
      return { count: 1, duration: 1 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  };

  return db as unknown as D1Database;
}
