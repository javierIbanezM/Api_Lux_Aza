# Troubleshooting

Guía operativa para incidencias reales de la integración AZA ↔ API LUX (Whales). No es un
documento teórico: describe qué hacer, en qué orden, y por qué, ante los escenarios que de verdad
se producen en producción.

## 1. Política de reintentos (qué se reintenta y qué NUNCA)

`LuxClient.callProc` (`src/lux/client/LuxClient.ts`) solo reintenta automáticamente cuando se
cumplen **todas** estas condiciones:

* El error es `LuxNetworkError` (timeout, conexión rechazada/reseteada, DNS) **o** `LuxHttpError`
  con `status` en el rango `5xx`.
* La `accion` de la llamada **no** es de escritura. Las acciones de escritura son
  `ACTUALIZAR`, `INSERT`, `UPDATE` (ver `WRITE_ACTIONS` en `LuxClient.ts`).

Nunca se reintenta automáticamente cuando:

* La respuesta llegó con HTTP `4xx` (incluido `403` por procedimiento no autorizado/no empieza
  por `p_`, o `401` de autenticación).
* La respuesta es un **error funcional** (`mensaje !== "OK"` dentro de un HTTP `200`) →
  `LuxFunctionalError`. Esto es una regla de negocio de Whales (p. ej.
  `ERR_TRANSPORTISTA_NOT_EXISTS`), no un fallo transitorio: reintentar no cambia el resultado.
* La `accion` es de escritura (`ACTUALIZAR`/`INSERT`/`UPDATE`), **incluso si el error sí sería
  transitorio** (timeout, 5xx). Motivo: no hay transacciones distribuidas ni idempotency-key
  documentados entre la API AZA, la API LUX y SQL Server. Ante un timeout no hay forma de saber
  con certeza si el `EXEC p_procedimiento ...` llegó a ejecutarse en SQL Server. Reintentar una
  escritura en esas condiciones puede crear una cabecera o línea duplicada.

En resumen: **reintentos automáticos solo en lecturas (`SELECT`, `SELECT_ONE`, `SELECT_INICIO`) y
solo ante red/timeout/5xx**. Cualquier otra combinación se propaga tal cual al llamador (que
decide manualmente si reintentar).

## 2. Cabecera creada pero líneas fallidas

`ExpedicionesService.crearExpedicion` / `RecepcionesService.crearRecepcion` ejecutan un flujo de
dos pasos no atómico a nivel HTTP: primero la cabecera (`p_expCabeceraAza` /
`p_recCabeceraAza`, acción `ACTUALIZAR`), y solo si esa llamada tiene éxito, una llamada
`INSERT` por cada línea del lote. Cada línea se valida y se envía a LUX de forma independiente:
una línea inválida o rechazada por LUX **no** aborta el procesamiento de las demás ni hace perder
la cabecera ya creada. El resultado siempre incluye:

```json
{
  "idPedido": "1234",
  "pedido": "PED-0001",
  "cabecera": { "...": "..." },
  "lineas": {
    "ok": [ { "id": "55010", "...": "..." } ],
    "fallidas": [ { "input": { "...": "..." }, "error": "..." } ]
  }
}
```

(Análogo con `idAlbaran`/`albaran`/`cabecera` para recepciones.)

**Qué hacer cuando `lineas.fallidas` no está vacío:**

1. **No reintentar la cabecera.** La cabecera ya se creó (tiene `idPedido`/`idAlbaran` real). Volver
   a llamar a "crear expedición/recepción" con los mismos datos de cabecera crearía **una segunda
   cabecera duplicada** en LUX (no hay upsert por clave de negocio en el `ACTUALIZAR` de alta:
   `idPedido`/`idAlbaran` se manda como `"0"` explícitamente para crear).
2. **Consultar el estado real por número de pedido/albarán**, no fiarse solo de la respuesta en
   memoria del llamador (que puede haberse perdido por un timeout de red en el propio cliente HTTP
   de AZA, aunque LUX sí respondiera):
   * `GET /api/expediciones/:idPedido` o `GET /api/expediciones?pedido=PED-0001` (equivalente
     `p_expedicionesAza`/`p_expCabeceraAza SELECT_ONE`).
   * `GET /api/recepciones/:idAlbaran` o `GET /api/recepciones?albaran=ALB-77`.
   * `GET /api/expediciones/:idPedido/lineas` (o `/api/recepciones/:idAlbaran/lineas`) para ver
     qué líneas quedaron realmente insertadas en LUX.
