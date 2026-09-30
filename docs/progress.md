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
| 17 — Datos completos del visor en el detalle de expedición | COMPLETADO | `resumenListado` (65 campos reales de `p_expedicionesAza`) en `/api/expediciones/:id` y en `/almacen/expediciones/:id`. Ver sección siguiente. |
| 18 — Columnas faltantes en tabla de contenedores (`pallet` y otras) | COMPLETADO | `pallet`, `fechaCaducidad`, `observaciones`, dimensiones y peso añadidos a `/almacen/expediciones/:id` → Contenedores (ya los devolvía la API, faltaban en la tabla web). |
| 19 — Zonas de descarga (`SELECT_DESCARGAS`) por propietario en detalle de recepción | COMPLETADO | `CatalogosService.selectDescargas` ahora acepta `propietario`; nuevo campo `descargas` en `/api/recepciones/:id` y `/almacen/recepciones/:id`. Ver sección siguiente. |
| 20 — Tablas de Líneas completas en `/almacen` | COMPLETADO | Columnas dinámicas (34 campos reales en expediciones, 30 en recepciones) en vez de 5 fijas; excluye solo flags `action#*` de la UI de Whales. Ver sección siguiente. |
| 21 — Corrección de host/credenciales LUX mal configurados | COMPLETADO | `.env` apuntaba a un entorno LUX distinto (`.140`) con datos muy diferentes; corregido a `.145` + `interfaz`. Ver sección siguiente. |
| 22 — Carga automática de `.env` (`dotenv`) | COMPLETADO | La app no leía `.env` por sí sola; había que exportarlo a mano en la terminal antes de `npm run dev`/`npm start`. Ver sección siguiente. |
| 23 — Reinicio automático en desarrollo al cambiar `.env` | COMPLETADO | `tsx watch --watch-path .env` en `npm run dev`; evita el problema (repetido 2 veces en esta sesión) de un proceso corriendo con config antigua de `.env`. Ver sección siguiente. |
| 24 — Watcher de logs LUX (near-real-time) | COMPLETADO | `src/watcher/`, `scripts/watchLuxLogs.ts` (`npm run watch-logs`). Detecta 3 acciones de negocio en los logs reales de LUX y re-consulta el pedido afectado. Ver sección siguiente. |
| 25 — Watcher ampliado (altas/ediciones de cabecera y línea, recepciones, pasar a almacén) | COMPLETADO | `src/watcher/luxActionWatcher.ts` (renombrado, ahora cubre expediciones y recepciones); 8 tipos de evento en total. Ver sección siguiente. |
| 26 — Tercera vía de cierre (`p_expRutasDetalle` INSERT) + corrección de bug de mayúsculas/orden | COMPLETADO | Nueva señal `expedicionAsignadaARuta`; reescrito el motor de patrones para no depender de mayúsculas ni orden de parámetros (bug real que hacía fallar varios patrones cuando la acción la hacía la UI de LUX en vez de nuestra API). Ver sección siguiente. |

## Fase 26 — Tercera vía de cierre y corrección de un bug real de mayúsculas/orden (2026-09-30)

Analizando el pedido real `EXP0000076` (propietario `DIPISTOL`, id `11120`, cerrado el
28-sep-2026 15:43:22) a petición del usuario, aparecieron dos hallazgos importantes:

**1. Tercera vía de cierre confirmada**: además de `p_wm_expSinConsolidar`/`CERRAR` y
`p_expediciones`/`CERRAR_OFICINA_FIN_FORZAR`, un pedido también puede cerrarse asignándolo a una
ruta desde la oficina, lo que inserta una fila en `p_expRutasDetalle` que **ya trae el `estado`
resultante en la misma línea** (`CERRADO`, `fechaCierre`, `pedido`, `id`, `propietario`, todo
junto — más completo que el resto de señales). Nuevo tipo de evento:
`expedicionAsignadaARuta` (`p_expRutasDetalle`, `accion=INSERT`).

**2. Bug real encontrado y corregido**: el motor de patrones original (`RULES` con una única
regex por caso, exigiendo el parámetro de acción justo después del nombre del procedimiento)
**fallaba silenciosamente** en varios casos reales. Confirmado con dos ejemplos concretos:

