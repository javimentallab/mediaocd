# Servidor MCP de MediaOCD

[English](README.md) | **Español**

Un servidor [Model Context Protocol](https://modelcontextprotocol.io) con el que un asistente de IA puede buscar en tu biblioteca de [MediaOCD](../../README.md), marcar cosas como vistas, gestionar la watchlist y puntuar lo que has visto. Habla con la API HTTP de MediaOCD mediante un token de aplicación, así que no necesita acceso a la base de datos y funciona en cualquier sitio desde el que se llegue a tu instancia.

> [!WARNING]
> Este servidor puede cambiar tus datos. **No lo expongas a internet sin `MCP_AUTH_TOKEN`**, y ponlo detrás de HTTPS si sale de una red de confianza. Consulta [Seguridad](#seguridad).

## Herramientas

| Herramienta | Qué hace | Cambia datos |
|---|---|---|
| `search` | Busca en los catálogos externos, en un solo tipo de contenido | No (1) |
| `library` | Lista lo que hay en tu biblioteca | No |
| `details` | Ficha completa de un elemento | No |
| `in_progress` | Elementos fijados como en curso | No |
| `watchlist` | Lista tu watchlist | No |
| `status` | Comprueba la conexión y el token; cuenta películas y series | No |
| `mark_seen` | Añade al historial de vistos: un elemento, una temporada o un episodio | **Sí** |
| `unmark_seen` | Borra del historial de vistos | **Sí, y no se puede deshacer** |
| `watchlist_add` | Añade a la watchlist | **Sí** |
| `watchlist_remove` | Quita de la watchlist | **Sí** |
| `rate` | Pone la nota (de 1 a 5 estrellas), la reseña o ambas | **Sí** |

(1) MediaOCD guarda los resultados de búsqueda en su catálogo, pero no entran en tu biblioteca.

Las herramientas llevan las indicaciones estándar de MCP de solo lectura y destructiva, que el cliente puede usar para pedir confirmación.

## Instalación

Primero crea un token en MediaOCD, en *Settings > Application tokens*. Actúa como tu usuario, así que todo se hace en tu nombre.

### Con Docker

Desde la raíz de este repositorio, añade el servicio a tu `docker-compose.yml`, junto a `mediaocd`, y pon los dos tokens en el fichero `.env` que tiene al lado:

```yaml
services:
  mediaocd-mcp:
    build: ./contrib/mcp-server
    container_name: mediaocd-mcp
    restart: unless-stopped
    ports:
      - "127.0.0.1:8016:8016"    # solo esta máquina; lee Seguridad antes de cambiarlo
    environment:
      MEDIAOCD_URL: http://mediaocd:7481
      MEDIAOCD_TOKEN: ${MEDIAOCD_TOKEN:?crea uno en MediaOCD}
      MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN:?genera uno con openssl rand -hex 32}
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
```

```sh
docker compose build mediaocd-mcp
docker compose up -d mediaocd-mcp
```

La imagen se ejecuta con un usuario sin privilegios y no arranca sin `MCP_AUTH_TOKEN`.

### Sin Docker

La versión probada es Python 3.12.

```sh
cd contrib/mcp-server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

export MEDIAOCD_URL=http://localhost:7481
export MEDIAOCD_TOKEN=...
.venv/bin/python server.py
```

Escucha en `http://127.0.0.1:8016/mcp`. En Windows usa `.venv\Scripts\`, y `set` o `$env:` para las variables.

Para no abrir ningún puerto, pon `MCP_TRANSPORT=stdio` y deja que lo arranque el cliente; más abajo está cómo.

## Configuración del cliente

**Claude Code:**

```sh
claude mcp add --transport http mediaocd http://localhost:8016/mcp \
  --header "Authorization: Bearer TU_MCP_AUTH_TOKEN"
```

**Clientes con configuración JSON, por HTTP.** Los nombres exactos dependen del cliente:

```json
{
  "mcpServers": {
    "mediaocd": {
      "type": "http",
      "url": "http://localhost:8016/mcp",
      "headers": { "Authorization": "Bearer TU_MCP_AUTH_TOKEN" }
    }
  }
}
```

**Clientes que arrancan ellos el servidor, por stdio:**

```json
{
  "mcpServers": {
    "mediaocd": {
      "command": "/ruta/a/contrib/mcp-server/.venv/bin/python",
      "args": ["/ruta/a/contrib/mcp-server/server.py"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEDIAOCD_URL": "http://localhost:7481",
        "MEDIAOCD_TOKEN": "TU_TOKEN_DE_MEDIAOCD"
      }
    }
  }
}
```

## Configuración

Todo va en variables de entorno; [`.env.example`](.env.example) las tiene todas.

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `MEDIAOCD_TOKEN` | *(obligatoria)* | Token de aplicación de MediaOCD |
| `MEDIAOCD_URL` | `http://localhost:7481` | Dirección de tu instancia |
| `MEDIAOCD_TIMEOUT` | `25` | Segundos de espera de la respuesta |
| `MCP_AUTH_TOKEN` | *(vacía)* | Token que deben enviar los clientes; 24 caracteres como mínimo |
| `MCP_ALLOW_UNAUTHENTICATED` | *(vacía)* | `true` para escuchar en una dirección que no sea loopback sin token |
| `MCP_TRANSPORT` | `streamable-http` | `streamable-http` o `stdio` |
| `MCP_HOST` | `127.0.0.1` (`0.0.0.0` en Docker) | Dirección en la que escucha |
| `MCP_PORT` | `8016` | Puerto en el que escucha |
| `MCP_ALLOWED_HOSTS` | *(loopback)* | Otros valores de `Host` aceptados, separados por comas |
| `MCP_ALLOWED_ORIGINS` | *(loopback)* | Otros valores de `Origin` aceptados, separados por comas |
| `MCP_LOG_LEVEL` | `INFO` | Nivel de registro |

Para conectar por cualquier nombre que no sea `localhost`, incluso desde otro contenedor, hay que añadirlo a `MCP_ALLOWED_HOSTS` con su puerto (`mcp.example.org:8016`) o con `:*`. Si no, el servidor responde `421 Invalid Host header`.

## Seguridad

- **Loopback por defecto.** Sin configurar nada, el servidor solo escucha en `127.0.0.1`. Aun así, cualquier proceso local puede usarlo, así que pon `MCP_AUTH_TOKEN` si compartes la máquina.
- **Sin puerto público si no hay token.** En cualquier otra dirección, el servidor no arranca sin `MCP_AUTH_TOKEN`. `MCP_ALLOW_UNAUTHENTICATED=true` lo permite en una red de total confianza; entonces cualquiera que llegue al puerto puede leer y cambiar tu biblioteca.
- **Por HTTP sin cifrar, el token viaja en claro**, igual que el de MediaOCD entre este servidor y tu instancia si `MEDIAOCD_URL` empieza por `http://`. Fuera de una red de confianza, usa un proxy inverso con HTTPS.
- **Se comprueban las peticiones.** Los tokens se comparan en tiempo constante, `Host` y `Origin` pasan por una lista blanca contra el DNS rebinding, no se envían cabeceras CORS y el cuerpo de las peticiones está limitado a 4 MiB.
- **Se validan los parámetros** con tipos estrictos y listas blancas antes de enviar nada a MediaOCD.
- **El token de MediaOCD solo va a `MEDIAOCD_URL`:** no se siguen redirecciones y se ignoran los proxies del entorno.
- **Errores y registros limpios.** Los errores que recibe el cliente no llevan ni la dirección de MediaOCD ni el cuerpo de sus respuestas, y los registros no llevan ni tokens ni parámetros de consulta.

El texto de los catálogos externos llega al asistente como resultado de las herramientas. Un título o una descripción maliciosos podrían intentar influirle, así que haz que tu cliente pida confirmación antes de las herramientas que cambian datos.

## Limitaciones

- Cubre las herramientas de arriba, no toda la API. No están las listas distintas de la watchlist, YouTube, el progreso ni la administración.
- Un token tiene los permisos de su usuario, también los de administrador. No hay tokens de solo lectura; las indicaciones de MCP son un consejo al cliente, no una restricción.
- `search` funciona con un tipo de contenido cada vez, porque la API lo exige.
- `library` y `status` piden a MediaOCD todos los elementos que coinciden y `limit` solo recorta la respuesta, así que una biblioteca muy grande los hace más lentos.
- Desde aquí se puede cambiar una nota o una reseña, y vaciar una reseña, pero una nota solo se puede quitar desde la interfaz web.
- `unmark_seen` sin `episode_id` ni `season_id` borra las entradas de todo el elemento.
- Se ha probado contra un MediaOCD simulado y se ha contrastado con la tabla de rutas de este repositorio, no contra todas las versiones de la aplicación.

## Pruebas

Las pruebas arrancan el servidor real y hablan con él por HTTP, contra un MediaOCD falso en la dirección loopback. No tocan ninguna instancia real ni necesitan Docker.

```sh
cd contrib/mcp-server
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests
```

## Licencia

MIT, como el resto del repositorio: consulta [`LICENSE`](../../LICENSE). Los componentes de terceros están en [`NOTICE`](NOTICE).
