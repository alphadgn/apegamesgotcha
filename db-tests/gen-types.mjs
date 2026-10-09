// Regenerates src/integrations/supabase/types.ts from a database built from the repo's migrations
// (same shape as `supabase gen types typescript`). Usage: node gen-types.mjs [--check]
//   Builds a fresh database from supabase/migrations, introspects the public schema, and writes the file.
//   --check exits 1 if the committed file differs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PG, createDatabase, dropDatabase } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "src", "integrations", "supabase", "types.ts");
const NAME = "gotcha_typegen";

await createDatabase(NAME);
const c = new pg.Client({ ...PG, database: NAME });
await c.connect();

const enums = (await c.query(`
  select t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as values
    from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public' group by t.typname order by t.typname`)).rows;
const enumNames = new Set(enums.map((e) => e.name));

function tsType(udt, isArray = false) {
  const base = (() => {
    if (enumNames.has(udt)) return `Database["public"]["Enums"]["${udt}"]`;
    switch (udt) {
      case "int2": case "int4": case "int8": case "float4": case "float8": case "numeric": return "number";
      case "bool": return "boolean";
      case "json": case "jsonb": return "Json";
      case "text": case "varchar": case "bpchar": case "uuid": case "date": case "timestamptz": case "timestamp":
      case "time": case "timetz": case "interval": case "bytea": case "inet": case "citext": case "name": return "string";
      case "void": return "undefined";
      default: return "unknown";
    }
  })();
  return isArray ? `${base}[]` : base;
}

const cols = (await c.query(`
  select c.table_name, c.column_name, c.is_nullable = 'YES' as nullable, c.column_default is not null or c.is_identity = 'YES' as has_default,
         c.data_type = 'ARRAY' as is_array, case when c.data_type = 'ARRAY' then substr(c.udt_name, 2) else c.udt_name end as udt,
         c.is_generated = 'ALWAYS' as generated
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
   order by c.table_name, c.column_name`)).rows;
const tables = new Map();
for (const r of cols) {
  if (!tables.has(r.table_name)) tables.set(r.table_name, []);
  tables.get(r.table_name).push(r);
}

const fks = (await c.query(`
  select con.conname as name, rel.relname as tbl, frel.relname as ref,
         (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns,
         (select array_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as ref_columns,
         exists (select 1 from pg_index i where i.indrelid = con.conrelid and i.indisunique and i.indpred is null
                  and (select array_agg(x order by x) from unnest(i.indkey::int2[]) x) = (select array_agg(x order by x) from unnest(con.conkey) x)) as one_to_one
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid join pg_namespace n on n.oid = rel.relnamespace
    join pg_class frel on frel.oid = con.confrelid join pg_namespace fn on fn.oid = frel.relnamespace
   where con.contype = 'f' and n.nspname = 'public' and fn.nspname = 'public'
   order by con.conname`)).rows;

const funcs = (await c.query(`
  select p.proname as name, p.oid,
         coalesce(p.proargnames, '{}') as argnames, coalesce(p.proargmodes::text[], '{}') as argmodes,
         (select array_agg(format_type(t, null)::text order by i) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality u(t, i)) as argtypes,
         (select array_agg(tt.typname::text order by i) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality u(t, i) join pg_type tt on tt.oid = u.t) as argudts,
         p.pronargdefaults as ndefaults, p.pronargs as nargs, p.proretset as retset,
         rt.typname as rettype, rt.typtype as rettyptype, rt.typrelid as retrelid,
         (select relname from pg_class where oid = rt.typrelid) as retrel
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type rt on rt.oid = p.prorettype
   where n.nspname = 'public' and rt.typname <> 'trigger' and p.prokind = 'f'
   order by p.proname`)).rows;

const ind = (n) => "  ".repeat(n);
const key = (k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k));

function rowFields(tbl, depth) {
  return tables.get(tbl).map((col) => `${ind(depth)}${key(col.column_name)}: ${tsType(col.udt, col.is_array)}${col.nullable ? " | null" : ""}`).join("\n");
}

