// Prueba de extremo a extremo: lanza el servidor MCP por stdio y lo usa como cliente.
// Requiere las bases de datos de docker-compose (npm run db:up) o equivalentes en 3306/3307.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const reachable = (port) =>
  new Promise((res) => {
    const s = net.connect(port, "127.0.0.1").once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });
const up = (await reachable(3306)) && (await reachable(3307));
const opts = { skip: up ? false : "MySQL no disponible en 3306/3307 (npm run db:up)" };

let client;
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
};

before(async () => {
  if (!up) return;
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "ignore" }),
  );
});
after(async () => {
  if (!client) return;
  await call("select_connection", { name: "dev" });
  await call("drop_database", { name: "mcp_e2e", confirm: true });
  await client.close();
});

test("expone todas las herramientas", opts, async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["list_connections", "select_connection", "create_database", "create_table",
    "insert_records", "select_records", "update_records", "delete_records", "run_query", "execute_sql"]) {
    assert.ok(names.includes(n), `falta ${n}`);
  }
});

test("lista y cambia de conexión", opts, async () => {
  const { json } = await call("list_connections");
  assert.deepEqual(json.connections.map((c) => c.name).sort(), ["dev", "test"]);
  assert.equal(json.connections.find((c) => c.active).name, "dev");
  const sel = await call("select_connection", { name: "test" });
  assert.equal(sel.json.activeConnection, "test");
  assert.equal((await call("current_connection")).json.port, 3307);
  const bad = await call("select_connection", { name: "nope" });
  assert.ok(bad.isError);
  await call("select_connection", { name: "dev" });
  assert.equal((await call("current_connection")).json.port, 3306);
});

test("crea base, tabla, inserta, consulta, actualiza y borra", opts, async () => {
  await call("select_connection", { name: "dev" });
  const db = await call("create_database", { name: "mcp_e2e" });
  assert.equal(db.json.currentDatabase, "mcp_e2e");

  const t = await call("create_table", {
    table: "clientes",
    columns: [
      { name: "id", type: "INT", primaryKey: true, autoIncrement: true },
      { name: "nombre", type: "VARCHAR(100)", nullable: false },
      { name: "email", type: "VARCHAR(150)", unique: true },
      { name: "creado", type: "DATETIME", default: "CURRENT_TIMESTAMP" },
    ],
  });
  assert.ok(!t.isError, t.text);

  const ins = await call("insert_records", {
    table: "clientes",
    records: [
      { nombre: "Ana", email: "ana@x.com" },
      { nombre: "O'Brien; DROP TABLE clientes;--", email: "ob@x.com" },
    ],
  });
  assert.equal(ins.json.affectedRows, 2);

  const all = await call("select_records", { table: "clientes", orderBy: [{ column: "id" }] });
  assert.equal(all.json.rowCount, 2);
  assert.equal(all.json.rows[1].nombre, "O'Brien; DROP TABLE clientes;--"); // sin inyección

  const upd = await call("update_records", { table: "clientes", set: { nombre: "Ana M." }, where: { email: "ana@x.com" } });
  assert.equal(upd.json.changed, 1);
  const q = await call("run_query", { sql: "SELECT COUNT(*) AS n FROM clientes WHERE nombre LIKE ?", params: ["Ana%"] });
  assert.equal(Number(q.json.rows[0].n), 1);

  const del = await call("delete_records", { table: "clientes", where: { email: ["ob@x.com"] } });
  assert.equal(del.json.deleted, 1);
  assert.ok((await call("list_tables")).json.tables.some((x) => x.name === "clientes"));
  assert.ok((await call("describe_table", { table: "clientes" })).json.columns.length >= 4);
});

test("las bases de datos son independientes por conexión", opts, async () => {
  await call("select_connection", { name: "test" });
  const dbs = (await call("list_databases")).json.databases;
  assert.ok(!dbs.includes("mcp_e2e"));
  await call("select_connection", { name: "dev" });
  assert.ok((await call("list_databases")).json.databases.includes("mcp_e2e"));
});

test("protecciones de seguridad", opts, async () => {
  await call("select_connection", { name: "dev" });
  await call("use_database", { name: "mcp_e2e" });
  assert.ok((await call("run_query", { sql: "DELETE FROM clientes" })).isError);
  assert.ok((await call("update_records", { table: "clientes", set: { nombre: "x" }, where: {} })).isError);
  assert.ok((await call("delete_records", { table: "clientes", where: {} })).isError);
  assert.ok((await call("drop_table", { table: "clientes", confirm: false })).isError);
  assert.ok((await call("execute_sql", { sql: "TRUNCATE clientes" })).isError);
  assert.ok((await call("select_records", { table: "clientes; DROP TABLE x" })).isError);
  assert.ok((await call("create_table", { table: "t", columns: [{ name: "a", type: "INT); DROP TABLE clientes;--" }] })).isError);
  assert.equal((await call("select_records", { table: "clientes" })).json.rowCount, 1);
});

test("conexión readOnly rechaza escrituras", opts, async () => {
  const add = await call("add_connection", {
    name: "ro", host: "127.0.0.1", port: 3306, user: "root", password: "devpassword", readOnly: true, database: "mcp_e2e", activate: true,
  });
  assert.ok(!add.isError, add.text);
  assert.ok((await call("insert_records", { table: "clientes", records: [{ nombre: "z" }] })).isError);
  assert.ok((await call("execute_sql", { sql: "UPDATE clientes SET nombre='z'" })).isError);
  assert.ok(!(await call("select_records", { table: "clientes" })).isError);
  await call("select_connection", { name: "dev" });
  assert.ok(!(await call("remove_connection", { name: "ro" })).isError);
});
