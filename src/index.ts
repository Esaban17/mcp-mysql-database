#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConnectionManager } from "./connections.js";
import {
  buildCreateTable,
  buildWhere,
  ident,
  isDestructiveStatement,
  isReadStatement,
  Scalar,
  Where,
} from "./sql.js";

const MAX_ROWS = 1000;
const manager = new ConnectionManager();
const server = new McpServer({ name: "mcp-mysql-database", version: "1.0.0" });

// ---------- helpers ----------
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const whereSchema = z
  .record(z.string(), z.union([scalar, z.array(scalar)]))
  .describe(
    'Condiciones unidas por AND. {"id": 5} => id = 5; {"estado": ["a","b"]} => IN; {"borrado": null} => IS NULL',
  );
const dbParam = z
  .string()
  .optional()
  .describe("Base de datos a usar (por defecto la actual de la conexión activa)");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}
function need(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Registra una herramienta con manejo uniforme de errores. */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
) {
  server.registerTool(
    name,
    { description, inputSchema: shape, annotations },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail(e);
      }
    }) as never,
  );
}

async function run(sql: string, params: unknown[] = [], database?: string) {
  return manager.withConnection(async (c) => {
    const [res] = await c.query(sql, params);
    return res;
  }, database);
}

// ---------- conexiones ----------
tool(
  "list_connections",
  "Lista las conexiones MySQL configuradas y cuál está activa.",
  {},
  async () => ({ configSource: manager.source, connections: manager.list() }),
  { readOnlyHint: true },
);

tool(
  "current_connection",
  "Muestra la conexión activa, su base de datos actual y si es de solo lectura.",
  {},
  async () => {
    const info = manager.list().find((c) => c.active)!;
    const server_ = await manager.withConnection(async (c) => {
      const [r] = await c.query("SELECT VERSION() AS version, DATABASE() AS db");
      return (r as Record<string, unknown>[])[0];
    });
    return { ...info, serverVersion: server_.version, selectedDatabase: server_.db };
  },
  { readOnlyHint: true },
);

tool(
  "select_connection",
  "Cambia la conexión activa (p. ej. 'dev' o 'test'). Todas las demás herramientas usan la conexión activa. Verifica que el servidor responde.",
  { name: z.string().describe("Nombre de la conexión (ver list_connections)") },
  async ({ name }) => {
    const db = await manager.select(name);
    return { activeConnection: name, database: db ?? null, readOnly: manager.isReadOnly() };
  },
);

tool(
  "add_connection",
  "Registra una conexión nueva solo para esta sesión (no se guarda en disco). Opcionalmente la activa.",
  {
    name: z.string().regex(/^[\w.-]+$/),
    host: z.string(),
    port: z.number().int().default(3306),
    user: z.string(),
    password: z.string().default(""),
    database: z.string().optional(),
    readOnly: z.boolean().default(false),
    ssl: z.boolean().default(false),
    activate: z.boolean().default(false).describe("Activarla inmediatamente"),
  },
  async ({ name, activate, ...cfg }) => {
    manager.add(name, cfg);
    try {
      if (activate) await manager.select(name);
      else await manager.withConnection(async (c) => c.query("SELECT 1"), undefined, name);
    } catch (e) {
      await manager.remove(name).catch(() => undefined);
      throw e;
    }
    return { added: name, active: manager.activeName };
  },
);

tool(
  "remove_connection",
  "Elimina una conexión registrada en esta sesión (no puede ser la activa).",
  { name: z.string() },
  async ({ name }) => {
    await manager.remove(name);
    return { removed: name };
  },
  { destructiveHint: true },
);

// ---------- bases de datos ----------
tool(
  "list_databases",
  "Lista las bases de datos del servidor de la conexión activa.",
  {},
  async () => {
    const rows = (await run("SHOW DATABASES")) as Record<string, string>[];
    return { current: manager.currentDatabase() ?? null, databases: rows.map((r) => Object.values(r)[0]) };
  },
  { readOnlyHint: true },
);