* La línea de `p_expRutasDetalle` de arriba tiene `@ACCION='INSERT'` **al final** de la línea, no
  justo después del nombre del procedimiento.
* Una llamada real a `p_expPedidoLineas` hecha desde la **UI de LUX** (no desde nuestra API) trae
  `@ACCION='INSERT'` en **mayúsculas** y en una posición tardía, mientras que las llamadas que
  hace nuestra propia API (`usuario='interfaz'`) traen `@accion='INSERT'` en minúsculas justo al
  principio. **El mismo procedimiento se loguea de forma distinta según quién lo llama.**

Esto significa que, antes de esta corrección, el watcher probablemente **no detectaba las
acciones hechas manualmente en la UI de LUX** para varios de los patrones (solo las hechas vía
API), un hueco serio dado que el objetivo explícito es vigilar la actividad real del almacén.

**Corrección**: `actionPatterns.ts` reescrito para que cada regla compruebe el procedimiento
(`hasProcedure`, con límite de palabra para no confundir `p_expRutas` con `p_expRutasDetalle` ni
`p_expediciones` con `p_expedicionesAza`) y el valor del parámetro de acción
(`extractParam`, ahora sin distinguir mayúsculas/minúsculas en el nombre del parámetro) **de
forma completamente independiente**, sin asumir adyacencia ni orden. `extractParam` también dejó
de devolver cadenas vacías como si fueran un valor presente (antes `@id=''` se habría tratado
como "hay id"; ahora se trata como ausente, igual que `undefined`).

Tests: 150/150 en verde. Nuevos: 4 casos en `tests/watcher/actionPatterns.test.ts` (el caso real
de `expedicionAsignadaARuta`, que no confunda el `SELECT` de solo lectura del mismo procedimiento,
y el caso de regresión con `@ACCION` en mayúsculas/no adyacente para `p_expPedidoLineas`), y un
escenario end-to-end más en `tests/watcher/luxActionWatcher.test.ts`. Verificado también
reiniciando el proceso real (`npm run watch-logs`) contra los logs reales.

## Fase 25 — Watcher ampliado (2026-09-30)

Ampliación de la fase 24 a petición del usuario: además de los 3 cierres/envío, el watcher ahora
también detecta:

* **Alta o edición de cabecera** de expedición (`p_expCabeceraAza @accion='ACTUALIZAR'`, del PDF)
  y de recepción (`p_recCabeceraAza @accion='ACTUALIZAR'`, del PDF) — incluye cambios de
  dirección, transportista, service level, etc. **Caso especial de alta** (`idPedido`/`idAlbaran`
  `'0'`): en ese momento LUX aún no ha asignado el id real en la línea de log, así que se resuelve
  por el **texto** del pedido/albarán (`p_expedicionesAza`/`p_recepcionesAza` con `SELECT` filtrado
  por ese texto) en vez de por id.
* **Alta o edición de línea** de expedición (`p_expPedidoLineas @accion='INSERT'/'UPDATE'`, del
  PDF) y de recepción (`p_recAlbaranLineas`, del PDF) — usa `idPedido`/`idParent` (o
  `idAlbaran`/`idParent`) de la misma línea, lo que esté presente.
* **"Pasar a almacén"** (`p_expPasarAlmacenPC @accion='PASAR_ALMACEN_WMS'`, no documentado,
  confirmado por el usuario reproduciéndolo en vivo — cuidado de no confundir con la variante de
  eco `PASAR_ALMACEN_WMS_FIN`, que no es una acción nueva).

**Cambios de diseño:**

* Renombrado `ExpedicionWatcher` → `LuxActionWatcher` (`src/watcher/luxActionWatcher.ts`): ya no
  es solo de expediciones. Añadido `RecepcionesService.obtenerResumenListadoRecepcion(albaran)`
  (análogo al de expediciones, fase 17) para poder resolver altas/ediciones de recepción.
