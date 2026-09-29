# FASE 2 — Arquitectura de la integración AZA ↔ API LUX (Whales)

## Visión general

```text
AZA (código de aplicación / consumidor)
        |
        v
+-------------------------------------------------------+
|                 Librería de integración                |
|                                                         |
|  services/  (ExpedicionesService, RecepcionesService,   |
|              CatalogosService)                          |
|        |                                                |
|  lux/client/ (LuxClient: HTTP, headers, serialización)  |
|        |                                                |
|  auth/ (AuthManager: login, refresh, cache de token)     |
+-------------------------------------------------------+
        |
        | PUT /proc/{procedimiento}   (JSON string→string)
        v
     API LUX  ──EXEC p_xxx @param='valor', ...──>  SQL Server / Whales
```

La integración se modela como **librería + servidor HTTP fino opcional**, no como monolito:

* El núcleo (`src/lux`, `src/auth`, `src/services`) es reutilizable desde cualquier consumidor
  Node.js (un backend existente de AZA, un worker, un script de migración de datos, tests).
* `src/server.ts` expone esa librería como una API HTTP propia de AZA (opcional) con
  `controllers/` + `routes/`, pensada para que otros sistemas de AZA (ERP, app móvil, etc.)
  consuman expediciones/recepciones sin hablar directamente con LUX ni conocer sus procedimientos.

## Capas

### 1. `config/`

Carga y valida variables de entorno (`LUX_BASE_URL`, `LUX_USERNAME`, `LUX_PASSWORD`,
`LUX_WAREHOUSE`, `LUX_TIMEOUT_MS`, `LUX_REFRESH_MARGIN_MS`, `LOG_LEVEL`, `PORT`, `AZA_API_KEY`,
`SESSION_SECRET`). Falla rápido (`process.exit`) si falta una variable obligatoria, en vez de
fallar más tarde con un error confuso. `AZA_API_KEY` es la clave compartida que exige
`requireApiKey` (ver §10) a todos los consumidores de `/api/*`. `SESSION_SECRET` es el secreto de
firma de las cookies de sesión de la interfaz web de almacén (`/almacen/*`, ver §10bis) — un
sistema de autenticación totalmente aparte, para personas, no para sistemas.

### 2. `auth/`

`AuthManager`: única responsabilidad — mantener un JWT válido.

* `login()` — `POST /login`.
* `getValidToken()` — devuelve el token en caché si no ha expirado (con margen de seguridad
  `LUX_REFRESH_MARGIN_MS`); si va a expirar, lo refresca; si no hay sesión, hace login.
* `refresh()` — `POST /login/refreshToken`; si falla, invalida la sesión y fuerza login en la
  siguiente petición.
* Un único refresh en curso a la vez (mutex en memoria) para evitar refresh concurrentes cuando
  varias peticiones llegan a la vez con el token a punto de caducar.
* Nunca loguea el password, el JWT ni el refreshToken (solo metadatos: `expiresAt`, éxito/fallo).

### 3. `lux/client/` — `LuxClient`

Responsable exclusivamente de **hablar HTTP con LUX**:

* Añade `Authorization`, `Almacen`, `Content-Type` a cada llamada de datos. El valor de `Almacen`
  es un parámetro por llamada (`CallProcOptions.almacen`, ver `src/lux/warehouses.ts` para la
  lista cerrada de almacenes válidos), no un valor fijo: si no se indica, usa
  `config.luxWarehouse` como almacén por defecto. Esto permite que un mismo despliegue opere sobre
  varios almacenes (API `/api/*` vía cabecera `Almacen`, interfaz web vía selector en sesión), tal
  como documenta LUX en §2.3 del análisis.