tool(
  "create_database",
  "Crea una base de datos. Opcionalmente la selecciona como base actual.",
  {
    name: z.string(),
    charset: z.string().default("utf8mb4"),
    collation: z.string().default("utf8mb4_unicode_ci"),
    ifNotExists: z.boolean().default(true),
    use: z.boolean().default(true).describe("Seleccionarla como base de datos actual"),
  },
  async ({ name, charset, collation, ifNotExists, use }) => {
    manager.assertWritable();
    const sql = `CREATE DATABASE ${ifNotExists ? "IF NOT EXISTS " : ""}${ident(name, "base de datos")} CHARACTER SET ${ident(charset, "charset").replace(/`/g, "")} COLLATE ${ident(collation, "collation").replace(/`/g, "")}`;
    await run(sql, [], "");
    if (use) manager.setDatabase(name);
    return { created: name, sql, currentDatabase: manager.currentDatabase() ?? null };
  },
);

tool(
  "use_database",
  "Selecciona la base de datos actual de la conexión activa.",
  { name: z.string() },
  async ({ name }) => {
    await run("SELECT 1", [], name); // falla si no existe
    manager.setDatabase(name);
    return { connection: manager.activeName, currentDatabase: name };
  },
);

tool(
  "drop_database",
  "ELIMINA una base de datos completa. Irreversible: requiere confirm=true; pide confirmación al usuario antes.",
  { name: z.string(), confirm: z.boolean().describe("Debe ser true") },
  async ({ name, confirm }) => {
    manager.assertWritable();
    need(confirm === true, "Falta confirm=true. Confirma con el usuario antes de borrar.");
    await run(`DROP DATABASE ${ident(name, "base de datos")}`, [], "");
    if (manager.currentDatabase() === name) manager.setDatabase(undefined);
    return { dropped: name };
  },
  { destructiveHint: true },
);

// ---------- tablas ----------
tool(
  "list_tables",
  "Lista las tablas de la base de datos actual (o de `database`).",
  { database: dbParam },
  async ({ database }) => {
    const rows = (await run(
      "SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS approxRows, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) ORDER BY TABLE_NAME",
      [database ?? null],
      database,
    )) as unknown[];
    return { database: database ?? manager.currentDatabase() ?? null, tables: rows };
  },
  { readOnlyHint: true },
);

tool(
  "describe_table",
  "Muestra columnas, índices y el CREATE TABLE de una tabla.",
  { table: z.string(), database: dbParam },
  async ({ table, database }) => {
    const t = ident(table, "tabla");
    const columns = await run(`SHOW FULL COLUMNS FROM ${t}`, [], database);
    const indexes = await run(`SHOW INDEX FROM ${t}`, [], database);
    const create = (await run(`SHOW CREATE TABLE ${t}`, [], database)) as Record<string, string>[];
    return { columns, indexes, createStatement: create[0]["Create Table"] };
  },
  { readOnlyHint: true },
);

const columnSchema = z.object({
  name: z.string(),
  type: z.string().describe("Tipo MySQL: INT, BIGINT UNSIGNED, VARCHAR(255), TEXT, DECIMAL(10,2), DATETIME, ENUM('a','b'), JSON..."),
  nullable: z.boolean().optional().describe("Por defecto NULL permitido (excepto claves primarias)"),
  primaryKey: z.boolean().optional(),
  autoIncrement: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: scalar.optional().describe("Valor por defecto; 'CURRENT_TIMESTAMP' se trata como expresión"),
  comment: z.string().optional(),
});