- `actionPatterns.ts` reescrito como una lista de reglas (`procedimiento` + `accion`/`estado`
  exacto → extractor de referencia), en vez de una regex monolítica por caso: más fácil de
  extender con nuevas acciones en el futuro. `extractParam()` extrae cada `@nombre='valor'` de
  forma independiente del orden en que aparezcan en la línea (el orden no es constante).
* El debounce ahora agrupa por una clave que prioriza el id interno sobre el texto (`exp:id:X` >
  `exp:pedido:X`), para que varias líneas seguidas de una misma alta (que solo tiene texto hasta
  que se resuelve) no se dupliquen, y para que un alta con `idPedido='0'` compartido por varias
  peticiones distintas no se agrupe erróneamente bajo la misma clave `'0'`.
* **Caso sin referencia resoluble**: un `UPDATE` de línea que solo trae el `id` de la propia línea
  (sin `idPedido`/`idParent`/`pedido`) no se puede resolver a qué pedido pertenece con la
  información de esa única línea de log. En vez de ignorarlo en silencio, se registra un aviso
  (`watcher.sinReferencia`) para que el hueco sea visible. TODO — pendiente: investigar si existe
  alguna forma de resolver el pedido a partir del id de línea (otra consulta encadenada).

Tests: 146/146 en verde. Ampliados `tests/watcher/actionPatterns.test.ts` (todas las reglas
nuevas) y `tests/watcher/luxActionWatcher.test.ts` (9 escenarios end-to-end: los 3 originales +
alta de expedición, edición de cabecera, alta de línea, alta de recepción, pasar a almacén, y el
aviso sin referencia resoluble), más `obtenerResumenListadoRecepcion` en
`tests/recepciones/RecepcionesService.test.ts`. Verificado también arrancando el proceso real
contra los logs reales sin errores.

## Fase 24 — Watcher de logs LUX (2026-09-30)

Proceso independiente (`npm run watch-logs`, `scripts/watchLuxLogs.ts`) que seguido de un análisis
manual exhaustivo de dos logs de LUX en producción (`S:\TLSI\LUX\lux.log.0` y
`S:\TLSI\LUX_mobile\lux.log.0`, confirmado con el usuario reproduciendo acciones reales sobre el
pedido `EXP0000074`/`AZA LOGISTICS SLU`/id `11115`), detecta 3 líneas de log confirmadas como
señales de cambio de estado y re-consulta automáticamente el pedido afectado contra la API de LUX.

**Acciones vigiladas** (ninguna documentada en el PDF del proveedor; confirmadas empíricamente):

| Procedimiento (log) | Confirmado por | Resultado real observado |
|---|---|---|
| `p_wm_expSinConsolidar @estado='CERRAR'` (`LUX_mobile`) | Reproducido en vivo por el usuario | `DISCREPANCIAS` o `EXPEDICION` según si faltaba mercancía — **ambiguo desde el log**, por eso siempre se re-consulta la API en vez de asumir el resultado |
| `p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR'` (`LUX`) | Reproducido en vivo por el usuario | `CERRADO` |
| `p_expRutas @accion='ENVIAR_FORZAR'` (`LUX`) | Reproducido en vivo por el usuario | `ENVIADO` — el `id` de esta línea es el de la **ruta**, no de un pedido; se resuelve a los pedidos que lleva vía `p_expRutasDetalle` (también no documentado, confirmado contra el log) |

**Arquitectura** (`src/watcher/`):

* `logTailer.ts` — sigue un fichero por **sondeo periódico** (no `fs.watch`: los logs están en
  una unidad de red, `S:\...`, donde los eventos nativos de cambio de fichero no son fiables). Se
  posiciona al final del fichero al arrancar (no reprocesa meses de histórico), detecta
  rotación/truncado, y reabre el fichero en cada sondeo (más tolerante a cortes de red que
  mantener un descriptor abierto).
* `actionPatterns.ts` — expresiones regulares estrictas (procedimiento + acción/estado exactos)
  para las 3 señales; ignoran deliberadamente cualquier otra acción de los mismos procedimientos
  (p. ej. `SELECT`, `CERRAR_OFICINA_INICIO`, `ENVIAR` sin `_FORZAR`).