* `callProc(procedimiento, accion, params, options)`:
  1. Valida que `procedimiento` está en la whitelist (`lux/procedures/whitelist.ts`) y empieza por
     `p_` → si no, error `403` local (falla antes de llamar a LUX).
  2. Construye el body plano `string→string` (nunca incluye `usuario`/`almacen`).
  3. Ejecuta `PUT /proc/{procedimiento}` con el token vigente (`AuthManager.getValidToken()`).
  4. Interpreta la respuesta: HTTP ok + `mensaje !== "OK"` ⇒ `LuxFunctionalError`; HTTP no-2xx ⇒
     `LuxHttpError`; error de red/timeout ⇒ `LuxNetworkError`.
  5. Reintenta (con backoff) **solo** en `LuxNetworkError` y HTTP `5xx`, nunca en `4xx` ni en
     errores funcionales, y nunca si la operación es de escritura y ya existe evidencia de que la
     petición llegó al servidor (ver `docs/troubleshooting.md`).
* No conoce reglas de negocio de AZA (no sabe qué es una "expedición"): solo sabe de
  procedimientos, acciones y parámetros.

### 4. `lux/models/` — DTOs

`LoginRequest`, `LoginResponse`, `RefreshTokenRequest`, `ProcRequest`, `ProcResponse`,
`Expedicion`, `ExpedicionLinea`, `Recepcion`, `RecepcionLinea`, `LuxError`. Todos los campos que
LUX trata como string se tipan como `string` (no se inventan tipos numéricos/boolean que la
documentación no confirma); la conversión a tipos de dominio (números, `Date`) ocurre en la capa
de servicios, nunca dentro del `LuxClient`.

### 5. `lux/errors/`

Jerarquía de errores: `LuxError` (base) → `LuxNetworkError`, `LuxHttpError`, `LuxAuthError`,
`LuxFunctionalError`, `LuxValidationError` (validación local de AZA antes de llamar a LUX). Cada
una lleva suficiente contexto para logging (procedimiento, acción, `correlationId`) sin filtrar
secretos.

### 6. `lux/utils/`

* `dateFormatter.ts` — único punto de conversión `Date ⇄ "dd/MM/yyyy"` hacia/desde LUX.
* `procBody.ts` — `buildProcBody()` construye el diccionario `string→string` respetando la
  semántica `null` (omitir clave) / `""` (borrar) / valor (fijar) de forma centralizada y
  testeable, para que ningún servicio la reimplemente de forma inconsistente.

### 7. `services/`

Lógica de aplicación de AZA sobre los procedimientos de LUX (nombres de funciones conceptuales
del documento de instrucciones, ver `docs/expediciones.md` y `docs/recepciones.md`):

* `ExpedicionesService`: `crearExpedicion`, `actualizarExpedicion`, `crearLineaExpedicion`,
  `actualizarLineaExpedicion`, `listarExpediciones`, `obtenerExpedicion`,
  `obtenerLineasExpedicion`, `obtenerDatosExtraExpedicion`.
* `RecepcionesService`: `crearRecepcion`, `actualizarRecepcion`, `crearLineaRecepcion`,
  `actualizarLineaRecepcion`, `listarRecepciones`, `obtenerRecepcion`, `obtenerLineasRecepcion`,
  `obtenerDatosExtraRecepcion`.
* `CatalogosService`: envuelve las acciones `SELECT_CARGAS`, `SELECT_SERVICE_LEVEL`,
  `SELECT_DESCARGAS`, `select_transportistas`, `select_propietarios`, `select_tipos`,
  `pedido_estado`, `pedido_tipos`, con caché en memoria de corta duración (TTL configurable, no
  indefinida — ver §40 del documento de instrucciones).

`crearExpedicion`/`crearRecepcion` implementan el flujo de dos pasos (cabecera → líneas) descrito
en §8 del análisis LUX, y **no crean líneas si la cabecera falló**.

### 8. `validation/`

Validación básica de entrada de AZA (procedimiento permitido, acción válida, campos obligatorios
presentes, formato de fecha, tipo numérico) con `zod`. Explícitamente **no** duplica reglas de
negocio de Whales (existencia de propietario/transportista/proveedor, etc.) — eso lo valida LUX y
se traduce a `LuxFunctionalError`.