tool(
  "create_table",
  "Crea una tabla a partir de una definición estructurada de columnas, índices y claves foráneas.",
  {
    table: z.string(),
    database: dbParam,
    columns: z.array(columnSchema).min(1),
    primaryKey: z.array(z.string()).optional().describe("PK compuesta; si se omite se usan las columnas con primaryKey=true"),
    indexes: z
      .array(z.object({ columns: z.array(z.string()).min(1), unique: z.boolean().optional(), name: z.string().optional() }))
      .optional(),
    foreignKeys: z
      .array(
        z.object({
          column: z.string(),
          referencesTable: z.string(),
          referencesColumn: z.string(),
          onDelete: z.enum(["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"]).optional(),
          onUpdate: z.enum(["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"]).optional(),
        }),
      )
      .optional(),
    ifNotExists: z.boolean().default(true),
    engine: z.string().default("InnoDB"),
  },
  async ({ database, ...def }) => {
    manager.assertWritable();
    const sql = buildCreateTable(def);
    await run(sql, [], database);
    return { created: def.table, sql };
  },
);

tool(
  "drop_table",
  "ELIMINA una tabla y sus datos. Irreversible: requiere confirm=true; pide confirmación al usuario antes.",
  { table: z.string(), database: dbParam, confirm: z.boolean().describe("Debe ser true") },
  async ({ table, database, confirm }) => {
    manager.assertWritable();
    need(confirm === true, "Falta confirm=true. Confirma con el usuario antes de borrar.");
    await run(`DROP TABLE ${ident(table, "tabla")}`, [], database);
    return { dropped: table };
  },
  { destructiveHint: true },
);

// ---------- registros ----------
tool(
  "insert_records",
  "Inserta uno o varios registros en una tabla (consulta parametrizada). Cada registro es un objeto columna -> valor.",
  {
    table: z.string(),
    database: dbParam,
    records: z.array(z.record(z.string(), scalar)).min(1).max(1000),
    ignoreDuplicates: z.boolean().default(false).describe("Usar INSERT IGNORE"),
  },
  async ({ table, database, records, ignoreDuplicates }) => {
    manager.assertWritable();
    const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
    need(cols.length > 0, "Los registros no tienen columnas.");
    const colSql = cols.map((c) => ident(c, "columna")).join(", ");
    const rowSql = `(${cols.map(() => "?").join(", ")})`;
    const params = records.flatMap((r) => cols.map((c) => (c in r ? r[c] : null)));
    const sql = `INSERT ${ignoreDuplicates ? "IGNORE " : ""}INTO ${ident(table, "tabla")} (${colSql}) VALUES ${records.map(() => rowSql).join(", ")}`;
    const res = (await run(sql, params, database)) as { affectedRows: number; insertId: number };
    return { affectedRows: res.affectedRows, firstInsertId: res.insertId || null };
  },
);

tool(
  "select_records",
  "Consulta registros de una tabla con filtros simples (igualdad / IN / IS NULL), orden y paginación. Para joins o agregaciones usa run_query.",
  {
    table: z.string(),
    database: dbParam,
    columns: z.array(z.string()).optional().describe("Por defecto todas (*)"),
    where: whereSchema.optional(),
    orderBy: z.array(z.object({ column: z.string(), direction: z.enum(["ASC", "DESC"]).default("ASC") })).optional(),
    limit: z.number().int().min(1).max(MAX_ROWS).default(100),
    offset: z.number().int().min(0).default(0),
  },
  async ({ table, database, columns, where, orderBy, limit, offset }) => {
    const w = buildWhere(where as Where | undefined);
    const cols = columns?.length ? columns.map((c) => ident(c, "columna")).join(", ") : "*";
    const order = orderBy?.length
      ? ` ORDER BY ${orderBy.map((o) => `${ident(o.column, "columna")} ${o.direction}`).join(", ")}`
      : "";
    const sql = `SELECT ${cols} FROM ${ident(table, "tabla")}${w.sql}${order} LIMIT ${limit} OFFSET ${offset}`;
    const rows = (await run(sql, w.params, database)) as unknown[];
    return { rowCount: rows.length, rows };
  },
  { readOnlyHint: true },
);

