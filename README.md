# API WHALES AZA

Integración de **AZA Logistics** con la API **LUX (Whales)**: autenticación, cliente HTTP
resiliente hacia LUX y una API REST propia (`/api/expediciones`, `/api/recepciones`,
`/api/catalogos`) que envuelve los procedimientos almacenados autorizados.

## Produccion con PM2 (servidor y watcher siempre arriba)

`ecosystem.config.js` define los dos procesos: `api-whales` (servidor HTTP) y
`api-whales-watcher` (watcher de logs). PM2 los reinicia solos si caen (con espera creciente) o si
superan el limite de memoria, y escribe sus logs en `logs/`.

```powershell
# Una sola vez en el servidor
npm install -g pm2
pm2 install pm2-logrotate        # rota los logs de PM2 (evita que crezcan sin limite)

# Despliegue / actualizacion (desde la raiz del proyecto, con .env ya rellenado)
npm ci
npm run build
pm2 start ecosystem.config.js    # primera vez   (despues: pm2 restart ecosystem.config.js)
pm2 save                         # guarda la lista para recuperarla tras reiniciar el servidor

# Dia a dia
pm2 list                         # estado de todas las apps
pm2 logs api-whales-watcher      # logs en vivo (o api-whales)
pm2 restart api-whales-watcher   # reiniciar solo uno
pm2 stop api-whales-watcher      # parar solo uno
```

Cerrar la ventana de PowerShell NO para nada: PM2 es un demonio en segundo plano. Solo lo paran
`pm2 stop`, `pm2 delete` o `pm2 kill`.

Arranque automatico al reiniciar el servidor (sin que nadie inicie sesion): ejecutar UNA vez, como
administrador y con la misma cuenta que lanza PM2, `deploy\instalar-arranque-pm2.ps1`. Registra
una tarea programada "PM2 resurrect (API WHALES)" al iniciar el sistema (1 min de retardo, para que
la red este lista) y hace `pm2 save`. Antes deja `pm2 list` con SOLO lo que quieras que arranque.
`pm2-windows-startup` no sirve en un servidor: solo arranca cuando alguien inicia sesion.

Puntos importantes:
- **Una sola instancia de cada uno** (ya configurado). Dos watchers duplicarian eventos y se
  pisarian el estado; el servidor guarda las sesiones web en memoria.
- **Unidades de red**: una letra mapeada (`S:`, `T:`) es de cada sesion de usuario y NO existe para
  un servicio o una cuenta distinta. En el servidor usa la ruta UNC en `.env`:
  `LUX_LOG_PATH=\\servidor\comparticion\TLSI\LUX\lux.log.0` (y `LUX_MOBILE_LOG_PATH`), y que la
  cuenta con la que corre PM2 tenga permiso de lectura.
- **Acceso a la interfaz web desde otros equipos**: `http://SRVNewWhales.zar.local:3000/almacen/login`
  (equivale a `http://192.168.2.140:3000/almacen/login`; `localhost` solo vale en el propio
  servidor). Hace falta abrir el puerto en el firewall del servidor (PowerShell como administrador):
  `New-NetFirewallRule -DisplayName "API WHALES 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Domain`.
  Comprobacion desde otro PC: `Test-NetConnection SRVNewWhales.zar.local -Port 3000` y abrir
  `http://SRVNewWhales.zar.local:3000/health/live`.
- **Cookie de sesion por HTTP**: con `NODE_ENV=production` la cookie de sesion va marcada `secure` y
  los navegadores la descartan por HTTP (el login no se mantiene). Mientras no haya HTTPS delante,
  deja `SESSION_COOKIE_SECURE=false` en el `.env` del servidor (ya incluido en `.env.example`);
  con HTTPS (proxy IIS/Nginx) ponlo en `true`.
