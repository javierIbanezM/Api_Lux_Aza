# Auditoria de codigo (2026-10-01)

Alcance: todo `src/` y `scripts/` (~5.100 lineas, 190 tests). Objetivo: calidad, escalabilidad y
mantenimiento **sin cambiar el comportamiento**. Lo marcado con ✅ ya esta aplicado en esta
auditoria (tests y `tsc`/`eslint` en verde); lo marcado con ⏳ queda como recomendacion.

## 1. Arquitectura (ingenieria inversa)

Dos procesos independientes que comparten la misma capa de integracion con LUX:

```
                         ┌───────────────────────────── proceso 1: servidor HTTP (src/server.ts) ──┐
 Sistemas AZA  ─X-Api-Key─▶ routes ─▶ controllers ─▶ services ─▶ LuxClient ─▶ AuthManager ─▶ LUX  │
 Personal almacen ─sesion─▶ web/webRouter (+ vistas EJS) ─▶ services ─┘        (JWT, retries)       │
                         └─────────────────────────────────────────────────────────────────────────┘
                         ┌───────────────────────── proceso 2: watcher (scripts/watchLuxLogs.ts) ──┐
 lux.log.0 / .1 (LUX y  ─▶ LogTailer ─▶ actionPatterns ─▶ debounce ─▶ services ─▶ LuxClient ─▶ LUX │
 LUX_mobile)                                              (re-consulta)   └─▶ WatcherSink ─▶ JSON  │
                         └─────────────────────────────────────────────────────────────────────────┘
```

| Capa | Ubicacion | Responsabilidad |
|---|---|---|
| Entrada HTTP | `routes/`, `controllers/`, `web/webRouter.ts` | Parseo de peticion, auth (API key / sesion), respuesta |
| Aplicacion | `services/*` | Reglas de AZA (alta cabecera + lineas, detalle, cache de catalogos) |
| Validacion | `validation/` (zod) | Esquemas de entrada |
| Integracion LUX | `lux/client`, `auth/`, `lux/procedures`, `lux/models` | HTTP, JWT con refresh, reintentos solo en lecturas, errores tipados |
| Observabilidad | `logging/` | Logger JSON + correlationId |
| Watcher | `watcher/*` | Tail de logs → evento → re-consulta → sink |

Flujo de datos del watcher (el mas delicado): linea de log → `LogTailer` (posicion + huella en
`data/watcher-state`, recuperacion tras corte/rotacion `.0`→`.1`) → `matchActionLine` (reglas
`actionPatterns`) → `scheduleRefresh` (debounce 5 s por pedido/albaran) → refresco ordenado por
clave → `ExpedicionesService`/`RecepcionesService` → `WatcherSink` (`jsonFileSink`: un JSON por
pedido; borra al llegar a `ENVIADO`/`CERRADO`, tras confirmar `DestinoPersistencia` si existe).

Veredicto: la separacion por capas es sana y la inyeccion de dependencias esta bien hecha
(`buildDependencies`, todo mockeable). Los problemas estan en duplicacion, en dos "god files" y
en varios puntos de escalabilidad/robustez, no en el diseno de fondo.

## 2. Hallazgos

### ✅ Aplicados (sin cambio funcional)

| # | Hallazgo | Cambio |
|---|---|---|
| 1 | `parseOrThrow`, `describeError` y `LineaFallida` copiados en los 2 services | Extraidos a `src/services/shared.ts` |
| 2 | El detalle (cabecera + extra + lineas [+ contenedores] + resumen) estaba ensamblado a mano 4 veces (controller y web, expediciones y recepciones) | `ExpedicionesService.obtenerDetalle` / `RecepcionesService.obtenerDetalle`; controllers y `webRouter` los usan |
| 3 | `listarRecepciones` hacia 2 llamadas a LUX en serie | `Promise.all` (mismo resultado, mitad de latencia) |
| 4 | El watcher pedia lineas y contenedores/HUs en serie | `Promise.all` (cada una sigue siendo "mejor esfuerzo") |
| 5 | `AuthManager.login()` sin mutex: N peticiones simultaneas sin sesion = N logins contra LUX (el refresh si tenia mutex) | `loginInFlight` (single-flight) |
| 6 | `CatalogosService`: varias peticiones con la cache vacia/expirada = varias llamadas identicas a LUX | Carga en curso compartida (`inFlight`) |
| 7 | `LuxClient` repetia 8 campos de log en 3 sitios | `logBase` |
| 8 | `LogTailer` partia caracteres UTF-8 multibyte si el corte de lectura caia dentro (los logs llevan acentos) | Resto de linea guardado como bytes; test nuevo |
| 9 | El servidor no cerraba ordenadamente con SIGTERM/SIGINT (el watcher si) | `server.close` + salida con limite de 10 s |
| 10 | Refrescos del mismo pedido podian solaparse y pisarse (el lento antiguo terminaba el ultimo) | Cola por clave en `LuxActionWatcher` |