tool(
  "update_records",
  "Actualiza registros que cumplan `where` (obligatorio y no vacío).",
  { table: z.string(), database: dbParam, set: z.record(z.string(), scalar), where: whereSchema },
  async ({ table, database, set, where }) => {
    manager.assertWritable();
    const cols = Object.keys(set);
    need(cols.length > 0, "`set` no puede estar vacío.");
    need(Object.keys(where).length > 0, "`where` no puede estar vacío (evita actualizar toda la tabla). Usa execute_sql si es intencional.");
    const w = buildWhere(where as Where);
    const sql = `UPDATE ${ident(table, "tabla")} SET ${cols.map((c) => `${ident(c, "columna")} = ?`).join(", ")}${w.sql}`;
    const res = (await run(sql, [...cols.map((c) => set[c]), ...w.params], database)) as {
      affectedRows: number;
      changedRows: number;
    };
    return { matched: res.affectedRows, changed: res.changedRows };
  },
);

tool(
  "delete_records",
  "Borra registros que cumplan `where` (obligatorio y no vacío).",
  { table: z.string(), database: dbParam, where: whereSchema },
  async ({ table, database, where }) => {
    manager.assertWritable();
    need(Object.keys(where).length > 0, "`where` no puede estar vacío (evita vaciar la tabla). Usa execute_sql con TRUNCATE si es intencional.");
    const w = buildWhere(where as Where);
    const res = (await run(`DELETE FROM ${ident(table, "tabla")}${w.sql}`, w.params, database)) as {
      affectedRows: number;
    };
    return { deleted: res.affectedRows };
  },
  { destructiveHint: true },
);

// ---------- SQL libre ----------
tool(
  "run_query",
  `Ejecuta una consulta SQL de SOLO LECTURA (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) dentro de una transacción READ ONLY. Máx. ${MAX_ROWS} filas devueltas. Usa ? y params para valores.`,
  { sql: z.string(), params: z.array(scalar).default([]), database: dbParam },
  async ({ sql, params, database }) => {
    need(isReadStatement(sql), "run_query solo acepta SELECT, SHOW, DESCRIBE, EXPLAIN o WITH. Usa execute_sql para escribir.");
    const rows = await manager.withConnection(async (c) => {
      await c.query("SET SESSION TRANSACTION READ ONLY");
      try {
        await c.query("START TRANSACTION");
        const [res] = await c.query(sql, params);
        await c.query("ROLLBACK");
        return res;
      } finally {
        await c.query("SET SESSION TRANSACTION READ WRITE");
      }
    }, database);
    if (!Array.isArray(rows)) return { result: rows };
    return { rowCount: rows.length, truncated: rows.length > MAX_ROWS, rows: rows.slice(0, MAX_ROWS) };
  },
  { readOnlyHint: true },
);

tool(
  "execute_sql",
  "Ejecuta una sentencia SQL única que modifica datos o esquema (ALTER, UPDATE masivo, CREATE INDEX, etc.). DROP y TRUNCATE requieren confirm=true. No disponible en conexiones readOnly.",
  {
    sql: z.string(),
    params: z.array(scalar).default([]),
    database: dbParam,
    confirm: z.boolean().default(false).describe("Requerido para DROP / TRUNCATE"),
  },
  async ({ sql, params, database, confirm }) => {
    manager.assertWritable(sql);
    if (isDestructiveStatement(sql)) need(confirm, "Sentencia destructiva: requiere confirm=true (confirma con el usuario).");
    const res = await run(sql, params as Scalar[], database);
    return Array.isArray(res) ? { rowCount: res.length, rows: res.slice(0, MAX_ROWS) } : { result: res };
  },
  { destructiveHint: true },
);

// ---------- arranque ----------
async function main() {
  await server.connect(new StdioServerTransport());
}

process.on("SIGINT", () => void manager.closeAll().finally(() => process.exit(0)));
process.on("SIGTERM", () => void manager.closeAll().finally(() => process.exit(0)));
main().catch((e) => {
  console.error("Fallo al iniciar el servidor MCP:", e);
  process.exit(1);
});
console.error(`[mcp-mysql] conexión activa: ${manager.activeName} (config: ${manager.source})`);