- **Si cambias `.env`**: `pm2 restart ecosystem.config.js --update-env`.
- **No uses `pm2 restart all` / `pm2 delete all`** si en el servidor hay otras aplicaciones en PM2.
- Si el watcher cae o se reinicia no pierde eventos: al volver relee desde la ultima posicion
  confirmada (`data/watcher-state/`), incluso si el log rota mientras estaba parado.

## Evento: consulta de una ruta -> DECA (p_expRutasDeca)

Cuando alguien filtra por una ruta concreta en la pantalla de expediciones (log de LUX:
`p_expedicionesAza ... @ruta='%RT00013615_2026_COMP %' ... @ALMACEN='SAGUNTO' @ACCION='SELECT'`), el
watcher toma la ruta y el almacen de esa linea, resuelve el nombre EXACTO de la ruta (el listado de
expediciones devuelve el campo `ruta` completo) y consulta `p_expRutasDeca` con `SELECT` y
`SELECT_ENVIOS`. Si la ruta tiene DECA o envios, guarda `data/watcher-rutas-deca/<fecha>--rutadeca-<ruta>.json`
**Evento `GENERAR_DECA`** (`p_expRutas @accion='GENERAR_DECA' ... @id=<id de la ruta>`): es el que CREA el DECA.
La consulta de la ruta en pantalla suele ser anterior y entonces el DECA aun no existe, asi que este evento
es el que lo registra de verdad. El watcher consulta `p_expRutasDeca` por ese id (SELECT y SELECT_ENVIOS;
reintenta unos segundos si aun no existe), descarga los documentos de Docuten y guarda la carpeta de la ruta.
Tambien lo recupera al arrancar leyendo `lux.log.1` y `lux.log.0`.

**Al arrancar**, el watcher tambien lee `lux.log.1` y `lux.log.0` completos (de LUX y LUX_mobile),
busca las consultas de ruta y procesa la ultima de cada ruta, aunque ocurrieran cuando no estaba en marcha
con esta regla. No repite lo ya hecho: `data/watcher-state/rutas-procesadas.json` recuerda, por ruta, hasta
que consulta se proceso (la primera vez se inicializa con los JSON que ya hay en `watcher-rutas-deca`).
Solo rutas: pedidos y albaranes se recuperan por la posicion guardada de cada log.
(carpeta propia, `WATCHER_RUTAS_DECA_DIR`; una SUBCARPETA por ruta con el nombre de la ruta, con el JSON mas
reciente dentro y los ficheros descargados de Docuten, ver mas abajo). Cada JSON lleva la consulta hecha
a la API (`consulta.llamadas`: procedimiento, accion, parametros, almacen y filas de cada llamada) y los
datos devueltos (`deca`, `envios`). El listado sin ruta (`''`, `%%`, `NO ASIGNADA`) no cuenta, y las
consultas del propio usuario tecnico se ignoran (evita bucles).

## Comandos rapidos del watcher de logs (PowerShell, desde `C:\API.WHALES`)

```powershell
# Iniciar (dejar la terminal abierta; Ctrl+C lo para)
npm run watch-logs

# Parar (mata solo el proceso del watcher, nunca "todo node.exe")
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*watchLuxLogs*' -or $_.CommandLine -like '*run watch-logs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Comprobar si esta en marcha (no debe salir nada si esta parado)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*watchLuxLogs*' } | Select-Object ProcessId, CreationDate

# Reiniciar = Parar (bloque de arriba) + Iniciar
```

El watcher NO se recarga solo: reinicialo tras cambiar codigo o `.env`. Guarda hasta donde ha
leido cada log en `data/watcher-state/`, asi que al reiniciar (o tras un corte, o si LUX rota
`lux.log.0` a `lux.log.1`) recupera los eventos que faltaban. Si borras esa carpeta, vuelve a
empezar desde el final de los logs.

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

**El watcher de logs (`npm run watch-logs`) NO se recarga solo nunca** — ni con cambios de codigo
ni de `.env` (no usa `tsx watch`, ver `package.json`) — asi que tras cualquier cambio (credenciales,
almacen, nuevas reglas de deteccion, etc.) hay que pararlo y volver a arrancarlo a mano. En
**desarrollo**, aunque `npm run dev` normalmente detecta los cambios de `.env` solo, si tienes dudas
de que se haya recargado (o simplemente quieres asegurarte) es igual de valido reiniciarlo a mano:

```powershell
# Parar (localiza y mata solo los procesos de este proyecto, nunca "todo node.exe")
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/server.ts*' -or $_.CommandLine -like '*run dev*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*watchLuxLogs*' -or $_.CommandLine -like '*run watch-logs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Arrancar de nuevo
npm run dev          # servidor HTTP
npm run watch-logs   # watcher de logs (proceso aparte, en otra terminal)
```

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

* Vigila 14 tipos de acción (ver `docs/lux-api-analysis.md` §16 y `docs/progress.md` fases 24-28),
  tanto de expediciones como de recepciones:
  * Alta/edición de cabecera (`p_expCabeceraAza`/`p_recCabeceraAza @accion='ACTUALIZAR'`, del PDF)
    — dirección, transportista, service level, etc. Un alta (id `'0'`) se resuelve por el texto
    del pedido/albarán, ya que LUX aún no ha asignado el id real en ese momento.
  * Alta/edición de línea (`p_expPedidoLineas`/`p_recAlbaranLineas`, del PDF).
  * Cierre de picking con/sin discrepancias, expedición (`p_wm_expSinConsolidar @estado='CERRAR'`,
    no documentado, confirmado en vivo).
  * Cierre físico de recepción desde la PDA (`p_wm_recepcionCerrar @estado='CONFIRMAR_CERRAR'`, no
    documentado, confirmado en vivo sobre REC0000068).
  * Confirmación de línea de recepción contra su HU/pallet (`p_wm_recepcion
    @estado='SELECT_MOVIMIENTO'` **con `@valor` no vacío** — el mismo estado se repite como menú
    intermedio con `valor=''` varias veces por línea; solo la última vez, con la HU ya escaneada,
    es la confirmación real). No documentado, confirmado en vivo sobre REC0000068.
  * Cierre de oficina (`p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR'`, no documentado).
  * **Cierre por asignación a ruta** (`p_expRutasDetalle @accion='INSERT'`, no documentado) —
    tercera vía de cierre distinta a las dos anteriores, confirmada con un caso real.
  * Reapertura forzada de expedición (`p_expediciones @accion='REABRIR_FORZAR'`, no documentado,
    confirmado en vivo sobre EXP0000076).
  * Anulación forzada de expedición (`p_expediciones @accion='ANULAR_FIN_FORZAR'`, no documentado).
  * Pasar a almacén, expedición (`p_expPasarAlmacenPC @accion='PASAR_ALMACEN_WMS'`, no documentado).
  * Pasar a almacén, recepción (`p_recepciones @accion='PASAR_ALMACEN'`, no documentado,
    confirmado en vivo sobre REC0000068 — procedimiento distinto de `p_recepcionesAza`).
  * Envío de ruta (`p_expRutas @accion='ENVIAR_FORZAR'`, no documentado), resuelto a los pedidos
    de esa ruta vía `p_expRutasDetalle` (tampoco documentado).
  * **Importante**: el mismo procedimiento puede loguearse con el parámetro de acción en
    minúsculas y justo después del nombre (llamadas de nuestra propia API) o en **mayúsculas y en
    cualquier posición** de la línea (llamadas desde la UI de LUX/PDA). El motor de patrones lo
    detecta en ambos casos — esto fue un bug real corregido en la fase 26, no una teoría.
* **Multi-almacén**: los mismos 2 ficheros de log contienen actividad de los 5 almacenes
  (SAGUNTO, ALMUSSAFES, CHESTECM, CHESTE, MONTAVERNER) — no hay un log por almacén. El watcher
  extrae el `almacen` de cada línea y lo usa en la re-consulta (cabecera `Almacen` hacia LUX);
  usar el almacén por defecto de la configuración en vez del real haría que LUX devolviera datos
  vacíos/incorrectos para cualquier pedido que no fuera de ese almacén por defecto (confirmado
  contra el servidor real).