let out = `export type Json =
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
    Tables: {
`;
for (const [tbl, columns] of [...tables.entries()].sort()) {
  out += `${ind(3)}${key(tbl)}: {\n${ind(4)}Row: {\n${rowFields(tbl, 5)}\n${ind(4)}}\n`;
  for (const kind of ["Insert", "Update"]) {
    out += `${ind(4)}${kind}: {\n`;
    for (const col of columns) {
      if (col.generated) { out += `${ind(5)}${key(col.column_name)}?: never\n`; continue; }
      const optional = kind === "Update" || col.nullable || col.has_default;
      out += `${ind(5)}${key(col.column_name)}${optional ? "?" : ""}: ${tsType(col.udt, col.is_array)}${col.nullable ? " | null" : ""}\n`;
    }
    out += `${ind(4)}}\n`;
  }
  const rels = fks.filter((f) => f.tbl === tbl);
  if (!rels.length) out += `${ind(4)}Relationships: []\n`;
  else {
    out += `${ind(4)}Relationships: [\n`;
    for (const f of rels) {
      out += `${ind(5)}{\n${ind(6)}foreignKeyName: "${f.name}"\n${ind(6)}columns: [${f.columns.map((x) => `"${x}"`).join(", ")}]\n${ind(6)}isOneToOne: ${f.one_to_one}\n${ind(6)}referencedRelation: "${f.ref}"\n${ind(6)}referencedColumns: [${f.ref_columns.map((x) => `"${x}"`).join(", ")}]\n${ind(5)}},\n`;
    }
    out += `${ind(4)}]\n`;
  }
  out += `${ind(3)}}\n`;
}
out += `${ind(2)}}\n${ind(2)}Views: {\n${ind(3)}[_ in never]: never\n${ind(2)}}\n${ind(2)}Functions: {\n`;
for (const f of funcs) {
  const names = f.argnames;
  const modes = f.argmodes.length ? f.argmodes : Array(f.argtypes?.length ?? 0).fill("i");
  const inArgs = [];
  const outCols = [];
  (f.argtypes ?? []).forEach((t, i) => {
    const m = modes[i] ?? "i";
    const udt = f.argudts[i];
    const isArr = t.endsWith("[]");
    const base = isArr ? udt.replace(/^_/, "") : udt;
    if (m === "i" || m === "b") inArgs.push({ name: names[i], type: tsType(base, isArr) });
    if (m === "t" || m === "o" || m === "b") outCols.push({ name: names[i], type: tsType(base, isArr) });
  });
  const firstDefault = f.nargs - f.ndefaults;
  const args = inArgs.length
    ? `{ ${inArgs.map((a, i) => `${key(a.name)}${i >= firstDefault ? "?" : ""}: ${a.type}`).join("; ")} }`
    : "never";
  let returns;
  let setof = "";
  if (outCols.length) {
    returns = `{\n${outCols.map((o) => `${ind(5)}${key(o.name)}: ${o.type}`).join("\n")}\n${ind(4)}}[]`;
  } else if (f.rettyptype === "c" && f.retrel && tables.has(f.retrel)) {
    returns = `{\n${rowFields(f.retrel, 5)}\n${ind(4)}}${f.retset ? "[]" : ""}`;
    setof = `\n${ind(4)}SetofOptions: {\n${ind(5)}from: "*"\n${ind(5)}to: "${f.retrel}"\n${ind(5)}isOneToOne: ${!f.retset}\n${ind(5)}isSetofReturn: ${f.retset}\n${ind(4)}}`;
  } else {
    const isArr = f.rettype.startsWith("_");
    returns = tsType(isArr ? f.rettype.slice(1) : f.rettype, isArr) + (f.retset ? "[]" : "");
  }
  out += `${ind(3)}${key(f.name)}: {\n${ind(4)}Args: ${args}\n${ind(4)}Returns: ${returns}${setof}\n${ind(3)}}\n`;
}
out += `${ind(2)}}\n${ind(2)}Enums: {\n`;
for (const e of enums) out += `${ind(3)}${e.name}: ${e.values.map((v) => JSON.stringify(v)).join(" | ")}\n`;
out += `${ind(2)}}\n${ind(2)}CompositeTypes: {\n${ind(3)}[_ in never]: never\n${ind(2)}}\n  }\n}\n`;

// Keep the helper types exactly as the Supabase generator writes them.
const current = readFileSync(OUT, "utf8");
const tail = current.slice(current.indexOf("type DatabaseWithoutInternals"));
const constantsEnums = enums.map((e) => `      ${e.name}: [${e.values.map((v) => JSON.stringify(v)).join(", ")}],`).join("\n");
const fixedTail = tail.replace(/export const Constants = \{[\s\S]*$/, `export const Constants = {\n  public: {\n    Enums: {\n${constantsEnums}\n    },\n  },\n} as const\n`);
const next = out + "\n" + fixedTail;

await c.end();
await dropDatabase(NAME);

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("types.ts is out of date — run: node db-tests/gen-types.mjs");
    process.exit(1);
  }
  console.log("types.ts is up to date");
} else {
  writeFileSync(OUT, next);
  console.log(`wrote ${OUT}: ${tables.size} tables, ${funcs.length} functions, ${enums.length} enums`);
}
