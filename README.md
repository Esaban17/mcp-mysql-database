# mcp-mysql-database

Servidor [MCP](https://modelcontextprotocol.io) que conecta **Claude** con bases de datos **MySQL** locales.
Pídele a Claude en lenguaje natural que cree bases de datos y tablas, inserte, consulte, actualice o borre
registros, y elige a qué conexión (dev, test, …) apuntar. MySQL corre en contenedores Docker.

> "Crea una base de datos `tienda` con una tabla `productos` (nombre, precio, stock) e inserta 3 productos de ejemplo."
> "Cámbiate a la conexión `test` y muéstrame los pedidos de mayo."

Claude traduce tu petición a llamadas a las herramientas de este servidor; el servidor construye el SQL de forma
segura (identificadores validados, valores siempre parametrizados).

## Inicio rápido

```bash
# 1. MySQL en Docker: dos instancias (dev en :3306, test en :3307)
cp .env.example .env            # opcional: cambia contraseñas/puertos
npm run db:up

# 2. Servidor MCP
npm install
npm run build
```

### Conectarlo a Claude

**Claude Code** — este repo incluye `.mcp.json`; abre Claude Code en esta carpeta y aprueba el servidor `mysql`. O bien:

```bash
claude mcp add mysql -- node /ruta/absoluta/mcp-mysql-database/dist/index.js
```

**Claude Desktop** — en `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mysql": { "command": "node", "args": ["/ruta/absoluta/mcp-mysql-database/dist/index.js"] }
  }
}
```

## Conexiones

Sin configuración, el servidor usa las dos bases de `docker-compose.yml` (`dev` → 3306, `test` → 3307).
Para definir las tuyas, copia `connections.example.json` a `connections.json` (ignorado por git) o apunta
`MYSQL_MCP_CONFIG` a otro archivo:

```json
{
  "default": "dev",
  "connections": {
    "dev":  { "host": "127.0.0.1", "port": 3306, "user": "root", "password": "devpassword", "database": "appdb" },
    "prod": { "host": "db.ejemplo.com", "user": "lector", "passwordEnv": "MYSQL_PROD_PASSWORD", "readOnly": true }
  }
}
```

- `passwordEnv`: lee la contraseña de una variable de entorno (mejor que escribirla en el archivo).
- `readOnly: true`: la conexión rechaza cualquier escritura.
- Alternativa mínima: variables `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.

## Herramientas

| Grupo | Herramienta | Qué hace |
|---|---|---|
| Conexiones | `list_connections`, `current_connection`, `select_connection`, `add_connection`, `remove_connection` | Ver y **cambiar la conexión activa**; registrar conexiones temporales |
| Bases de datos | `list_databases`, `create_database`, `use_database`, `drop_database` | Gestionar bases y elegir la actual |
| Tablas | `list_tables`, `describe_table`, `create_table`, `drop_table` | Esquema (columnas, PK, índices, FK) |
| Registros | `insert_records`, `select_records`, `update_records`, `delete_records` | CRUD con filtros estructurados |
| SQL libre | `run_query` (solo lectura), `execute_sql` (escritura/DDL) | Joins, agregaciones, `ALTER`, etc. |

Todas las herramientas de datos aceptan un `database` opcional para no depender de la base actual.

## Seguridad

- Identificadores (`tabla`, `columna`, …) validados con `^[A-Za-z0-9_$]{1,64}$` y entrecomillados; los valores van siempre como parámetros.
- `drop_database`, `drop_table` y `DROP`/`TRUNCATE` vía `execute_sql` exigen `confirm: true` (Claude debe confirmarlo contigo).
- `update_records` y `delete_records` exigen un `where` no vacío.
- `run_query` solo admite `SELECT/SHOW/DESCRIBE/EXPLAIN/WITH` y corre en una transacción `READ ONLY` con `ROLLBACK`.
- Una sola sentencia por llamada (sin `multipleStatements`); máximo 1000 filas por consulta.
- Las credenciales de `docker-compose.yml` son **solo para desarrollo local**; los puertos se publican en el host, no los expongas a internet.

## Desarrollo

```bash
npm run build      # compila TypeScript a dist/
npm test           # prueba e2e: lanza el servidor por stdio con un cliente MCP real
npm run db:down    # detiene los contenedores (los datos persisten en volúmenes)
```

`npm test` necesita MySQL en 3306 y 3307 (`npm run db:up`); si no están accesibles, las pruebas se omiten.
