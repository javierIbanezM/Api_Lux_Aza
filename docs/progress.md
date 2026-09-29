# Progreso de la implementación

| Fase | Estado | Notas |
|---|---|---|
| 0 — Inventario | COMPLETADO | `docs/audit.md`. Proyecto vacío (greenfield), sin código previo que reutilizar. |
| 1 — Análisis LUX | COMPLETADO | `docs/lux-api-analysis.md`, extraído íntegramente del PDF del proveedor. |
| 2 — Arquitectura | COMPLETADO | `docs/architecture.md`. |
| 3 — Implementación base (config/auth/LuxClient/errores/logging) | COMPLETADO | `src/config`, `src/auth`, `src/lux/client`, `src/lux/errors`, `src/logging`. |
| 4 — Expediciones | COMPLETADO | `src/services/expediciones`, `src/controllers/expedicionesController.ts`, `src/routes/expedicionesRoutes.ts`. |
| 5 — Recepciones | COMPLETADO | `src/services/recepciones`, `src/controllers/recepcionesController.ts`, `src/routes/recepcionesRoutes.ts`. |
| 6 — Tests (unitarios, integración, mocks) | COMPLETADO | `tests/`. 67/67 tests pasando (`npm test`). |
| 7 — Seguridad | COMPLETADO | Whitelist de procedimientos, `usuario`/`almacen` nunca en body, logger con redacción de secretos, `.gitignore` revisado, sin credenciales reales en el repo (ver `docs/audit.md` sección de riesgos). |
| 8 — Code review | COMPLETADO | Build (`tsc --strict`) y lint (`eslint`) sin errores; revisión de la jerarquía de errores, política de retries y semántica de datos extra cubierta por tests dedicados. |
| 9 — Documentación final (README, .env.example) | COMPLETADO | `README.md`, `.env.example`, `docs/openapi.yaml`. |
| 10 — Auditoría de seguridad independiente y correcciones | COMPLETADO | Ver sección siguiente. |
| 11 — Documentación interactiva (Swagger UI) | COMPLETADO | `GET /docs` sirve `docs/openapi.yaml`; corregido de paso un bug preexistente en `package.json` (`main`/`start` apuntaban a `dist/server.js` en vez de `dist/src/server.js`, por lo que `npm start` fallaba tras el build). |
| 12 — Prueba end-to-end contra el servidor LUX real (SAGUNTO) | COMPLETADO | Ver sección siguiente. |
| 13 — Interfaz web de solo lectura para personal de almacén (`/almacen/*`) | COMPLETADO | `src/web/`, `scripts/createWebUser.ts`. Ver sección siguiente. |
| 14 — `p_expPedidoContenedores` (contenedores/bultos de expedición) | COMPLETADO | No documentado en el PDF; confirmado por prueba directa contra LUX real. Ver sección siguiente. |
| 15 — Ordenación de columnas en listados (`/almacen`) | COMPLETADO | `src/web/sorting.ts`. Clic en cabecera (Id, Pedido, Propietario, Cliente, Estado, Tipo, Fecha / Id, Albaran, Propietario, Estado) alterna asc/desc, preservando filtros. Verificado con datos reales. |
| 16 — Soporte multi-almacén | COMPLETADO | `src/lux/warehouses.ts`, cabecera `Almacen` opcional en `/api/*`, selector en `/almacen`. Ver sección siguiente. |

## Fase 16 — Multi-almacén (2026-09-29)

Hasta ahora la aplicación operaba siempre sobre un único almacén fijo (`LUX_WAREHOUSE` en
`.env`). El usuario confirmó que el usuario técnico `interfaz` opera sobre 5 almacenes:
`SAGUNTO`, `CHESTECM`, `ALMUSSAFES`, `MONTAVERNER`, `CHESTE` (lista aportada por AZA, no
documentada en el PDF — LUX no expone ningún procedimiento de catálogo de almacenes).

Cambios:

* `src/lux/warehouses.ts` — lista cerrada de almacenes válidos (`WAREHOUSES`) +
  `isValidWarehouse()`.
* `LuxClient.callProc(..., { almacen })` — el almacén ahora es un parámetro por llamada (antes
  fijo desde `config.luxWarehouse`); si no se indica, usa el de configuración como antes.
* Todos los métodos de `ExpedicionesService`, `RecepcionesService` y `CatalogosService` aceptan
  un `almacen?: string` opcional y lo propagan. La caché de `CatalogosService` ahora es por
  almacén (evita devolver el catálogo de un almacén distinto al pedido).