### 9. `logging/`

Logger estructurado (JSON por línea) con campos: `timestamp`, `correlationId`, `operacion`,
`procedimiento`, `accion`, `almacen`, `resultado`, `duracionMs`, `httpStatus`, `mensajeLux`,
`idPedido`/`idAlbaran`. Nunca registra `password`, `token`, `refreshToken`, ni la cabecera
`Authorization`.

### 10. `controllers/` + `routes/` (servidor HTTP opcional)

Exponen la funcionalidad de `services/` como API REST propia de AZA (no como proxy 1:1 de LUX):
p. ej. `POST /api/expediciones`, `PUT /api/expediciones/:id`, `GET /api/expediciones`,
`GET /api/expediciones/:id`, y equivalentes para recepciones y catálogos. Documentados con
OpenAPI (`docs/openapi.yaml` generado desde anotaciones/zod).

**Autenticación**: todo `/api/*` exige la cabecera `X-Api-Key` (middleware
`requireApiKey`, `src/controllers/requireApiKey.ts`, montado en `app.ts` justo antes de los
routers de `/api/*`). La clave esperada es `config.azaApiKey` (variable `AZA_API_KEY`); la
comparación es en tiempo constante (`crypto.timingSafeEqual`) para no filtrar información por
temporización. Sin la cabecera, o con un valor incorrecto, la API responde `401 UNAUTHORIZED` con
el mismo formato de error que el resto de endpoints. `/health/*` queda deliberadamente fuera de
este middleware (debe seguir siendo público para el orquestador/monitor).

### 10bis. `web/` — interfaz web para el personal de almacen (`/almacen/*`)

Ademas de la API HTTP propia de AZA (`/api/*`, pensada para sistemas), hay una interfaz web
server-rendered (EJS, sin build/frontend aparte) para que el personal de almacen consulte
expediciones y recepciones desde un navegador:

* **Autenticacion totalmente independiente de `/api/*`.** No usa `AZA_API_KEY` ni las
  credenciales de LUX (`LUX_USERNAME`/`LUX_PASSWORD`): son cuentas nuevas, propias de esta
  interfaz, pensadas para personas (usuario + contrasena con hash `bcrypt`), guardadas en una
  base de datos SQLite embebida local (`data/web-users.sqlite3`, `better-sqlite3`, sin servidor
  de base de datos aparte). Los usuarios se crean con el script de linea de comandos
  `npm run create-web-user -- <usuario> <password>` (`scripts/createWebUser.ts`); no hay
  autorregistro. `src/web/users.ts` compara siempre con `bcrypt.compare` (nunca igualdad de
  string) y nunca loguea contrasenas ni hashes.
* **Sesiones con `express-session`**, `MemoryStore` por defecto (`src/web/session.ts`):
  deliberadamente simple para esta primera version. Implica que las sesiones se pierden si el
  proceso se reinicia y que no escala a varias instancias/workers de PM2 (cada una tendria sus
  propias sesiones en memoria); no se resuelve en esta fase, se documenta como limitacion
  conocida. Requiere la variable de entorno obligatoria `SESSION_SECRET`.
* **Solo lectura, sin roles.** Todo usuario logueado ve lo mismo: listado con filtros
  (`propietario`, `estado`, texto libre por `pedido`/`albaran`) y detalle (cabecera + datos
  extra + lineas) de expediciones y recepciones, reutilizando directamente
  `ExpedicionesService`/`RecepcionesService` (los mismos que usa `/api/*`, sin proxy 1:1 a LUX,
  sin nueva logica de negocio). No hay alta/edicion desde la web en esta version.
