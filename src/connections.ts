import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { Pool, PoolConnection } from "mysql2/promise";
import { isReadStatement } from "./sql.js";

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  passwordEnv?: string;
  database?: string;
  readOnly?: boolean;
  description?: string;
  ssl?: boolean;
}

interface ConfigFile {
  default?: string;
  connections: Record<string, ConnectionConfig>;
}

/** Valores por defecto = los de docker-compose.yml, para que funcione sin configurar nada. */
const BUILTIN: ConfigFile = {
  default: "dev",
  connections: {
    dev: {
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      passwordEnv: "MYSQL_DEV_ROOT_PASSWORD",
      password: "devpassword",
      database: "appdb",
      description: "MySQL dev (docker: mcp-mysql-dev)",
    },
    test: {
      host: "127.0.0.1",
      port: 3307,
      user: "root",
      passwordEnv: "MYSQL_TEST_ROOT_PASSWORD",
      password: "testpassword",
      database: "testdb",
      description: "MySQL test (docker: mcp-mysql-test)",
    },
  },
};

function loadConfig(): { cfg: ConfigFile; source: string } {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = process.env.MYSQL_MCP_CONFIG ?? path.join(root, "connections.json");
  if (fs.existsSync(file)) {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFile;
    if (!cfg.connections || Object.keys(cfg.connections).length === 0) {
      throw new Error(`${file}: falta la clave "connections" con al menos una conexión.`);
    }
    return { cfg, source: file };
  }
  if (process.env.MYSQL_HOST) {
    return {
      source: "variables de entorno MYSQL_*",
      cfg: {
        default: "env",
        connections: {
          env: {
            host: process.env.MYSQL_HOST,
            port: Number(process.env.MYSQL_PORT ?? 3306),
            user: process.env.MYSQL_USER ?? "root",
            password: process.env.MYSQL_PASSWORD ?? "",
            database: process.env.MYSQL_DATABASE,
          },
        },
      },
    };
  }
  return { cfg: BUILTIN, source: "valores por defecto (docker-compose)" };
}

export class ConnectionManager {
  private configs = new Map<string, ConnectionConfig>();
  private pools = new Map<string, Pool>();
  private databases = new Map<string, string | undefined>();
  private active: string;
  readonly source: string;

  constructor() {
    const { cfg, source } = loadConfig();
    this.source = source;
    for (const [name, c] of Object.entries(cfg.connections)) this.configs.set(name, c);
    this.active =
      cfg.default && this.configs.has(cfg.default) ? cfg.default : [...this.configs.keys()][0];
  }

  get activeName(): string {
    return this.active;
  }

  list() {
    return [...this.configs.entries()].map(([name, c]) => ({
      name,
      active: name === this.active,
      host: c.host,
      port: c.port,
      user: c.user,
      database: this.databases.has(name) ? this.databases.get(name) : c.database,
      readOnly: !!c.readOnly,
      description: c.description,
    }));
  }

  isReadOnly(name = this.active): boolean {
    return !!this.configs.get(name)?.readOnly;
  }

  currentDatabase(name = this.active): string | undefined {
    return this.databases.has(name) ? this.databases.get(name) : this.configs.get(name)?.database;
  }

  setDatabase(db: string | undefined, name = this.active) {
    this.databases.set(name, db);
  }

  add(name: string, cfg: ConnectionConfig) {
    if (this.configs.has(name)) throw new Error(`La conexión "${name}" ya existe.`);
    this.configs.set(name, cfg);
  }

  async remove(name: string) {
    if (!this.configs.has(name)) throw new Error(`No existe la conexión "${name}".`);
    if (name === this.active) throw new Error("No se puede eliminar la conexión activa.");
    await this.pools.get(name)?.end();
    this.pools.delete(name);
    this.databases.delete(name);
    this.configs.delete(name);
  }

  async select(name: string): Promise<string | undefined> {
    if (!this.configs.has(name)) {
      throw new Error(
        `No existe la conexión "${name}". Disponibles: ${[...this.configs.keys()].join(", ")}`,
      );
    }
    // Verifica que responde antes de cambiar la activa.
    await this.withConnection(async (c) => c.query("SELECT 1"), undefined, name);
    this.active = name;
    return this.currentDatabase(name);
  }

  private pool(name: string): Pool {
    let pool = this.pools.get(name);
    if (pool) return pool;
    const c = this.configs.get(name);
    if (!c) throw new Error(`No existe la conexión "${name}".`);
    const password = (c.passwordEnv && process.env[c.passwordEnv]) || c.password || "";
    pool = mysql.createPool({
      host: c.host,
      port: c.port,
      user: c.user,
      password,
      ssl: c.ssl ? {} : undefined,
      connectionLimit: 5,
      connectTimeout: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    this.pools.set(name, pool);
    return pool;
  }

  /** Ejecuta `fn` con una conexión del pool, ya posicionada en la base de datos elegida. */
  async withConnection<T>(
    fn: (conn: PoolConnection) => Promise<T>,
    database?: string,
    name = this.active,
  ): Promise<T> {
    const conn = await this.pool(name).getConnection();
    try {
      const db = database ?? this.currentDatabase(name);
      if (db) await conn.query(`USE ${mysql.escapeId(db)}`);
      return await fn(conn);
    } finally {
      conn.release();
    }
  }

  /** Lanza error si la conexión activa es de solo lectura y la sentencia escribe. */
  assertWritable(sql?: string) {
    if (!this.isReadOnly()) return;
    if (sql && isReadStatement(sql)) return;
    throw new Error(`La conexión "${this.active}" es de solo lectura (readOnly: true).`);
  }

  async closeAll() {
    await Promise.all([...this.pools.values()].map((p) => p.end()));
  }
}