* `/api/*`: nueva cabecera opcional `Almacen` (misma convención que usa LUX hacia nosotros) en
  todos los endpoints de expediciones, recepciones y catálogos — validada contra la whitelist de
  almacenes antes de llamar a LUX (`src/controllers/resolveAlmacen.ts`); un valor desconocido
  devuelve `400` sin llegar a LUX. Sin la cabecera, se usa `LUX_WAREHOUSE` (comportamiento previo,
  sin romper compatibilidad).
* `/almacen` (interfaz web): selector de almacén en la cabecera (desplegable con los 5 almacenes),
  guardado en la sesión (`req.session.almacen`) vía `POST /almacen/set-almacen`; por defecto el de
  `LUX_WAREHOUSE` al iniciar sesión. Afecta a listados y detalle de expediciones/recepciones.
* Verificado contra LUX real: el usuario técnico tiene acceso efectivo a SAGUNTO, CHESTE y
  ALMUSSAFES (probados con `200 OK`); el selector web cambia correctamente el almacén activo y se
  refleja en las siguientes consultas.

Tests: 108/108 en verde. Nuevos: `tests/lux/warehouses.test.ts`, 2 tests en `LuxClient.test.ts`
(almacén por defecto vs. override), 2 tests de integración en `expediciones.integration.test.ts`
(cabecera `Almacen` reenviada / rechazo de almacén desconocido), 2 tests de integración en
`web.integration.test.ts` (cambio de almacén vía selector / valor inválido ignorado).

## Fase 14 — Contenedores de expedición (2026-09-29)

El usuario aportó un ejemplo real de uso de `p_expPedidoContenedores`
(`{"accion":"SELECT_INICIO","idParent":"41216"}`), un procedimiento **ausente del PDF del
proveedor**. Se confirmó contra el servidor real de LUX (`SAGUNTO`) con un pedido real
(`idPedido=5034`, propietario `CAMELIA`), obteniendo el detalle de contenedores/bultos a nivel de
HU (unidad de manipulación) de esa expedición. Ver `docs/lux-api-analysis.md` §14 para el detalle
completo de campos confirmados.

Integrado como funcionalidad de solo lectura:

* Añadido a la whitelist (`src/lux/procedures/whitelist.ts`) — ahora 7 procedimientos autorizados.
* Modelo `ExpedicionContenedor` (`src/lux/models/expedicion.ts`).
* `ExpedicionesService.obtenerContenedoresExpedicion(idPedido)`.
* `GET /api/expediciones/:idPedido` ahora incluye `contenedores` en el detalle; también expuesto
  en `GET /api/expediciones/:idPedido/contenedores`.
* Visible en `/almacen/expediciones/:id` (interfaz web).
* Verificado end-to-end contra LUX real: `GET /api/expediciones/5034` devuelve los 3 contenedores
  reales del pedido.
* No se ha probado ninguna acción de escritura sobre este procedimiento (solo `SELECT_INICIO`); no
  se sabe si existe un equivalente para recepciones (TODO, no confirmado, no se inventa).

Tests: 91/91 en verde (`npm test`), incluyendo test unitario de
`ExpedicionesService.obtenerContenedoresExpedicion`, ampliación del test de whitelist (7
procedimientos) y del test de integración de detalle de expedición.

## Fase 13 — Interfaz web de almacén (2026-09-29)

Primera versión (alcance deliberadamente acotado) de una interfaz web para que el personal de
almacén consulte expediciones y recepciones desde el navegador, sin tocar la API `/api/*`
existente (sistema de autenticación totalmente aparte, pensado para máquinas, no para personas):

* **Alcance**: login/logout con cuentas propias de AZA, listado con filtros
  (`propietario`, `estado`, texto libre) y detalle (cabecera + datos extra + líneas) de
  expediciones y recepciones, reutilizando `ExpedicionesService`/`RecepcionesService` tal cual.
  Deliberadamente **fuera de alcance**: alta/edición desde la web, autorregistro de usuarios,
  roles/permisos distintos por usuario.
* **Usuarios**: base de datos SQLite embebida (`better-sqlite3`, sin servidor de base de datos
  aparte) en `data/web-users.sqlite3` (no versionada, añadida a `.gitignore`), con contraseñas
  con hash `bcrypt` (`bcryptjs`, siempre comparadas con `bcrypt.compare`, nunca igualdad de
  string). Se crean/actualizan con `npm run create-web-user -- <usuario> <password>`
  (`scripts/createWebUser.ts`); si el usuario ya existe, actualiza la contraseña en vez de fallar.
* **Sesiones**: `express-session` con `MemoryStore` por defecto — limitación conocida y aceptada
  para esta fase (se pierden al reiniciar el proceso, no escala a varias instancias/workers de
  PM2). Nueva variable de entorno obligatoria `SESSION_SECRET` (`src/config/env.ts`,
  `.env.example`).