3. **Reintentar únicamente las líneas que fallaron**, usando `POST /api/expediciones/:idPedido/lineas`
   (o `.../recepciones/:idAlbaran/lineas`) con los datos corregidos de `lineas.fallidas[].input`.
   Esto es seguro de reintentar manualmente tras corregir el dato, porque cada línea es una
   operación independiente (no duplica la cabecera).
4. Si el error de una línea es un `LUX_FUNCTIONAL_ERROR` (p. ej. `ERR_REFERENCIA_NOT_EXISTS`), el
   problema es de datos (referencia inexistente, cantidad inválida, etc.), no de red: corregir el
   dato antes de reintentar, reintentar sin corregir devolverá el mismo error indefinidamente.

## 3. Ausencia de idempotency-key nativo en LUX

La documentación de LUX (`GuiaAPILUX_AZA (1).pdf`) no define ningún mecanismo de idempotencia
nativo (no hay cabecera `Idempotency-Key` ni parámetro equivalente en los procedimientos
`p_expCabeceraAza`/`p_recCabeceraAza`). Esto significa que **AZA es responsable de evitar
duplicados en el lado del llamador**, ya que LUX creará una cabecera nueva cada vez que se le pida
crear una con `idPedido`/`idAlbaran = "0"`, sin deduplicar por ningún otro campo.

Estrategia adoptada (de facto, sin inventar soporte que LUX no documenta):

* **El número de pedido/albarán (`pedido`/`albaran`) es la clave de facto** para detectar
  duplicados desde el lado de AZA. Antes de reintentar una creación de cabecera tras un fallo de
  red/timeout dudoso (¿llegó a crearse o no?), **consultar primero** por ese número
  (`listarExpediciones`/`listarRecepciones` con el filtro `pedido`/`albaran`, o por
  `pedidoCliente`/campo de correlación propio de AZA si el pedido aún no tiene número LUX
  asignado) antes de volver a enviar la creación.
* Si el consumidor de AZA genera su propio número de pedido/albarán (`pedidoCliente`,
  `referenciaCliente`, etc.) antes de llamar a esta API, **debe guardar esa clave localmente en su
  propio sistema** (base de datos de AZA) junto con el resultado de la llamada (éxito, error,
  pendiente de confirmar) para poder decidir con seguridad si reintentar. Esta API no persiste
  ningún estado propio entre peticiones: cada llamada a `/proc` es una transacción SQL
  independiente (ver `docs/architecture.md`, sección "Transacciones y consistencia").
* Nunca usar reintentos automáticos ciegos en el cliente HTTP para las acciones de escritura (ver
  §1): la única forma segura de reintentar una creación de cabecera dudosa es **verificar primero
  si ya existe** (por `pedido`/`albaran`) y solo crear una nueva si no aparece.

## 4. Otros escenarios frecuentes

* **`401 UNAUTHORIZED` al llamar a `/api/*`**: falta la cabecera `X-Api-Key` o su valor no
  coincide con `AZA_API_KEY` configurada en el servidor. Ver README, sección "Autenticación de la
  API propia de AZA". No afecta a `/health/*`, que sigue siendo público.
* **`400 INVALID_JSON`**: el cuerpo de la petición no es JSON válido (p. ej. una coma de más, un
  cliente que envía texto plano con `Content-Type: application/json`). Revisar el serializador del
  lado del consumidor, no es un problema de LUX ni de esta API.
* **`503 LUX_NETWORK_ERROR` / `502 LUX_AUTH_ERROR` / `502 LUX_HTTP_ERROR`**: LUX no está disponible
  o devuelve un error no funcional. Reintentar manualmente pasado un rato es seguro en operaciones
  de lectura; en operaciones de escritura, seguir el procedimiento del §2 antes de reintentar
  (comprobar primero si la cabecera llegó a crearse).
* **`422 LUX_FUNCTIONAL_ERROR`**: LUX ejecutó el procedimiento pero rechazó los datos por una regla
  de negocio (`mensaje` distinto de `OK`, con `campo`/`tab` cuando LUX los informa). Corregir el
  dato de entrada; no es un problema transitorio y reintentar sin cambios no ayuda.
