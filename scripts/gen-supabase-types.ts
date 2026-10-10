// Generates src/integrations/supabase/types.ts from a PostgreSQL database that has every migration applied,
// in the same shape as `supabase gen types typescript` (used when the Supabase CLI / Docker isn't available).
//   TYPES_DATABASE_URL=postgres://... tsx scripts/gen-supabase-types.ts > src/integrations/supabase/types.ts
// With no URL it creates a throwaway database from the shim + migrations (needs TEST_DATABASE_URL server).
import postgres from "postgres";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { applyFile, createDb } from "../supabase/tests/db/harness";

type Col = {
  table: string;
  name: string;
  type: string;
  udt: string;
  nullable: boolean;
  has_default: boolean;
  identity: boolean;
  ndims: number;
};

const SCALAR: Record<string, string> = {
  int2: "number",
  int4: "number",
  int8: "number",
  float4: "number",
  float8: "number",
  numeric: "number",
  bool: "boolean",
  json: "Json",
  jsonb: "Json",
  text: "string",
  varchar: "string",
  bpchar: "string",
  uuid: "string",
  date: "string",
  timestamp: "string",
  timestamptz: "string",
  time: "string",
  interval: "string",
  bytea: "string",
  regprocedure: "string",
  tstzrange: "string",
};