* `routeResolver.ts` — resuelve una ruta a sus pedidos vía `p_expRutasDetalle` (añadido a
  `src/lux/procedures/whitelist.ts`, ahora 8 procedimientos).
* `expedicionWatcher.ts` — orquestador: agrupa varias líneas seguidas del mismo pedido en una
  ventana de espera (`WATCHER_DEBOUNCE_MS`, por defecto 5 s) en una sola re-consulta; reutiliza
  `ExpedicionesService`/`LuxClient` directamente (sin pasar por HTTP — es un consumidor más de la
  librería interna, tal como prevé `docs/architecture.md`).
* `watcherConfig.ts` — configuración propia (`LUX_LOG_PATH`, `LUX_MOBILE_LOG_PATH`,
  `WATCHER_POLL_MS`, `WATCHER_DEBOUNCE_MS`), separada de `AppConfig` porque el servidor HTTP
  principal no la necesita.

**Decisión de alcance** (confirmada con el usuario): el resultado de cada detección solo se
**registra en el log estructurado del propio watcher** (`watcher.pedidoActualizado`: idPedido,
pedido, propietario, estado, motivos, duración) — no hay base de datos ni otro sistema
involucrado todavía. Es la base para conectar algo después sin comprometerse ahora a dónde va.

**Es de "mejor esfuerzo", no una fuente de verdad transaccional**: si el proceso está parado o la
unidad de red no está accesible un momento, no hay reintento retroactivo más allá de lo que
alcance a leer la próxima vez que sondee. Para consistencia fuerte seguiría haciendo falta una
reconciliación periódica aparte (polling por ventana deslizante, ya analizado y descartado como
único método por su coste, pero sigue siendo un buen complemento/red de seguridad).

Verificado: arrancado contra los ficheros reales (`S:\TLSI\LUX\lux.log.0`,
`S:\TLSI\LUX_mobile\lux.log.0`) y el LUX real, sin errores de acceso a la unidad de red, durante
varios ciclos de sondeo.

Tests: 131/131 en verde. Nuevos: `tests/watcher/actionPatterns.test.ts`,
`tests/watcher/logTailer.test.ts` (ficheros temporales reales, incluye rotación y líneas
parciales), `tests/watcher/routeResolver.test.ts`, `tests/watcher/expedicionWatcher.test.ts`
(extremo a extremo con ficheros reales + mock de LUX, incluyendo el agrupado por debounce y la
resolución de ruta a varios pedidos).

Durante la sesión de análisis de logs de LUX, el mismo problema de "proceso corriendo con una
variable de `.env` desactualizada" (ya visto en la fase 21 con `LUX_BASE_URL`) volvió a aparecer,
esta vez con `LUX_WAREHOUSE`, dando datos de un pedido completamente distinto al esperado durante
unos minutos hasta reiniciar a mano.

Solución: `package.json` → `"dev": "tsx watch --watch-path .env src/server.ts"`. `tsx watch` ya
vigilaba los ficheros `.ts` importados; `--watch-path .env` (flag propio de Node `--watch`, que
`tsx watch` soporta al construirse sobre él) añade `.env` a la vigilancia aunque no sea un módulo
importado. Verificado con una prueba real: modificar `.env` mientras `npm run dev` está
corriendo produce `Restarting 'src/server.ts'` en la consola y un reinicio limpio, sin
intervención manual.

**Solo aplica a `npm run dev`** (que usa `tsx watch`). `npm start` (producción, JS ya compilado
con `node dist/src/server.js`) sigue sin recargar `.env` solo — ahí hay que reiniciar el proceso
a mano o dejar que el orquestador (PM2/systemd/Docker) lo haga. Documentado en `README.md`.

## Fase 22 — Carga automática de `.env` (2026-09-30)

El usuario reportó que `npm run dev` "no hacía nada" en PowerShell. Causa: la aplicación nunca
usó `dotenv` — dependía de que las variables de entorno ya estuvieran exportadas en el shell
antes de arrancar (así se había estado probando manualmente durante todo el desarrollo, con
`set -a; source .env; set +a` en bash). En PowerShell/CMD, sin ese paso, `loadConfig()` falla
rápido con "Falta la variable de entorno obligatoria" y el proceso termina — fácil de no ver si
la terminal no se mira con atención.