* **Vistas**: EJS (`src/web/views/*.ejs`) con un layout manual sin dependencias extra
  (`req.app.render` + inyección en `layout.ejs`), estilo `<style>` inline básico, sin librería
  CSS externa ni build de frontend aparte.
* **Rutas** bajo `/almacen/*`: `GET|POST /almacen/login`, `POST /almacen/logout`,
  `GET /almacen/expediciones[/:idPedido]`, `GET /almacen/recepciones[/:idAlbaran]`. Todas salvo
  `/login` exigen sesión iniciada (`src/web/requireWebSession.ts`); sin sesión, redirigen a
  `/almacen/login` en vez de devolver un error JSON.
* **Tests nuevos**: `tests/web/users.test.ts` (hash/verificación de contraseña, alta y
  actualización de usuario, con SQLite en memoria) y
  `tests/integration/web.integration.test.ts` (sin sesión → redirect a login; login
  correcto → acceso 200 a expediciones/recepciones con la cookie de sesión; logout invalida la
  sesión). `createApp()` ahora acepta una base de datos de usuarios inyectable (`webDb`) para
  poder aislar estos tests de `data/web-users.sqlite3`.
* **Verificación manual end-to-end**: arrancado `npm run dev` (puerto 3000, variables cargadas
  desde `.env` real, incluido `LUX_BASE_URL` de producción SAGUNTO), creado el usuario de prueba
  con el script CLI, y confirmado con `curl` (cookies vía `-c`/`-b`):
  `POST /almacen/login` → `302` a `/almacen/expediciones` con `Set-Cookie`; `GET
  /almacen/expediciones` sin cookie → `302` a `/almacen/login`; con la cookie → `200 OK` (se usó
  un filtro de texto sin coincidencias para no descargar datos reales de producción durante la
  prueba, ver §12 sobre volumen/PII en listados sin filtrar).
* Resultado: build (`tsc --strict`) y lint (`eslint`) sin errores; **89/89 tests en verde**
  (`npm test`, 11 archivos de test), incluyendo los 10 tests nuevos de esta fase
  (`tests/web/users.test.ts`: 5, `tests/integration/web.integration.test.ts`: 5).

## Prueba end-to-end contra LUX real (2026-09-29)

Con `LUX_BASE_URL=http://192.168.2.145:8081`, `LUX_USERNAME=interfaz`, `LUX_WAREHOUSE=SAGUNTO`:

* `POST /login` real → `200 OK`, sesión cacheada correctamente.
* **Bug real encontrado y corregido**: `issuedAt`/`expiresAt` de LUX vienen en formato
  `java.time.ZonedDateTime` (`"2026-10-09T12:45:23.081Z[UTC]"`), que `Date.parse` de JS no
  reconoce por el sufijo `[UTC]`. Sin el fix, cada sesión se habría tratado como expirada de
  inmediato, forzando un `refresh` innecesario en cada petición. Corregido en
  `src/auth/AuthManager.ts` (`parseExpiry`), con test dedicado. 79/79 tests en verde tras el fix.
* `GET /api/expediciones?propietario=CAMELIA&estado=TODOS` (nuestra API propia) → `200 OK` con
  datos reales de producción del almacén de Sagunto, confirmando el flujo completo: login
  automático → `PUT /proc/p_expedicionesAza` con `accion=SELECT` → respuesta mapeada.
* Hallazgo operativo: esa única consulta sin filtro de fecha devolvió >1000 filas / >1MB de JSON.
  Se documenta en `docs/lux-api-analysis.md` §12 como recomendación de filtrar siempre por fecha
  en listados de volumen alto (LUX no pagina).
* Nota de higiene de datos: esa respuesta contenía PII real de clientes (nombres, direcciones) y
  quedó momentáneamente en un fichero temporal de esta sesión de Claude Code fuera del proyecto;
  se avisó al usuario para que lo borre manualmente si lo desea (no se pudo borrar automáticamente
  por protección de la propia sesión).

## Resultado final

* Build: `npm run build` — OK, sin errores (TypeScript `strict: true`).
* Lint: `npm run lint` — OK, sin errores.
* Tests: `npm test` — **89 passed, 0 failed** (11 archivos de test, tras añadir la interfaz web
  de almacén en la fase 13).

## Auditoría de seguridad independiente (2026-09-07)

Una revisión de seguridad independiente encontró los siguientes hallazgos, todos corregidos:

1. **CRÍTICO — API HTTP propia de AZA sin autenticación.** `/api/expediciones`,
   `/api/recepciones` y `/api/catalogos` no exigían ninguna credencial: cualquiera con acceso de
   red podía crear/modificar pedidos y recepciones reales. **Corregido**: nueva variable
   obligatoria `AZA_API_KEY` + middleware `requireApiKey`
   (`src/controllers/requireApiKey.ts`, comparación en tiempo constante con
   `crypto.timingSafeEqual`) montado delante de todo `/api/*`. `/health/*` sigue siendo público a
   propósito. Ver README, sección "Autenticación de la API propia de AZA".