async function main() {
  let url = process.env["TYPES_DATABASE_URL"];
  let cleanup: (() => Promise<void>) | null = null;
  if (!url) {
    const db = await createDb({ label: "types" });
    // Tables Lovable manages with drizzle (e.g. contact_messages) live in the same schema.
    const dir = join(import.meta.dirname, "..", "drizzle", "migrations");
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await applyFile(db.sql, join(dir, f));
    const u = new URL(
      process.env["TEST_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:54329/postgres",
    );
    u.pathname = `/${db.name}`;
    url = u.toString();
    cleanup = () => db.drop();
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const enums = await sql<{ name: string; labels: string[] }[]>`
    select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' group by t.typname order by t.typname`;
  const enumNames = new Set(enums.map((e) => e.name));
  const ts = (udt: string, ndims = 0): string => {
    const base = udt.startsWith("_") ? udt.slice(1) : udt;
    const arr = udt.startsWith("_") || ndims > 0;
    const t = enumNames.has(base)
      ? `Database["public"]["Enums"]["${base}"]`
      : (SCALAR[base] ?? "unknown");
    return arr ? `${t}[]` : t;
  };

  const tables = await sql<{ name: string; kind: string }[]>`
    select c.relname as name, c.relkind as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p') order by c.relname`;
  const cols = await sql<Col[]>`
    select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, t.typname as udt,
           not a.attnotnull as nullable, a.atthasdef as has_default, a.attidentity <> '' as identity, a.attndims as ndims
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace join pg_type t on t.oid = a.atttypid
     where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'v', 'm', 'p')
     order by c.relname, a.attname`;
  const fks = await sql<
    { table: string; name: string; cols: string[]; ref: string; refcols: string[]; one: boolean }[]
  >`
    select c.relname as table, con.conname as name,
           array(select attname from pg_attribute where attrelid = con.conrelid and attnum = any(con.conkey) order by attnum) as cols,
           rc.relname as ref,
           array(select attname from pg_attribute where attrelid = con.confrelid and attnum = any(con.confkey) order by attnum) as refcols,
           exists (select 1 from pg_index i where i.indrelid = con.conrelid and i.indisunique and i.indpred is null
                     and (select array_agg(k::int order by k) from unnest(i.indkey) k) = (select array_agg(k::int order by k) from unnest(con.conkey) k)) as one
      from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_class rc on rc.oid = con.confrelid
      join pg_namespace n on n.oid = c.relnamespace
     where con.contype = 'f' and n.nspname = 'public' order by c.relname, con.conname`;
  const fns = await sql<
    {
      name: string;
      argnames: string[] | null;
      argtypes: string[];
      argmodes: string[] | null;
      allargtypes: string[] | null;
      ret: string;
      retset: boolean;
      rettyp: string;
      retrel: string | null;
      defaults: number;
    }[]
  >`
    select p.proname as name, p.proargnames as argnames,
           array(select t.typname from unnest(p.proargtypes) x join pg_type t on t.oid = x) as argtypes,
           p.proargmodes::text[] as argmodes,
           array(select t.typname from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality x(o, i) join pg_type t on t.oid = x.o order by i) as allargtypes,
           rt.typname as ret, p.proretset as retset, rt.typtype as rettyp,
           (select c.relname from pg_class c where c.oid = rt.typrelid and c.relkind in ('r', 'v', 'p')) as retrel,
           p.pronargdefaults as defaults
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type rt on rt.oid = p.prorettype
     where n.nspname = 'public' and rt.typname <> 'trigger' and p.prokind = 'f' and left(p.proname, 1) <> '_'
     order by p.proname`;

  const out: string[] = [];
  const colsOf = (t: string) => cols.filter((c) => c.table === t);
  const rowType = (t: string, ind: string) =>
    colsOf(t)
      .map((c) => `${ind}${c.name}: ${ts(c.udt, c.ndims)}${c.nullable ? " | null" : ""}`)
      .join("\n");
  out.push(`export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {`);
  for (const t of tables.filter((x) => x.kind === "r" || x.kind === "p")) {
    const cs = colsOf(t.name);
    out.push(`      ${t.name}: {
        Row: {
${rowType(t.name, "          ")}
        }
        Insert: {
${cs.map((c) => `          ${c.name}${c.nullable || c.has_default || c.identity ? "?" : ""}: ${ts(c.udt, c.ndims)}${c.nullable ? " | null" : ""}`).join("\n")}
        }
        Update: {
${cs.map((c) => `          ${c.name}?: ${ts(c.udt, c.ndims)}${c.nullable ? " | null" : ""}`).join("\n")}
        }
        Relationships: [${fks
          .filter((f) => f.table === t.name)
          .map(
            (f) => `
          {
            foreignKeyName: "${f.name}"
            columns: [${f.cols.map((c) => `"${c}"`).join(", ")}]
            isOneToOne: ${f.one}
            referencedRelation: "${f.ref}"
            referencedColumns: [${f.refcols.map((c) => `"${c}"`).join(", ")}]
          },`,
          )
          .join("")}${fks.some((f) => f.table === t.name) ? "\n        " : ""}]
      }`);
  }
  out.push(`    }
    Views: {
      [_ in never]: never
    }
    Functions: {`);
  for (const f of fns) {
    const modes = f.argmodes ?? f.allargtypes!.map(() => "i");
    const names = f.argnames ?? [];
    const inputs = (f.allargtypes ?? f.argtypes)
      .map((t, i) => ({ t, n: names[i] ?? `arg${i}`, m: modes[i] ?? "i" }))
      .filter((a) => a.m === "i" || a.m === "b");
    const outputs = (f.allargtypes ?? [])
      .map((t, i) => ({ t, n: names[i] ?? `col${i}`, m: modes[i] ?? "i" }))
      .filter((a) => a.m === "t" || a.m === "o");
    const firstDefault = inputs.length - f.defaults;
    const args = inputs.length
      ? `{ ${inputs.map((a, i) => `${a.n}${i >= firstDefault ? "?" : ""}: ${ts(a.t)}`).join("; ")} }`
      : "never";
    let ret: string;
    let setof = "";
    if (outputs.length)
      ret = `{\n${outputs.map((o) => `          ${o.n}: ${ts(o.t)}`).join("\n")}\n        }[]`;
    else if (f.retrel) {
      ret = `{\n${rowType(f.retrel, "          ")}\n        }${f.retset ? "[]" : ""}`;
      setof = `\n        SetofOptions: {\n          from: "*"\n          to: "${f.retrel}"\n          isOneToOne: ${!f.retset}\n          isSetofReturn: ${f.retset}\n        }`;
    } else ret = `${ts(f.ret)}${f.retset ? "[]" : ""}`;
    out.push(`      ${f.name}: {
        Args: ${args}
        Returns: ${ret}${setof}
      }`);
  }
  out.push(`    }
    Enums: {
${enums.map((e) => `      ${e.name}: ${e.labels.map((l) => `"${l}"`).join(" | ")}`).join("\n")}
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
`);
  out.push(
    TAIL.replace(
      "__ENUMS__",
      enums
        .map((e) => `      ${e.name}: [${e.labels.map((l) => `"${l}"`).join(", ")}],`)
        .join("\n"),
    ),
  );
  process.stdout.write(out.join("\n"));
  await sql.end();
  if (cleanup) await cleanup();
}

const TAIL = `type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
__ENUMS__
    },
  },
} as const
`;

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