* Añadida dependencia `dotenv`; `src/server.ts` ahora empieza con `import 'dotenv/config'` (antes
  de cualquier otro import), que carga `.env` en `process.env` automáticamente al arrancar.
* Verificado arrancando el proceso en un shell limpio, sin exportar nada a mano: arranca y
  responde `200` en `/health/live`.
* `scripts/createWebUser.ts` no necesita el cambio (no lee configuración de LUX).
* Documentado en `README.md`: `.env` se carga solo; para aplicar cambios en `.env` hay que
  reiniciar el proceso completo (los cambios de código sí se recargan solos vía `tsx watch`).

## Nota sobre fase 21 — `.140` es PRO, `.145` es DEV

Aclaración posterior del usuario (comentarios añadidos al propio `.env`): `.140` + `apiUser` es
el entorno de **producción**, `.145` + `interfaz` es el de **desarrollo/pruebas**. No fue un
error real tener `.140` configurado — dependía de contra qué entorno se quisiera trabajar en cada
momento. Mantener esta distinción en cuenta en futuras confusiones de host/credenciales.

## Fase 21 — Host/credenciales LUX incorrectos en `.env` (2026-09-30)

El usuario reportó que las expediciones en estado `ENVIADO` no aparecían. Diagnóstico: no era un
bug de código — `.env` tenía `LUX_BASE_URL=http://192.168.2.140:8081` con
`LUX_USERNAME=apiUser`, un **entorno LUX distinto** al `.145` usado hasta ahora, con datos mucho
más limitados (solo 7 expediciones para CAMELIA, todas `BLOQUEADO`, frente a las 529 en `.145`).

Confirmado con el usuario que `.145` + `interfaz`/`Valencia.2026` es la combinación correcta;
`.env` corregido y servidor reiniciado. Verificado: `propietario=CAMELIA&estado=ENVIADO` devuelve
ahora 204 filas reales.

**Lección operativa importante** (documentada en README): cambiar `LUX_BASE_URL` (o cualquier
variable) en `.env` **no se recarga sola** — hace falta parar el proceso por completo y volver a
arrancarlo (`npm run dev`/`npm start`), a diferencia de los cambios de código, que `tsx watch` sí
recarga automáticamente. Se detectó porque el proceso en marcha seguía usando el host antiguo
pese a haber editado `.env` hacía rato.

## Fase 20 — Tablas de Líneas completas (2026-09-30)

Continuación de la fase 18: el usuario pidió que las tablas de Líneas (expediciones y
recepciones) también mostraran todos los campos reales, "salvo que se duplique con el resultado
de otra consulta". Comprobado contra LUX real:

* `p_expPedidoLineas/SELECT` (pedido 180278/id 5034): **34 campos** —
  `cantidadServida`, `cantidadReservada`, `faltas`, `estadoStock`, `motivoDiscrepancias`,
  `infoReserva`, etc. Ninguno duplica realmente los datos de otras tarjetas del detalle (aunque
  algunos comparten nombre con columnas de `resumenListado`, son valores por línea, no por
  pedido).
* `p_recAlbaranLineas/SELECT` (albarán id 4023): **30 campos** — `piezasRecepcionadas`, `coste`,
  `revisionCalidad`, `storageLocation`, `pedidoCompra`, etc.

