import mysql from "mysql2/promise";

const IDENT = /^[A-Za-z0-9_$]{1,64}$/;
// Tipos como INT, VARCHAR(255), DECIMAL(10,2), ENUM('a','b'), INT UNSIGNED
const TYPE = /^[A-Za-z]+(\s*\(\s*[0-9A-Za-z_'",\s]+\s*\))?(\s+(UNSIGNED|ZEROFILL))*$/i;

export function ident(name: string, what = "identificador"): string {
  if (!IDENT.test(name)) {
    throw new Error(
      `${what} inválido: "${name}". Solo se permiten letras, números, "_" y "$" (máx. 64).`,
    );
  }
  return mysql.escapeId(name);
}

export function columnType(type: string): string {
  const t = type.trim();
  if (!TYPE.test(t)) throw new Error(`Tipo de columna inválido: "${type}"`);
  return t.toUpperCase().startsWith("ENUM") || t.toUpperCase().startsWith("SET")
    ? t
    : t.toUpperCase();
}

export type Scalar = string | number | boolean | null;

export interface ColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unique?: boolean;
  default?: Scalar;
  comment?: string;
}

export interface ForeignKeyDef {
  column: string;
  referencesTable: string;
  referencesColumn: string;
  onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  onUpdate?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
}

export interface IndexDef {
  columns: string[];
  unique?: boolean;
  name?: string;
}

function defaultLiteral(v: Scalar): string {
  if (typeof v === "string" && /^(CURRENT_TIMESTAMP(\(\d\))?|NOW\(\))$/i.test(v.trim())) {
    return v.trim().toUpperCase();
  }
  return mysql.escape(v);
}

export function buildCreateTable(opts: {
  database?: string;
  table: string;
  columns: ColumnDef[];
  primaryKey?: string[];
  indexes?: IndexDef[];
  foreignKeys?: ForeignKeyDef[];
  ifNotExists?: boolean;
  engine?: string;
}): string {
  if (opts.columns.length === 0) throw new Error("Se requiere al menos una columna.");
  const parts: string[] = [];
  const inlinePk = opts.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const pk = opts.primaryKey ?? inlinePk;

  for (const c of opts.columns) {
    let def = `${ident(c.name, "columna")} ${columnType(c.type)}`;
    const isPk = pk.includes(c.name);
    if (c.nullable === false || isPk) def += " NOT NULL";
    else if (c.nullable === true) def += " NULL";
    if (c.autoIncrement) def += " AUTO_INCREMENT";
    if (c.default !== undefined) def += ` DEFAULT ${defaultLiteral(c.default)}`;
    if (c.unique) def += " UNIQUE";
    if (c.comment) def += ` COMMENT ${mysql.escape(c.comment)}`;
    parts.push(def);
  }
  if (pk.length) parts.push(`PRIMARY KEY (${pk.map((c) => ident(c, "columna")).join(", ")})`);
  for (const ix of opts.indexes ?? []) {
    const name = ix.name ? ident(ix.name, "índice") + " " : "";
    parts.push(
      `${ix.unique ? "UNIQUE " : ""}INDEX ${name}(${ix.columns.map((c) => ident(c, "columna")).join(", ")})`,
    );
  }
  for (const fk of opts.foreignKeys ?? []) {
    let s = `FOREIGN KEY (${ident(fk.column, "columna")}) REFERENCES ${ident(fk.referencesTable, "tabla")} (${ident(fk.referencesColumn, "columna")})`;
    if (fk.onDelete) s += ` ON DELETE ${fk.onDelete}`;
    if (fk.onUpdate) s += ` ON UPDATE ${fk.onUpdate}`;
    parts.push(s);
  }
  const target = opts.database
    ? `${ident(opts.database, "base de datos")}.${ident(opts.table, "tabla")}`
    : ident(opts.table, "tabla");
  const engine = opts.engine ? ` ENGINE=${ident(opts.engine, "engine").replace(/`/g, "")}` : "";
  return `CREATE TABLE ${opts.ifNotExists ? "IF NOT EXISTS " : ""}${target} (\n  ${parts.join(",\n  ")}\n)${engine}`;
}

export type Where = Record<string, Scalar | Scalar[]>;

/** Construye "col = ? AND col IN (?) AND col IS NULL" con parámetros. */
export function buildWhere(where: Where | undefined): { sql: string; params: Scalar[] } {
  const entries = Object.entries(where ?? {});
  if (entries.length === 0) return { sql: "", params: [] };
  const clauses: string[] = [];
  const params: Scalar[] = [];
  for (const [col, val] of entries) {
    const c = ident(col, "columna");
    if (val === null) clauses.push(`${c} IS NULL`);
    else if (Array.isArray(val)) {
      if (val.length === 0) clauses.push("1 = 0");
      else {
        clauses.push(`${c} IN (${val.map(() => "?").join(", ")})`);
        params.push(...val);
      }
    } else {
      clauses.push(`${c} = ?`);
      params.push(val);
    }
  }
  return { sql: ` WHERE ${clauses.join(" AND ")}`, params };
}

const READ_ONLY_START = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i;
const DESTRUCTIVE = /^\s*(DROP|TRUNCATE)\b/i;

export function isReadStatement(sql: string): boolean {
  return READ_ONLY_START.test(stripLeadingComments(sql));
}
export function isDestructiveStatement(sql: string): boolean {
  return DESTRUCTIVE.test(stripLeadingComments(sql));
}

function stripLeadingComments(sql: string): string {
  return sql.replace(/^\s*(\/\*[\s\S]*?\*\/|--[^\n]*\n|#[^\n]*\n)*/g, "");
}