### ⏳ Zonas criticas y recomendaciones (ordenadas por impacto)

1. **Watcher: el checkpoint se adelanta al procesamiento (riesgo de perder eventos).**
   `LogTailer` guarda la posicion en cuanto lee las lineas, pero el refresco ocurre despues
   (debounce de 5 s + consulta). Si el proceso muere en esa ventana, al reiniciar ya no se
   relee esa linea. Solucion: confirmar (`commit`) la posicion solo cuando no haya refrescos
   pendientes/en curso; un reinicio releera algo ya procesado (el refresco es idempotente).
   *Es el cambio mas valioso de cara a "no perder ningun evento".*
2. **`rows[0] as Expedicion` sin comprobar.** Si LUX devuelve `[]` (id inexistente), el
   service devuelve `undefined` tipado como objeto y falla despues (`cabecera.pedido` → 500
   generico). Convendria un `firstRowOrThrow` con error tipado (404). *Cambia el codigo HTTP,
   por eso no se ha tocado.*
3. **Sin limite de concurrencia hacia LUX.** Cada detalle web = 5 llamadas; `listarRecepciones`
   = 2; el watcher puede disparar rafagas tras un corte. No hay semaforo ni circuit breaker.
   Anadir un limitador de concurrencia en `LuxClient` (p.ej. 6–8 simultaneas) y un breaker
   simple tras N fallos de red.
4. **`LuxClient.WRITE_ACTIONS` es una lista de permitidos (`ACTUALIZAR/INSERT/UPDATE`).** Una
   accion de escritura nueva se **reintentaria** por defecto. Invertir: reintentar solo
   acciones de lectura conocidas (`SELECT*`, `select_*`, `pedido_*`).
5. **Sesiones web en `MemoryStore`** (ya documentado): se pierden al reiniciar y impiden
   varias instancias. Migrar a un store persistente es un cambio localizado en `web/session.ts`.
6. **`luxActionWatcher.ts` (430 lineas) hace 5 cosas**: tail, debounce, orquestacion, armado de
   snapshot (expedicion/recepcion casi gemelos) y llamada al sink. Dividir en `Debouncer`,
   `ExpedicionSnapshotBuilder`/`RecepcionSnapshotBuilder` y el watcher como coordinador.
7. **`web/webRouter.ts` (310 lineas) mezcla login/logout, estado de almacen y vistas** y repite
   4 veces el patron "intentar, si falla renderizar con `error`". Separar en
   `web/controllers/{auth,expediciones,recepciones}.ts` y un helper `renderConFallback`
   (acerca la parte web a MVC de verdad: hoy el "controlador" web vive en el router).
8. **`jsonFileSink` lista la carpeta entera en cada evento** (`readdir`). Con miles de JSON
   es O(N) por evento. Mantener un indice en memoria `sufijo → ficheros` (carga inicial unica).
   Ademas es una pieza provisional: se sustituira por `DestinoPersistencia` (BD).
9. **Reglas de dominio repartidas**: estados finales (`ENVIADO`, `CERRADO`) en `jsonFileSink`,
   tipos de evento en `actionPatterns`, almacenes en `lux/warehouses`. Centralizar en un modulo
   `domain/` para que una regla nueva se cambie en un solo sitio.
10. **Operacion**: `/health/ready` no comprueba que LUX responda (solo configuracion); no hay
    `helmet`/rate-limit en `/api`; `AuthManager` y `LuxClient` crean cada uno su instancia de
    axios (factoria comun). Swagger (`/docs`) es publico por decision explicita.

## 3. Estrategia de refactorizacion propuesta

1. **Fase A (rapida, riesgo bajo)**: items 4, 9 y 10 (Operacion) + indice del sink (8).
2. **Fase B (robustez del watcher)**: item 1 (checkpoint tras procesar) y 6 (dividir el
   watcher). Cubrir con tests de "muerte durante el debounce".
3. **Fase C (contrato HTTP)**: item 2 (`firstRowOrThrow` → 404) acordando antes el cambio de
   codigo con los consumidores; item 3 (limitador/breaker).
4. **Fase D (web)**: item 7 y, si se escala a varias instancias, item 5.

Regla para todas las fases: la bateria de tests actual (190) debe seguir pasando sin tocar sus
expectativas; las expectativas solo cambian en la fase C, de forma explicita.
