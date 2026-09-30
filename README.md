# API WHALES AZA

Integración de **AZA Logistics** con la API **LUX (Whales)**: autenticación, cliente HTTP
resiliente hacia LUX y una API REST propia (`/api/expediciones`, `/api/recepciones`,
`/api/catalogos`) que envuelve los procedimientos almacenados autorizados.

## Arrancar el servicio

```bash
npm install
cp .env.example .env
# Rellenar en .env: LUX_BASE_URL, LUX_USERNAME, LUX_PASSWORD, LUX_WAREHOUSE, AZA_API_KEY,
# SESSION_SECRET (ver seccion "Configuracion" mas abajo para el detalle de cada variable)

npm run dev
# o en "produccion": npm run build && npm start
```

El `.env` se carga automaticamente (via `dotenv`) al arrancar — no hace falta exportar las
variables a mano en la terminal (PowerShell, CMD, bash...).

En **desarrollo** (`npm run dev`), `tsx watch --watch-path .env` vigila tambien el propio `.env`
ademas del codigo: si cambias cualquier variable, el proceso se reinicia solo (veras
`Restarting 'src/server.ts'` en la consola), igual que ya hacia con los cambios de codigo.

En **produccion** (`npm start`, que ejecuta `node dist/src/server.js` ya compilado, sin `tsx
watch`) esto no aplica: si cambias `.env` ahi, hay que parar y volver a arrancar el proceso a
mano (o dejar que el orquestador — PM2, systemd, Docker, etc. — lo reinicie).

El servidor queda escuchando en `http://localhost:3000` (o el `PORT` configurado):

* API propia: `http://localhost:3000/api/...` (requiere cabecera `X-Api-Key`, ver más abajo).
* Documentación interactiva: `http://localhost:3000/docs` (Swagger UI).
* Interfaz web de almacén: `http://localhost:3000/almacen/login` (requiere crear antes un
  usuario con `npm run create-web-user -- <usuario> <password>`).
* Salud del proceso: `http://localhost:3000/health/live`.