Se excluyen únicamente `action#edit`/`action#delete` (botones internos de la UI de Whales, no son
datos) de ambas tablas; el resto de columnas se renderiza dinámicamente (igual que "Datos del
listado" y "Contenedores"), envuelto en scroll horizontal.

Tests: 113/113 en verde (sin cambios de contrato de API, es un cambio puramente de presentación
en las vistas `/almacen/*`; no requiere tests nuevos porque la API ya devolvía todos los campos).

## Fase 19 — Zonas de descarga por propietario (2026-09-29)

El usuario aportó un ejemplo real de uso de `p_recCabeceraAza`/`SELECT_DESCARGAS` con un filtro
`propietario` (`{"accion":"SELECT_DESCARGAS","propietario":"00180107"}`) que la documentación no
detallaba. Confirmado contra LUX real: con `propietario=CAMELIA` devuelve 4 zonas de descarga
reales (`{"campo": "..."}`); sin propietario, o con uno sin zonas configuradas, devuelve `[]`.

* `CatalogosService.selectDescargas(propietario?, almacen?)` — antes se llamaba sin parámetros;
  ahora acepta `propietario` y cachea por almacén+propietario por separado.
* `GET /api/catalogos/descargas?propietario=<código>` — nuevo parámetro de query.
* `GET /api/recepciones/:idAlbaran` (detalle) y `/almacen/recepciones/:id` incluyen ahora
  `descargas`: las zonas válidas para el `propietario` de esa recepción concreta.
* Se tuvo que inyectar `CatalogosService` en `RecepcionesController`/`recepcionesRoutes`/`webRouter`
  (antes solo `ExpedicionesService`/`RecepcionesService` llegaban a esas capas).
* Tests nuevos: `tests/catalogos/CatalogosService.test.ts` (no existía ningún test de
  `CatalogosService` hasta ahora — cubre `selectDescargas` con/sin propietario y caché separada
  por propietario), y ampliación del test de integración de detalle de recepciones. 113/113 en
  verde.
* TODO — no confirmado: si `propietario` es estrictamente obligatorio para `SELECT_DESCARGAS` o
  solo recomendado.

## Fase 18 — Columnas de contenedores (2026-09-29)

El usuario detectó que la tabla de "Contenedores" en `/almacen/expediciones/:id` no mostraba el
campo `pallet` (entre otros) aunque la API ya lo devolvía — el hueco era solo de presentación.
Añadidas las columnas que faltaban: `id`, `pallet`, `fechaCaducidad`, `observaciones`,
`largoContenedor`, `anchoContenedor`, `altoContenedor`, `pesoContenedor` (antes solo se mostraban
6 de los 14 campos de `ExpedicionContenedor`). La tabla ahora se envuelve en un contenedor con
scroll horizontal por el número de columnas.

## Fase 17 — Datos completos del visor en el detalle (2026-09-29)

El usuario señaló que `PUT /proc/p_expedicionesAza` (visor de expediciones) devuelve muchas más
columnas (62 reales, confirmadas contra LUX) de las que se mostraban en el listado web (7) o en
el detalle (que solo traía lo de `p_expCabeceraAza`, un procedimiento distinto con columnas
distintas — no incluye `transportista`, `ruta`, `muelle`, `prioridad`, `unidades`,
`fechaCreacion`, etc.).

Decisión (confirmada con el usuario): añadir **todos** esos campos, sin filtrar, a la página de
**detalle** de expedición (no a la tabla de listado).

* Nuevo método `ExpedicionesService.obtenerResumenListadoExpedicion(pedido, almacen)`: llama a
  `p_expedicionesAza` con `accion=SELECT` filtrando por `pedido` exacto (sin `%`), ya que el
  listado no admite filtrar por `id` (solo por `pedido`, texto, LIKE). Se ejecuta después de
  obtener la cabecera (necesita su campo `pedido`); si `pedido` viene vacío, no llama a LUX.
* `GET /api/expediciones/:idPedido` ahora incluye `resumenListado` en el detalle (junto a
  `cabecera`, `datosExtra`, `lineas`, `contenedores`).
* `/almacen/expediciones/:id` muestra una tarjeta nueva "Datos del listado (p_expedicionesAza)"
  con **todos** los campos devueltos (sin curar), igual que ya se hace con la cabecera.
* Verificado contra LUX real (pedido 180278/id 5034): 65 campos reales, incluyendo
  `transportista=FEDEX`, `ruta=FEDCAM2704`, `prioridad=0`.

Tests: 110/110 en verde. Nuevos: 2 unitarios en `ExpedicionesService.test.ts`
(`obtenerResumenListadoExpedicion` con filtro exacto por pedido, y que no llama a LUX si el
pedido está vacío), y el test de integración de detalle de expediciones ampliado para cubrir
`resumenListado`.

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