* Al detectar una, hace la **re-consulta completa** del pedido/albarán afectado contra LUX
  (reutilizando `ExpedicionesService`/`RecepcionesService` directamente, sin pasar por `/api/*`):
  para expediciones, cabecera (`p_expCabeceraAza`) + **listado** (`p_expedicionesAza`, fila
  completa — trae columnas que NO están en la cabecera: transportista, ruta, muelle, prioridad,
  deliveryNumber, fechaCerrado, unidades, pallets, numContenedores, serviceLevel/nivelServicio,
  etc.) + líneas (`p_expPedidoLineas`) + contenedores (`p_expPedidoContenedores`); para
  recepciones, cabecera (`p_recCabeceraAza`) + listado (`p_recepcionesAza`) + líneas
  (`p_recAlbaranLineas`) + HUs/pallets físicos (`p_recAlbaranHUPreinformado` — equivalente de
  "contenedores" para recepciones, forma de datos propia). Todas las llamadas se hacen siempre, sin importar cuál fue el motivo
  concreto que disparó el refresco (cabecera, línea, pasar a almacén...). Líneas y contenedores son
  "best effort": si esa llamada en concreto falla, se registra un aviso (`watcher.datoIncompleto`)
  sin abortar el resto. Registra el resultado en su propio log estructurado
  (`watcher.pedidoActualizado` / `watcher.albaranActualizado`, con `lineasCount`/`contenedoresCount`).
  Si una línea no trae ninguna referencia resoluble a un pedido/albarán (p. ej. un `UPDATE` de línea
  que solo lleva el id de la propia línea), se registra un aviso (`watcher.sinReferencia`) en vez de
  ignorarlo en silencio.
* Tras cada re-consulta completa correcta, llama a un `WatcherSink` (`src/watcher/watcherSink.ts`)
  con el resultado completo (cabecera, líneas, contenedores, propietario, estado, motivos). Es el
  punto de enganche para el paso 3 (persistir en un destino de AZA — base de datos u otro sistema).
  **Hoy no escribe en ninguna base de datos** (pendiente de que se indique el destino y el mapeo de
  campos); mientras tanto, `npm run watch-logs` usa un sink provisional
  (`src/watcher/jsonFileSink.ts`) que guarda **un fichero JSON por evento** con toda la información,
  en la carpeta `WATCHER_JSON_DIR` (por defecto `data/watcher-events/`, ya en `.gitignore`) — sirve
  para revisar exactamente qué datos llegan antes de decidir el mapeo. Ver ejemplos de la forma de
  ese JSON en `docs/examples/watcher-sink-expedicion.example.json` y
  `watcher-sink-recepcion.example.json`. Como mucho hay **un fichero por pedido/albarán**: antes de
  guardar uno nuevo se borra cualquier JSON previo del mismo pedido/albarán (si se duplica, se
  queda el más reciente). Cuando una expedición llega a `estado='ENVIADO'` (estado final, ya no hay
  más cambios) no se guarda ninguno nuevo — no aporta nada a partir de ahí. Un sink que falla no
  afecta al refresco ya registrado (se loguea aparte como `watcher.sinkError`).
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
* `GET /api/expediciones/datos-extra?propietario=X` — plantilla de datos extra (campos y valores
  por defecto) para una expedición que **todavía no existe**, antes de crearla, filtrada por
  propietario en vez de por `idPedido` (`p_expCabeceraAza SELECT_INICIO` con `propietario`, no
  documentado en el PDF, confirmado contra el servidor real). Requiere el query param.
* Equivalentes en `/api/recepciones` (incluye `GET /api/recepciones/datos-extra?propietario=X`).
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

* Whitelist de 9 procedimientos autorizados (`src/lux/procedures/whitelist.ts`); cualquier otro
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