* **Rutas** (todas bajo `/almacen`, montadas en `app.ts` despues de `/api/*`):
  `GET|POST /almacen/login`, `POST /almacen/logout`, `GET /almacen/expediciones[/:idPedido]`,
  `GET /almacen/recepciones[/:idAlbaran]`. Todas salvo `/login` pasan por el middleware
  `requireWebSession` (`src/web/requireWebSession.ts`), que redirige a `/almacen/login` en vez de
  devolver un error JSON (esto lo consumen personas en un navegador, no sistemas).
* **Vistas** en `src/web/views/*.ejs`, con un patron de "layout" manual sin dependencias extra:
  cada vista de contenido se renderiza primero a un string HTML (`req.app.render`) y se inyecta
  como `body` dentro de `layout.ejs`, que anade cabecera/navegacion/logout cuando hay sesion.
  Estilo con `<style>` inline basico (sin libreria CSS externa): es una herramienta interna, se
  prioriza que funcione y sea legible.
* La ruta de las vistas (`app.set('views', ...)`) y la base de datos de usuarios se resuelven
  contra `process.cwd()` (no `__dirname`), igual que `docs/openapi.yaml` en
  `src/docs/swaggerRouter.ts`, para funcionar igual en `tsx src/server.ts` y en
  `node dist/src/server.js`.

### 11. `health/`

* Liveness: el proceso responde (`GET /health/live`), sin llamar a LUX.
* Readiness: `GET /health/ready` comprueba que hay configuración válida y, opcionalmente, que el
  login contra LUX es posible — no se hace login en cada readiness check (usa el estado cacheado
  del `AuthManager`).
* Ambas rutas son **públicas** (fuera del middleware `requireApiKey`, ver §10) porque las consume
  el orquestador/monitor, no un cliente de negocio. Por eso la respuesta pública de `/health/ready`
  se limita deliberadamente a `{ status, ready }`: no expone detalles de configuración interna
  (p. ej. el código de almacén `LUX_WAREHOUSE`) que antes sí se devolvían en el body. Ese detalle,
  cuando hace falta para depurar, se registra en el log interno (`logger.debug`), nunca en la
  respuesta HTTP.

## Flujo de una petición de creación de expedición

```text
Controller (POST /api/expediciones)
   → valida input básico (validation/)
   → ExpedicionesService.crearExpedicion(dto)
        → LuxClient.callProc("p_expCabeceraAza", "ACTUALIZAR", { idPedido:"0", ... })
        → si mensaje !== "OK" → aborta, no crea líneas, devuelve error
        → si OK → por cada línea:
              LuxClient.callProc("p_expPedidoLineas", "INSERT", { pedido, referencia, ... })
        → agrega resultado: líneas OK vs. líneas fallidas
   ← 201 { idPedido, pedido, lineas: { ok: [...], fallidas: [...] } }
```

## Transacciones y consistencia

Cada llamada a `/proc` es una transacción SQL independiente. Una cabecera + N líneas **no** son
atómicas a nivel HTTP. `ExpedicionesService`/`RecepcionesService` documentan y devuelven
explícitamente qué líneas se crearon y cuáles fallaron, para que el consumidor decida
(reintento manual, compensación, alerta) — no se implementa rollback automático porque LUX no
expone ninguna operación de compensación documentada.

## Configuración por entorno

`test` / `staging` / `production` vía `NODE_ENV` + `.env.<entorno>` (no versionado salvo
`.env.example`). El mock de LUX (`tests/mocks/luxMockServer.ts`) permite ejecutar toda la
aplicación en `test` sin red real.

## Diagrama de dependencias (capas, no ciclos)

```text
controllers/routes  →  services  →  lux/client  →  auth
                                  →  lux/models
                                  →  lux/errors
                     →  validation
                     →  logging
```

`lux/*` no conoce `services/` ni `controllers/`; `auth/` no conoce `lux/client` (es al revés). Esto
permite reutilizar `auth/` + `lux/client` desde cualquier otro consumidor sin arrastrar la capa
HTTP de AZA.