Ver la sección [Ejecutar](#ejecutar) para más detalle y todos los endpoints expuestos.

Documentación de referencia (fuente de verdad, no reinterpretar):

* [`docs/lux-api-analysis.md`](docs/lux-api-analysis.md) — análisis literal de la API LUX.
* [`docs/architecture.md`](docs/architecture.md) — arquitectura de capas.
* [`docs/audit.md`](docs/audit.md) — auditoría inicial y decisión de stack.
* [`docs/progress.md`](docs/progress.md) — estado de cada fase y TODOs pendientes por falta de
  información en la documentación del proveedor.
* [`docs/openapi.yaml`](docs/openapi.yaml) — endpoints propios de AZA. Servido de forma
  interactiva (Swagger UI) en `GET /docs` mientras el servidor está arrancado — permite explorar
  y probar los endpoints desde el navegador (pulsar "Authorize" e introducir la `X-Api-Key`
  configurada en `AZA_API_KEY` para poder ejecutar los de `/api/*`; `/health/*` y `/docs` mismos
  son públicos, sin autenticación).
* [`docs/troubleshooting.md`](docs/troubleshooting.md) — política de reintentos, qué hacer ante
  una cabecera creada con líneas fallidas, e idempotencia de facto (sin soporte nativo en LUX).

## Probar la API con Postman

Además de Swagger UI (`GET /docs`), hay una colección de Postman lista para importar, con los
cuerpos de ejemplo ya rellenados (equivalente a la colección que dio el proveedor para LUX, pero
para **nuestra propia** API):

* [`postman/AZA-LUX-API.postman_collection.json`](postman/AZA-LUX-API.postman_collection.json)
* [`postman/AZA-LUX-API.postman_environment.json`](postman/AZA-LUX-API.postman_environment.json)
  — ya trae `baseUrl=http://localhost:3000` y tu `AZA_API_KEY` local. **No se versiona en git**
  (contiene la clave real); si cambias `AZA_API_KEY` en `.env`, actualízala también aquí.

En Postman: `Import` → arrastra los dos ficheros → selecciona el entorno "AZA LUX API - local"
arriba a la derecha → con el servidor arrancado (`npm run dev`), ya puedes ejecutar cualquier
petición de la colección sin rellenar nada más.

## Stack

Node.js 20+, TypeScript (`strict`), Express, axios, zod, vitest. Interfaz web (`/almacen/*`): EJS,
express-session, better-sqlite3, bcryptjs.

## Configuración

```bash
cp .env.example .env
# Rellenar LUX_BASE_URL, LUX_USERNAME, LUX_PASSWORD, LUX_WAREHOUSE, etc.
```

Ver todas las variables soportadas en [`.env.example`](.env.example). El proceso falla al
arrancar (`process.exit(1)`) si falta alguna variable obligatoria (incluida `AZA_API_KEY` y
`SESSION_SECRET`, ver siguientes secciones).

## Autenticación de la API propia de AZA

Toda la API HTTP propia de AZA bajo `/api/*` (`/api/expediciones`, `/api/recepciones`,
`/api/catalogos`) exige la cabecera `X-Api-Key` con el valor configurado en `AZA_API_KEY`:

```bash
curl -H "X-Api-Key: $AZA_API_KEY" http://localhost:3000/api/expediciones
```

Si falta la cabecera o no coincide con `AZA_API_KEY`, la API responde `401` con el mismo formato
de error que el resto de endpoints (`{ error: { type: "UNAUTHORIZED", message }, correlationId }`).
La comparación se hace en tiempo constante (`crypto.timingSafeEqual`,
`src/controllers/requireApiKey.ts`) para no filtrar información por temporización.

`GET /health/live` y `GET /health/ready` quedan **fuera** de este middleware a propósito: deben
seguir siendo accesibles sin autenticación para que el orquestador/monitor pueda comprobar el
estado del proceso.

Los consumidores internos de AZA (ERP, app móvil, workers, etc.) deben recibir su copia de
`AZA_API_KEY` por un canal seguro (gestor de secretos, variable de entorno inyectada por el
orquestador), nunca hardcodeada en el código ni en repositorios.

## Multi-almacén

El usuario técnico de LUX (`LUX_USERNAME`) opera sobre varios almacenes, seleccionables mediante
la cabecera `Almacen` (ver `src/lux/warehouses.ts` para la lista cerrada de códigos válidos:
`SAGUNTO`, `CHESTECM`, `ALMUSSAFES`, `MONTAVERNER`, `CHESTE`). `LUX_WAREHOUSE` en `.env` es solo el
almacén **por defecto**.

* **API propia (`/api/*`)**: añade la cabecera `Almacen` a la petición para operar sobre un
  almacén distinto al de configuración:

  ```bash
  curl -H "X-Api-Key: $AZA_API_KEY" -H "Almacen: CHESTE" http://localhost:3000/api/expediciones
  ```

  Un valor no reconocido devuelve `400` sin llegar a llamar a LUX.
* **Interfaz web (`/almacen/*`)**: desplegable "Almacen" en la cabecera de la pantalla; el valor
  elegido se guarda en la sesión (no es global ni compartido entre usuarios) y afecta a los
  listados y detalles siguientes, hasta que se cambie o se cierre sesión.

## Interfaz web para el personal de almacén (`/almacen/*`)

Además de la API `/api/*` (pensada para otros sistemas), hay una interfaz web propia, renderizada
por el mismo servidor Express (plantillas EJS, sin build ni frontend aparte), para que el personal
de almacén consulte expediciones y recepciones desde el navegador. **Es un sistema de
autenticación totalmente independiente de `AZA_API_KEY`**: no sirve para llamar a `/api/*`, y no
usa las credenciales de LUX.

* Alcance de esta primera versión: **solo lectura** — login, listado con filtros
  (`propietario`, `estado`, texto libre) y detalle de expediciones/recepciones, y logout. No hay
  alta/edición desde la web, ni autorregistro de usuarios, ni roles distintos por usuario.
* Los usuarios (usuario + contraseña, con hash `bcrypt`) se guardan en una base de datos SQLite
  embebida local (`data/web-users.sqlite3`, creada automáticamente; no se versiona en git porque
  contiene hashes de contraseñas reales). Se crean/actualizan con un script de línea de comandos:

  ```bash
  npm run create-web-user -- <usuario> <password>
  ```

  Si el usuario ya existe, esto actualiza su contraseña en vez de fallar. No hay pantalla de
  registro: los usuarios los crea quien administra el servidor.
* Requiere la variable de entorno obligatoria `SESSION_SECRET` (ver `.env.example`); genérala con
  `openssl rand -hex 32`, igual que `AZA_API_KEY`.
* Sesiones con `express-session` y el `MemoryStore` por defecto (sin configuración extra): esto
  significa que **las sesiones se pierden si el proceso se reinicia** y que **no escala a varias
  instancias/workers** (cada una tendría sus propias sesiones en memoria). Aceptado
  deliberadamente para esta primera versión; no se soluciona todavía.
* Con el servidor arrancado (`npm run dev` o `npm start`), la interfaz se sirve en
  `http://localhost:3000/almacen/login` (o el `PORT` configurado). Tras iniciar sesión, redirige a
  `http://localhost:3000/almacen/expediciones`.

## Watcher de logs LUX (near-real-time)

Proceso **independiente** del servidor HTTP (`npm run watch-logs`, `scripts/watchLuxLogs.ts`) que
vigila los logs propios de LUX (no la API — el fichero de log del servidor Java en una unidad de
red) para detectar cuando cambia el estado de un pedido, sin tener que hacer polling constante a
la API.

* Vigila 9 tipos de acción (ver `docs/lux-api-analysis.md` §16 y `docs/progress.md` fases 24-26),
  tanto de expediciones como de recepciones:
  * Alta/edición de cabecera (`p_expCabeceraAza`/`p_recCabeceraAza @accion='ACTUALIZAR'`, del PDF)
    — dirección, transportista, service level, etc. Un alta (id `'0'`) se resuelve por el texto
    del pedido/albarán, ya que LUX aún no ha asignado el id real en ese momento.
  * Alta/edición de línea (`p_expPedidoLineas`/`p_recAlbaranLineas`, del PDF).
  * Cierre de picking con/sin discrepancias (`p_wm_expSinConsolidar @estado='CERRAR'`, no
    documentado, confirmado en vivo).
  * Cierre de oficina (`p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR'`, no documentado).
  * **Cierre por asignación a ruta** (`p_expRutasDetalle @accion='INSERT'`, no documentado) —
    tercera vía de cierre distinta a las dos anteriores, confirmada con un caso real.
  * Pasar a almacén (`p_expPasarAlmacenPC @accion='PASAR_ALMACEN_WMS'`, no documentado).
  * Envío de ruta (`p_expRutas @accion='ENVIAR_FORZAR'`, no documentado), resuelto a los pedidos
    de esa ruta vía `p_expRutasDetalle` (tampoco documentado).
  * **Importante**: el mismo procedimiento puede loguearse con el parámetro de acción en
    minúsculas y justo después del nombre (llamadas de nuestra propia API) o en **mayúsculas y en
    cualquier posición** de la línea (llamadas desde la UI de LUX/PDA). El motor de patrones lo
    detecta en ambos casos — esto fue un bug real corregido en la fase 26, no una teoría.
* Al detectar una, re-consulta el pedido/albarán afectado contra LUX (reutilizando
  `ExpedicionesService`/`RecepcionesService` directamente, sin pasar por `/api/*`) y registra el
  resultado en su propio log estructurado (`watcher.pedidoActualizado` /
  `watcher.albaranActualizado`). Si una línea no trae ninguna referencia resoluble a un
  pedido/albarán (p. ej. un `UPDATE` de línea que solo lleva el id de la propia línea), se
  registra un aviso (`watcher.sinReferencia`) en vez de ignorarlo en silencio. Por ahora **no**
  escribe en ninguna base de datos — es la base para conectar algo después.
* Variables propias (ver `.env.example`): `LUX_LOG_PATH`, `LUX_MOBILE_LOG_PATH` (rutas a los
  ficheros de log activos), `WATCHER_POLL_MS` (sondeo, por defecto 3 s),
  `WATCHER_DEBOUNCE_MS` (agrupa varias líneas seguidas del mismo pedido en una sola re-consulta,
  por defecto 5 s).
* Es de **"mejor esfuerzo"**, no una fuente de verdad transaccional: si el proceso está parado o
  la unidad de red no está disponible un momento, no reprocesa retroactivamente. Para
  consistencia fuerte haría falta además una reconciliación periódica (polling por ventana,
  documentado como alternativa en `docs/progress.md` fase 24).

```bash
npm run watch-logs
```

## Ejecutar

```bash
npm install
npm run build   # compila a dist/
npm start       # node dist/src/server.js

npm run dev     # modo desarrollo con recarga (tsx watch)
```

El servidor expone:

* `GET /health/live` — liveness (no llama a LUX).
* `GET /health/ready` — readiness (valida configuración + estado cacheado de auth).
* `GET|POST /api/expediciones`, `GET|PUT /api/expediciones/:idPedido`,
  `GET|POST /api/expediciones/:idPedido/lineas`, `PUT /api/expediciones/:idPedido/lineas/:idLinea`.
* Equivalentes en `/api/recepciones`.
* `GET /api/catalogos/:tipo` (`cargas`, `service-level`, `descargas`, `transportistas`,
  `propietarios`, `tipos`, `pedido-estado`, `pedido-tipos`).
* `GET|POST /almacen/login`, `POST /almacen/logout` — interfaz web de almacén (ver sección
  anterior), autenticación por sesión, independiente de `X-Api-Key`.
* `GET /almacen/expediciones[/:idPedido]`, `GET /almacen/recepciones[/:idAlbaran]` — requieren
  sesión iniciada (si no, redirigen a `/almacen/login`).

## Tests

```bash
npm test
```

Incluye tests unitarios (`tests/auth`, `tests/lux`, `tests/expediciones`, `tests/recepciones`) y
de integración end-to-end (`tests/integration`) contra un **mock HTTP completo de LUX**
(`tests/mocks/luxMockServer.ts`), sin necesidad de red real ni de un entorno LUX de pruebas.

## Reglas no negociables aplicadas

* Whitelist de 7 procedimientos autorizados (`src/lux/procedures/whitelist.ts`); cualquier otro
  nombre se rechaza localmente antes de llamar a LUX.
* `usuario` y `almacen` nunca se envían en el body de `/proc` (se filtran defensivamente en
  `LuxClient.callProc` aunque un llamador los incluya por error).
* Semántica de "datos extra" (`null` = no tocar, `""` = borrar, valor = fijar) centralizada en
  `src/lux/utils/procBody.ts` (`buildProcBody`), con tests dedicados.
* Fechas siempre `dd/MM/yyyy` hacia LUX, vía `src/lux/utils/dateFormatter.ts`.
* Reintentos (`LuxClient`) solo en errores de red o HTTP 5xx, **nunca** en 4xx/errores
  funcionales, y **nunca** en acciones de escritura (`ACTUALIZAR`/`INSERT`/`UPDATE`) para evitar
  duplicados.
* Logging estructurado (JSON) sin loguear nunca `password`, `token`, `refreshToken` ni el header
  `Authorization` (redacción automática en `src/logging/logger.ts`).
* `crearExpedicion`/`crearRecepcion` nunca crean líneas si la cabecera falla, y reportan líneas
  OK vs. fallidas por separado; una línea individual mal formada (falla de validación) nunca hace
  perder la cabecera ya creada ni bloquea al resto de líneas válidas del mismo lote.
* Toda la API propia de AZA (`/api/*`) exige la cabecera `X-Api-Key` (ver sección de
  autenticación más arriba); `/health/*` sigue siendo público.
* `lineas` en la creación de expediciones/recepciones tiene un límite operativo de 200 elementos
  por petición (no forma parte del contrato de LUX, es una protección propia de AZA).

## TODOs pendientes por falta de información en la documentación del proveedor

Ver la lista completa y razonada en [`docs/progress.md`](docs/progress.md). Resumen: formato
exacto de la respuesta de `/login/refreshToken`, nombres de campos de dirección de facturación
(`...F`), catálogo cerrado de códigos `ERR_*`, paginación de listados, e idempotencia nativa de
LUX — ninguno de estos puntos está definido en el PDF del proveedor, así que no se ha inventado
ningún comportamiento; se documenta y se continúa con el resto de la implementación.