2. **CRÍTICO — una línea inválida hacía perder la cabecera ya creada en LUX.** En
   `ExpedicionesService.crearExpedicion`/`RecepcionesService.crearRecepcion`, la validación de
   cada línea se ejecutaba fuera del `try` de esa misma línea; un fallo de validación (p. ej.
   falta `referencia`) lanzaba y se propagaba fuera de todo el método, perdiendo la cabecera ya
   creada en LUX y las líneas ya insertadas en el mismo lote. **Corregido**: la validación de
   cada línea ahora vive dentro del mismo `try` que la llamada a LUX (se reporta en `fallidas`
   sin abortar el método); además se relajó la validación del array `lineas` a nivel de la
   petición completa (`crearExpedicionSchema`/`crearRecepcionSchema`) para que ya no rechace la
   petición entera por una única línea mal formada — esa validación por línea ahora ocurre
   exclusivamente dentro del servicio. Tests: `tests/expediciones/ExpedicionesService.test.ts`,
   `tests/recepciones/RecepcionesService.test.ts`.
3. **ADVERTENCIA — sin límite de tamaño en el array de líneas.** Añadido `.max(200)` (límite
   operativo propio de AZA, no del contrato de LUX) en `src/validation/expediciones.ts` y
   `src/validation/recepciones.ts`, con tests de integración que confirman `400` sin llegar a
   llamar a LUX.
4. **ADVERTENCIA — JSON malformado se reportaba como 500.** `src/controllers/errorHandler.ts`
   ahora reconoce el `SyntaxError` de `express.json()` (`status`/`statusCode === 400` +
   `type === 'entity.parse.failed'`) y lo traduce a `400 INVALID_JSON`, con test de integración.
5. **MENOR — dependencia axios desactualizada.** Actualizada de `^1.7.9` a `^1.20.0` (última 1.x
   estable), sin cambios de comportamiento; build y tests siguen en verde.
6. **MENOR — `/health/ready` exponía el código de almacén sin autenticación.** Al quedar esa ruta
   fuera del middleware de API key (debe seguir siendo pública), se redujo la respuesta a
   `{ status, ready }`; el detalle de almacén se registra ahora en un log interno
   (`logger.debug`), nunca en el body HTTP.
7. **MENOR — enlace roto a `docs/troubleshooting.md`.** Creado con contenido real: política
   de reintentos (solo red/timeout/5xx, nunca en escrituras ni en 4xx/funcionales), qué hacer ante
   una cabecera creada con líneas fallidas (consultar por pedido/albarán, no reintentar la
   cabecera), y la ausencia de idempotency-key nativo en LUX (número de pedido/albarán como clave
   de facto).

## Bloqueos / TODO pendientes por falta de información en la documentación

Todos documentados también in situ en el código con el comentario
`TODO — INFORMACION NO DEFINIDA EN LA DOCUMENTACION`:

1. Formato exacto de la respuesta de `POST /login/refreshToken` (si siempre devuelve un nuevo
   `refreshToken` o solo `token`). Implementado de forma defensiva: si no llega `refreshToken`
   nuevo, se reutiliza el anterior.
2. Formato exacto de `issuedAt`/`expiresAt` del login (se asume ISO-8601 parseable por
   `Date.parse`; si no lo es, se trata como sesión ya expirada para forzar refresh/login, nunca
   se asume una sesión válida indefinidamente).
3. Nombres exactos de los campos de dirección de facturación (`...F`) en `p_expCabeceraAza`.
4. Lista cerrada de valores posibles para `estado` (más allá de `TODOS`) — se obtiene en tiempo
   de ejecución vía `pedido_estado`/`pedido_tipos`, no se inventa ninguna lista.
5. Catálogo de códigos `ERR_*` completo — solo se documenta `ERR_TRANSPORTISTA_NOT_EXISTS`; el
   resto se trata como error funcional genérico y se propaga tal cual (`LuxFunctionalError`).
6. Paginación de los listados `SELECT` — no documentada, no implementada (no se inventa).
7. Mecanismo de idempotencia nativo de LUX — no documentado; no se implementa un idempotency-key
   propio no soportado por LUX. Ver `docs/architecture.md` (sección de transacciones y
   consistencia) para la estrategia adoptada (reporte de líneas ok/fallidas, sin reintentos
   automáticos de escritura).
8. Acción equivalente a `pedido_estado`/`pedido_tipos` para el listado de recepciones
   (`p_recepcionesAza`) — no confirmada en el PDF; `CatalogosService` solo expone estas acciones
   sobre `p_expedicionesAza`, tal como aparece documentado.
