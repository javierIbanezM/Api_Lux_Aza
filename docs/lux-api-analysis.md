# FASE 1 — Análisis de la API LUX (Whales)

Fuente única: `GuiaAPILUX_AZA (1).pdf` ("API Lux (Whales) — Guía de integración para AZA").
Todo lo que no esté explícitamente en ese documento se marca como
`TODO — INFORMACIÓN NO DEFINIDA EN LA DOCUMENTACIÓN`.

## 1. Arquitectura general

```text
Cliente AZA ──HTTP(JSON)──> API Lux ──EXEC p_xxx @param=...──> SQL Server
                                    <──resultset como JSON array──
```

* API Lux = capa REST (Java/JAX-RS) delante de SQL Server. No contiene lógica de negocio propia:
  cada llamada convierte el JSON recibido en `EXEC p_procedimiento @param='valor', ...` y devuelve
  el resultset como JSON.
* Todo parámetro viaja como **string**. No hay tipos: fechas, números y booleanos se envían como
  texto y el procedimiento los interpreta.
* `usuario` y `almacen` **nunca** se envían en el body: los inyecta la API.
  * `usuario` → del JWT (usuario autenticado).
  * `almacen` → de la cabecera HTTP `Almacen`.
* `accion` es el verbo: un mismo procedimiento crea, actualiza o consulta según su valor.
* El nombre del procedimiento debe empezar por `p_`; si no, la API responde `403`.
* La API escapa automáticamente `'` → `''` (anti inyección SQL). El integrador no debe escapar.

## 2. Autenticación

### 2.1 Login

```http
POST /login
Content-Type: application/json

{ "username": "usuarioAPI", "password": "********" }
```

Respuesta `200 OK`:

```json
{
  "name": "usuarioAPI",
  "token": "<JWT>",
  "refreshToken": "<token de refresco>",
  "issuedAt": "...",
  "expiresAt": "...",
  "permisos": [ "..." ]
}
```

* `401` → credenciales incorrectas.
* El `token` es un JWT que caduca (`expiresAt`). Se envía en todas las llamadas siguientes:
  `Authorization: Bearer <JWT>`.
* Todos los endpoints de datos requieren que el usuario de AZA tenga el rol `web`.

### 2.2 Refresco de token

```http
POST /login/refreshToken
Content-Type: application/json

{ "refreshToken": "<token de refresco>" }
```

Devuelve un nuevo `token`. Debe usarse antes de que caduque el JWT en procesos largos.

TODO — INFORMACIÓN NO DEFINIDA EN LA DOCUMENTACIÓN: formato exacto de la respuesta de
`/login/refreshToken` (si devuelve también un nuevo `refreshToken` o solo `token`), código de
error si el `refreshToken` ha caducado o es inválido. Se implementa asumiendo que devuelve como
mínimo `token`, y se trata cualquier fallo de refresh como error de autenticación no recuperable
(forzar nuevo login).

### 2.3 Cabeceras en cada llamada de datos

```http
Authorization: Bearer <JWT>       ← identifica al usuario (parámetro @usuario)
Almacen: <codigo de almacen>      ← selecciona el almacén (parámetro @almacen)
Content-Type: application/json
```

El mismo usuario puede operar sobre distintos almacenes cambiando la cabecera `Almacen`.

## 3. Endpoint `/proc`

Único endpoint necesario para la integración de AZA.

```http
PUT /proc/{nombreProcedimiento}
Authorization: Bearer <JWT>
Almacen: <almacen>
Content-Type: application/json

{ "accion": "...", "campo1": "valor1", "campo2": "valor2" }
```

Reglas de funcionamiento:

* El body es un diccionario plano `string → string`. Cada clave se convierte en `@clave`.
* La API añade `usuario` y `almacen`; **nunca** deben ir en el body.
* Las claves deben coincidir **exactamente** (mayúsculas/minúsculas) con los parámetros del
  procedimiento (`@camelCase`). Una clave mal escrita se ignora silenciosamente (el parámetro
  toma su valor por defecto en el SP) — no produce error HTTP.
* Los parámetros no enviados toman su valor por defecto en el SP (relevante para "datos extra",
  ver §5.3 más abajo).
* Respuesta: array JSON con las filas del `SELECT` que devuelve el procedimiento.
  * Alta/modificación → una sola fila: `[{ "mensaje": "OK", "idPedido": "123" }]` o
    `[{ "mensaje": "ERR_TRANSPORTISTA_NOT_EXISTS", "campo": "TRANSPORTISTA", "tab": "GENERAL" }]`.
  * Los valores `NULL` se devuelven como cadena vacía `""`.

### 3.1 Acciones que usará AZA

| Operación | `accion` | Dónde |
|---|---|---|
| Crear/actualizar cabecera | `ACTUALIZAR` | procedimiento de cabecera (upsert: crea si `id` es `0`, si no actualiza) |
| Crear línea | `INSERT` | procedimiento de líneas |
| Actualizar línea | `UPDATE` | procedimiento de líneas |
| Consultar (listado) | `SELECT` | procedimiento visor |
| Consultar una cabecera | `SELECT_ONE` | procedimiento de cabecera |
| Consultar datos extra | `SELECT_INICIO` | procedimiento de cabecera |

Nota: existe una acción `CHECK_IMPORT` en algunos procedimientos, exclusiva de la importación por
Excel — **no se usa** en esta integración. `ACTUALIZAR`, `INSERT` y `UPDATE` ya realizan
internamente todas las validaciones de negocio necesarias (no duplicar en la app).

## 4. Dataprovider → parámetro (regla de mapeo)

`campo.nombre` (dataprovider) ⟷ `@campo.nombre` (procedimiento SQL) ⟷ clave del JSON en `/proc`.
El mismo nombre se usa en los tres sitios, con avisos:

* El SP es la fuente de la verdad; el dataprovider puede exponer solo un subconjunto de sus
  parámetros. Los parámetros completos usados por AZA están en §6/§7 de este documento (extraídos
  del PDF).
* Algunos nombres del visor **no coinciden** con el parámetro de escritura:
  * Expediciones: la columna del visor es `cliente`, pero el parámetro de escritura es
    `codCliente`.
  * Recepciones: el parámetro de escritura del proveedor es `codProveedor`.
* Campos `"tipo": "SELECT"` con `accionValores` tienen su lista de valores válidos obtenida
  llamando al mismo SP con `accion = <accionValores>` (p. ej. `SELECT_CARGAS`).
* Campos con `"actualizarBBDD": false` son de solo lectura/calculados (p. ej. `volumen`, `peso`,
  `numPalets`) — no tiene sentido enviarlos.

## 5. Reglas transversales

### 5.1 Upsert por id (crear vs. actualizar cabecera)

La acción `ACTUALIZAR` de los procedimientos de cabecera:

* **Crear** → se envía el id a `"0"` (`idPedido` en expedición, `idAlbaran` en recepción).
* **Actualizar** → se envía el id real de la cabecera (el `id` que devuelve el visor `SELECT`).

### 5.2 Fechas

Formato `dd/MM/yyyy` (estilo SQL 103) en todos los procedimientos de cabecera y línea. Si se omite
la fecha:

* Expedición (`fecha` de transporte) → valor por defecto: **mañana**.
* Recepción (`fecha` prevista) → valor por defecto: **hoy**.

No convertir a otro formato al hablar con LUX; la capa interna de AZA puede usar `Date`, pero el
adaptador hacia LUX siempre serializa a `dd/MM/yyyy`.

### 5.3 Datos extra: `null` = no tocar, `""` = borrar, valor = fijar

Los campos de datos extra (y algunos de cabecera como `expedicion`, `carga`, `matricula`) son
`null` por defecto en el SP:

| Qué envías en `/proc` | Efecto |
|---|---|
| No envías la clave (queda `null`) | No se modifica el valor actual |
| Envías la clave con `""` | Se borra el valor |
| Envías la clave con un valor | Se fija ese valor |

Consecuencia práctica: en una modificación, enviar **solo** los campos que se quieren cambiar.

### 5.4 Respuestas de error

Las acciones de escritura devuelven, en error, una fila con `mensaje` (código `ERR_*` o texto
`Error: ...`) y, en cabeceras, además `campo` y `tab` señalando el campo problemático.
Éxito → `mensaje = "OK"` más el id creado/actualizado.

Regla de interpretación: `mensaje === "OK"` ⇒ éxito; cualquier otro valor ⇒ error funcional.

## 6. EXPEDICIONES (pedidos de salida)

| Objeto | Procedimiento | Acciones |
|---|---|---|
| Cabecera | `p_expCabeceraAza` | `ACTUALIZAR`, `SELECT_ONE`, `SELECT_INICIO`, `SELECT_CARGAS`, `SELECT_SERVICE_LEVEL`, `select_propietarios`, `select_tipos`, `select_transportistas` |
| Líneas | `p_expPedidoLineas` | `INSERT`, `UPDATE`, `SELECT` |
| Visor/listado | `p_expedicionesAza` | `SELECT` |

Modelo de datos subyacente (SQL Server, informativo): `expPedidoCabeceras`, `expPedidoLineas`,
`expPedidoExtra`.

### 6.1 `p_expCabeceraAza`, `accion = ACTUALIZAR`

| Parámetro | Oblig. (crear) | Descripción |
|---|---|---|
| `accion` | sí | `ACTUALIZAR` |
| `idPedido` | sí | `"0"` para crear; id real para actualizar |
| `pedido` | no | Nº de pedido/ASN; si vacío al crear se autogenera `PROPIETARIO_AAMMDD_N`. Único por propietario |
| `propietario` | sí | Debe existir y tener expedición activa en el almacén |
| `codCliente` | sí | Código de cliente asociado al propietario |
| `clienteNombre` | no | Nombre del cliente |
| `transportista` | sí | Debe existir y estar asignado al propietario |
| `serviceLevel` | sí al crear | Debe estar asociado al transportista |
| `tipoPedido` | no | Por defecto `NORMAL` |
| `fecha` | no | Fecha de transporte `dd/MM/yyyy`; si vacía → mañana |
| `prioridad` | no | Numérico; por defecto `0` |
| `observaciones` | no | Observaciones de cabecera |
| `pedidoCliente` | no | Referencia de pedido del cliente |
| `bloqueo` | no | Nombre de bloqueo (tabla `bloqueos`) |
| `direccion`, `cp`, `poblacion`, `provincia`, `pais`, `telefono`, `correo`, `contacto`, `razonSocial` | no | Dirección de entrega (`...F` = dirección de facturación — TODO: nombres exactos de los campos `...F` no confirmados en el PDF) |

Datos extra (misma llamada, semántica §5.3): `facturarTransporte`, `expedicion`,
`observacionesAlbaran`, `observacionesAlmacen`, `carga`, `fechaEntrega`, `serviceLevel`.

Validaciones internas (las realiza LUX, no duplicar en AZA): propietario existe · cliente asociado
al propietario · transportista existe y asociado al propietario · pedido no duplicado · fecha
válida · fechaEntrega válida · nivel de servicio asociado al transportista.

Respuesta éxito: `{ "mensaje": "OK", "idPedido": "<id>", "pedido": "<numeroAsn>", ... }`.

Ejemplo crear:

```json
PUT /proc/p_expCabeceraAza
{
  "accion": "ACTUALIZAR", "idPedido": "0",
  "pedido": "PED-0001", "propietario": "AZA", "codCliente": "C001",
  "transportista": "SEUR", "serviceLevel": "24H", "fecha": "15/08/2026",
  "observacionesAlbaran": "Entregar en muelle 3", "fechaEntrega": "18/08/2026"
}
// → [{ "mensaje": "OK", "idPedido": "1234", "pedido": "PED-0001", ... }]
```

Ejemplo actualizar (solo cambia transportista, el resto no se toca):

```json
PUT /proc/p_expCabeceraAza
{ "accion": "ACTUALIZAR", "idPedido": "1234",
  "propietario": "AZA", "codCliente": "C001", "transportista": "DHL", "serviceLevel": "24H" }
```

### 6.2 `p_expPedidoLineas`

| Parámetro | Descripción |
|---|---|
| `accion` | `INSERT` / `UPDATE` / `SELECT` |
| `pedido` | Nº de pedido (ASN); el SP resuelve el id de cabecera a partir de él |
| `idParent` | Alternativa a `pedido`: id de cabecera directamente |
| `id` | (solo `UPDATE`) id de la línea a modificar |
| `referencia` | Obligatoria. Debe existir para el propietario del pedido |
| `cantidadPedida` | Obligatoria. Numérica |
| `linea` | Nº de línea |
| `lote` | Solo si la referencia lo requiere |
| `bloqueo` | Nombre de bloqueo de línea |
| `observaciones` | Observaciones de línea |
| `referenciaCliente` | Referencia del cliente |
| `vidaUtil` | Fecha `dd/MM/yyyy` |

Crear línea (por número de pedido):

```json
PUT /proc/p_expPedidoLineas
{ "accion": "INSERT", "pedido": "PED-0001",
  "linea": "1", "referencia": "REF-100", "cantidadPedida": "24", "lote": "L2026" }
// → [{ "mensaje": "OK", "id": "..." }]
```

Actualizar línea (por id):

```json
PUT /proc/p_expPedidoLineas
{ "accion": "UPDATE", "id": "55010", "cantidadPedida": "30" }
```

Consultar líneas de una cabecera: `{ "accion": "SELECT", "idParent": "<idPedido>" }`.

### 6.3 `p_expedicionesAza`, `accion = SELECT`

Filtros (opcionales, se combinan con AND; texto usa `LIKE`, admite `%`): `pedido`, `propietario`,
`cliente`, `clienteNombre`, `estado`, `tipo`, `fecha`/`fecha_fin`,
`fechaCreacion`/`fechaCreacion_fin`, `fechaCerrado`/`fechaCerrado_fin`, `expedicion`,
`deliveryNumber`, `transportista`, `pedidoCliente`, `observaciones`, `agrupacion`, `prioridad`,
`ruta`, `referencia`, `poblacion`, `pais`, `provincia`.

Columnas devueltas (principales): `id` (id de cabecera, usar para detalle/líneas), `pedido`,
`propietario`, `cliente`, `clienteNombre`, `estado`, `tipo`, `fecha`, `observaciones`,
`prioridad`, `expedicion`, `transportista`, `fechaCreacion`, `fechaCerrado`,
`lineas` (servidas/total), `unidades`, `muelle`, `ruta`, `nivelServicio`, `fechaEntrega`,
`facturarTransporte`, `carga`, `serviceLevel`.

Listas de valores para filtros: `accion=pedido_estado` (estados), `accion=pedido_tipos` (tipos).

Ejemplo:

```json
PUT /proc/p_expedicionesAza
{
  "accion": "SELECT",
  "propietario": "AZA",
  "estado": "TODOS",
  "pedido": "PED-0001%",
  "fecha": "01/08/2026", "fecha_fin": "31/08/2026"
}
```

Detalle de una expedición (con el `id` obtenido en el listado):

```json
// Cabecera:    PUT /proc/p_expCabeceraAza    { "accion": "SELECT_ONE",   "idPedido": "1234" }
// Datos extra: PUT /proc/p_expCabeceraAza    { "accion": "SELECT_INICIO","idParent": "1234" }
// Líneas:      PUT /proc/p_expPedidoLineas   { "accion": "SELECT",       "idParent": "1234" }
```

## 7. RECEPCIONES (albaranes de entrada)

| Objeto | Procedimiento | Acciones |
|---|---|---|
| Cabecera | `p_recCabeceraAza` | `ACTUALIZAR`, `SELECT_ONE`, `SELECT_INICIO`, `SELECT_DESCARGAS` |
| Líneas | `p_recAlbaranLineas` | `INSERT`, `UPDATE`, `SELECT` |
| Visor/listado | `p_recepcionesAza` | `SELECT` |

Modelo de datos subyacente (informativo): `albaranes`, `albaranesLinea`, `albaranesExtra`.

### 7.1 `p_recCabeceraAza`, `accion = ACTUALIZAR`

| Parámetro | Oblig. (crear) | Descripción |
|---|---|---|
| `accion` | sí | `ACTUALIZAR` |
| `idAlbaran` | sí | `"0"` para crear; id real para actualizar |
| `albaran` | no | Nº de albarán; si vacío al crear se autogenera `PROPIETARIO_AAMMDD_N`. Único por propietario |
| `propietario` | sí | Debe existir y tener recepción activa en el almacén |
| `codProveedor` | sí | Código de proveedor del propietario (o global). Si hay un solo proveedor puede omitirse |
| `fecha` | no | Fecha prevista `dd/MM/yyyy`; si vacía → hoy |
| `tipoAlbaran` | no | Por defecto `NORMAL`. No se admite `CROSSDOCK` ni `DIRECTO CLIENTE` |
| `ue` | no | `NO` → no UE; cualquier otro valor → UE |
| `agencia` | no | Transportista; debe existir |
| `ubicacionRecepcion` | no | Ubicación de zona de recepción (o de devolución según el tipo) |
| `empresa` | no | Debe existir en `empresas` |
| `bloqueo` | no | Nombre de bloqueo de cabecera |
| `observaciones` | no | Observaciones del albarán |

Datos extra (misma llamada, semántica §5.3): `matricula` (tractora), `matRemolque`, `dni`,
`nombre`, `apellidos`, `telefono`, `observacionesPDA`, `descarga`.

Validaciones internas: hay proveedores · propietario requerido/existe/con recepción activa ·
proveedor coherente con el propietario · albarán no duplicado (si aplica) · tipo no
CROSSDOCK/DIRECTO CLIENTE · fecha válida · ubicación de recepción válida · empresa/bloqueo
válidos.

Respuesta éxito: `{ "mensaje": "OK", "idAlbaran": "<id>", "albaran": "<nº>", ... }`.

Ejemplo crear cabecera:

```json
PUT /proc/p_recCabeceraAza
{
  "accion": "ACTUALIZAR", "idAlbaran": "0",
  "albaran": "ALB-77", "propietario": "AZA", "codProveedor": "PROV1",
  "fecha": "12/08/2026", "agencia": "SEUR", "ue": "SI",
  "matricula": "1234ABC", "dni": "12345678Z", "nombre": "Juan"
}
// → [{ "mensaje": "OK", "idAlbaran": "3012", "albaran": "ALB-77", ... }]
```

### 7.2 `p_recAlbaranLineas`

Las líneas de recepción cuelgan del id de albarán (`idParent`); crear primero la cabecera (§7.1)
para obtener `idAlbaran`.

| Parámetro | Descripción |
|---|---|
| `accion` | `INSERT` / `UPDATE` / `SELECT` |
| `idParent` | id del albarán (cabecera). Obligatorio |
| `id` | (solo `UPDATE`) id de la línea |
| `referencia` | Obligatoria. Debe existir para el propietario |
| `piezasAlbaran` | Cantidad del albarán. Numérica |
| `linea` | Nº de línea |
| `lote` | Según la referencia |
| `fechaCaducidad` | Fecha `dd/MM/yyyy` |
| `observaciones` | Observaciones de línea |
| `cliente` | Código de cliente (cross-dock a cliente) |
| `entrega` | Nº de pedido de expedición (`numeroAsn`) al que se vincula |
| `bloqueo` | Nombre de bloqueo de línea |

Crear línea:

```json
PUT /proc/p_recAlbaranLineas
{ "accion": "INSERT", "idParent": "3012",
  "linea": "1", "referencia": "REF-100", "piezasAlbaran": "50", "lote": "L1",
  "fechaCaducidad": "31/12/2026" }
// → [{ "mensaje": "OK", "id": "..." }]
```

Actualizar línea:

```json
PUT /proc/p_recAlbaranLineas
{ "accion": "UPDATE", "id": "88010", "piezasAlbaran": "60" }
```

### 7.3 `p_recepcionesAza`, `accion = SELECT`

Filtros (opcionales): `albaran`, `matricula`, `proveedor`, `propietario`, `cliente`, `estado`,
`tipo`, `observaciones`, `fechaPrevista`/`fechaPrevista_FIN`,
`fechaRecepcion`/`fechaRecepcion_FIN`. Devuelve, entre otras columnas, `id` = id del albarán.

Detalle de un albarán:

```json
// Cabecera:    PUT /proc/p_recCabeceraAza     { "accion": "SELECT_ONE",   "idAlbaran": "3012" }
// Datos extra: PUT /proc/p_recCabeceraAza     { "accion": "SELECT_INICIO","idParent": "3012" }
// Líneas:      PUT /proc/p_recAlbaranLineas   { "accion": "SELECT",       "idParent": "3012" }
```

## 8. Flujos completos

### 8.1 Alta de un pedido de expedición

1. `PUT /proc/p_expCabeceraAza { accion:"ACTUALIZAR", idPedido:"0", propietario, codCliente, transportista, serviceLevel, ... }` → `idPedido`/`pedido`.
2. `PUT /proc/p_expPedidoLineas { accion:"INSERT", pedido:"PED-0001", referencia, cantidadPedida }` (repetir por cada línea).

### 8.2 Alta de un albarán de recepción

1. `PUT /proc/p_recCabeceraAza { accion:"ACTUALIZAR", idAlbaran:"0", propietario, codProveedor, ... }` → `idAlbaran`.
2. `PUT /proc/p_recAlbaranLineas { accion:"INSERT", idParent:"<idAlbaran>", referencia, piezasAlbaran }` (repetir por cada línea).

### 8.3 Consulta

1. `PUT /proc/p_expedicionesAza` (o `p_recepcionesAza`) `{ accion:"SELECT", ...filtros }` → filas con `id`.
2. (opcional) detalle: `SELECT_ONE` (cabecera) + `SELECT_INICIO` (extra) + `SELECT` (líneas) por `id`.

## 9. Buenas prácticas del proveedor (aplicadas literalmente)

1. Cabecera primero, líneas después.
2. Crear = id `"0"`; actualizar = id real. La acción es `ACTUALIZAR` en ambos casos.
3. En modificaciones, enviar solo lo que cambia (semántica §5.3).
4. Fechas `dd/MM/yyyy` en todas las llamadas.
5. Nombres de parámetro exactos: `codCliente` (no `cliente`), `codProveedor` (no `proveedor`).
6. No enviar `usuario` ni `almacen`.
7. Catálogos: usar la acción correspondiente del SP (`SELECT_CARGAS`, `SELECT_SERVICE_LEVEL`,
   `SELECT_DESCARGAS`, `select_transportistas`, `pedido_estado`, `pedido_tipos`, …).
8. Comprobar siempre `mensaje` en la respuesta.
9. Refrescar el token con `/login/refreshToken` antes de que caduque.

## 10. Referencia rápida

| Objetivo | Procedimiento | `accion` |
|---|---|---|
| Crear/actualizar cabecera de expedición | `p_expCabeceraAza` | `ACTUALIZAR` (id `0` = crear) |
| Leer cabecera / datos extra de expedición | `p_expCabeceraAza` | `SELECT_ONE` / `SELECT_INICIO` |
| Crear/actualizar/consultar líneas de expedición | `p_expPedidoLineas` | `INSERT` / `UPDATE` / `SELECT` |
| Consultar expediciones | `p_expedicionesAza` | `SELECT` |
| Crear/actualizar cabecera de recepción | `p_recCabeceraAza` | `ACTUALIZAR` (id `0` = crear) |
| Leer cabecera / datos extra de recepción | `p_recCabeceraAza` | `SELECT_ONE` / `SELECT_INICIO` |
| Crear/actualizar/consultar líneas de recepción | `p_recAlbaranLineas` | `INSERT` / `UPDATE` / `SELECT` |
| Consultar recepciones | `p_recepcionesAza` | `SELECT` |

## 11. Whitelist de procedimientos autorizados para AZA

Únicos procedimientos que la integración de AZA debe poder invocar vía `/proc`:

```text
p_expCabeceraAza
p_expPedidoLineas
p_expedicionesAza
p_recCabeceraAza
p_recAlbaranLineas
p_recepcionesAza
```

Cualquier otro nombre debe ser rechazado por la aplicación de AZA **antes** de llamar a LUX (capa
de whitelist local), independientemente de que LUX ya valide el prefijo `p_` y devuelva `403`.

## 12. Puntos no definidos en la documentación

* Formato exacto de la respuesta de `/login/refreshToken` (TODO, ver §2.2).
* Nombres exactos de los campos de dirección de facturación (`...F`) en `p_expCabeceraAza`.
* Lista cerrada de valores posibles para `estado` en expediciones/recepciones (más allá de
  `TODOS` como comodín) — se obtiene en tiempo de ejecución vía `accion=pedido_estado`.
* Códigos de error `ERR_*` completos: solo se documenta el ejemplo `ERR_TRANSPORTISTA_NOT_EXISTS`.
  El resto de códigos no se enumeran; la aplicación debe tratar cualquier `mensaje !== "OK"` como
  error genérico y propagar el código recibido tal cual, sin mapear a una lista cerrada inventada.
* Límite de tamaño de página / paginación en las consultas `SELECT` de listados — no se menciona
  ningún parámetro de paginación en la documentación; no se inventa ninguno. **Confirmado contra
  el servidor real (2026-09-29)**: una única consulta `p_expedicionesAza`/`SELECT` sin filtrar por
  fecha puede devolver >1000 filas y >1MB de JSON en una sola respuesta. Recomendación operativa
  para AZA (no viene de LUX): filtrar siempre por rango de fecha/estado en listados de volumen
  alto, ya que no hay paginación nativa que lo evite.
* Idempotency-key — la documentación no menciona ningún mecanismo de idempotencia nativo de LUX
  (ver `docs/troubleshooting.md`, sección de idempotencia).

## 13. Confirmado contra el servidor real de LUX (2026-09-29)

* `POST /login` responde `200` con el shape documentado, más un detalle no cubierto por el PDF:
  **`issuedAt`/`expiresAt` vienen en formato `java.time.ZonedDateTime`**, p. ej.
  `"2026-10-09T12:45:23.081Z[UTC]"` — ISO-8601 válido seguido de un sufijo `[ZoneId]` que
  `Date.parse` (ECMA-262) **no** reconoce por sí solo. Corregido en
  [`src/auth/AuthManager.ts`](../src/auth/AuthManager.ts) (`parseExpiry` elimina el sufijo
  `[...]` antes de parsear); cubierto por un test dedicado en `tests/auth/AuthManager.test.ts`.
* `refreshToken` es un identificador opaco tipo GUID (no JWT), p. ej.
  `"342BBF689D3-4615-4E57-9D06-5E85AA90A1D4"` — no requiere manejo especial, se trata como string.
* `token` es un JWT `HS512` con claims `iat`/`sub`/`exp`; `sub` coincide con el `username` usado en
  el login.
* Confirmado que `PUT /proc/p_expedicionesAza` con `accion: "SELECT"` funciona end-to-end a través
  de nuestra API propia (`GET /api/expediciones`), incluyendo login automático y filtros
  (`propietario`, `estado`).
* El PDF (§6.3) solo documenta las columnas "principales" del visor de expediciones. Contra el
  servidor real, `p_expedicionesAza`/`SELECT` devuelve **62 columnas**, muchas más de las
  documentadas — incluye además flags internos de la UI de Whales
  (`action#imprimir`, `action#BLOQUEAR`, `action#ASIGNAR`, `action#DESASIGNAR`, `action#edit`,
  `action#delete`, `action#ANULAR`, `action#REABRIR`, `action#MULTI`, `action#OLEADA`,
  `action#DESAGRUPAR`, `action#DESAGRUPAR_AGRUPACION`, `action#CERRAR_OFICINA`,
  `action#DESBLOQUEAR`, `action#PASAR_ALMACEN_WMS`, `action#PASAR_PICKING_ALMACEN_WMS`) y campos
  de uso interno no documentados (`colorEstado`, `txtAlbaran`, `txtPicking`, `extraMostrar`,
  `extra1`, `extra2`, `generarDeca`, `saltarConsolidacion`, `almacenVirtual`, `oleada`,
  `paletizado`, `descripcionRuta`, `numContenedores`, `numPalets`, `pallets`, `volumen`, `peso`,
  `direccion`, `poblacion`, `provincia`, `pais`, `contacto`, `deliveryNumber`, `agrupacion`,
  `pedidoCliente`, `fechaRuta`, `muelle`). El resto (`transportista`, `ruta`, `prioridad`,
  `unidades`, `fechaCreacion`, `fechaCerrado`, `nivelServicio`, `fechaEntrega`,
  `facturarTransporte`, `carga`, `expedicion`, `observaciones`, `lineas`) coincide con §6.3.
  Estos campos se exponen sin filtrar como `resumenListado` en el detalle de expedición
  (`GET /api/expediciones/:idPedido` y `/almacen/expediciones/:id`), a petición explícita del
  usuario — ver `docs/progress.md` fase 17.

## 14. `p_expPedidoContenedores` — no documentado en el PDF, confirmado por prueba directa (2026-09-29)

Este procedimiento **no aparece en `GuiaAPILUX_AZA.pdf`**. Se descubrió porque el usuario dio un
ejemplo real de uso (`{"accion":"SELECT_INICIO","idParent":"41216"}`) y se confirmó contra el
servidor real de LUX (`SAGUNTO`, `http://192.168.2.145:8081`). Es el detalle de
**contenedores/bultos** (nivel pallet/HU) de una línea de expedición ya creada.

* Procedimiento: `p_expPedidoContenedores`.
* Acción confirmada: `SELECT_INICIO` con `idParent` = `idPedido` (mismo patrón que
  `p_expCabeceraAza`/`SELECT_INICIO` para datos extra). **No se ha probado ninguna otra acción**
  (`INSERT`/`UPDATE`/`SELECT`) — no se soportan hasta confirmarlas expresamente.
* Respuesta: array de filas, una por contenedor. Ejemplo real (pedido `180278`, id `5034`,
  propietario `CAMELIA`):

```json
[
  {
    "id": "296821",
    "contenedor": "800295985",
    "hu": "WH0004731",
    "referencia": "3760297542238",
    "cantidad": "1.0000",
    "lote": "",
    "fechaCaducidad": "",
    "ubicacion": "",
    "pallet": "",
    "observaciones": "",
    "largoContenedor": "",
    "anchoContenedor": "",
    "altoContenedor": "",
    "pesoContenedor": ""
  }
]
```

* Añadido a la whitelist (`src/lux/procedures/whitelist.ts`), modelo `ExpedicionContenedor`
  (`src/lux/models/expedicion.ts`), método
  `ExpedicionesService.obtenerContenedoresExpedicion(idPedido)`, expuesto en
  `GET /api/expediciones/:idPedido` (campo `contenedores` del detalle) y en
  `GET /api/expediciones/:idPedido/contenedores`, y visible en la pantalla de detalle de
  `/almacen/expediciones/:id`.
* TODO — no confirmado: si existe un procedimiento equivalente para **recepciones** (contenedores
  de un albarán de entrada). No se ha preguntado ni probado; no se inventa.

## 15. `p_recCabeceraAza`, `accion=SELECT_DESCARGAS` con filtro `propietario` (2026-09-29)

El PDF documenta la acción `SELECT_DESCARGAS` de `p_recCabeceraAza` (§7, tabla de acciones) pero
no especifica sus parámetros. El usuario aportó un ejemplo real de uso —
`{"accion":"SELECT_DESCARGAS","propietario":"00180107"}` — confirmando que acepta (y, a la vista
de los resultados, requiere para obtener datos) un filtro `propietario`.

Confirmado contra el servidor real (`SAGUNTO`): sin `propietario`, o con un propietario sin zonas
configuradas, devuelve `[]`; con `propietario=CAMELIA` devuelve las zonas de descarga válidas para
ese propietario, con forma `{ "campo": "<descripción>" }`, p. ej.:

```json
[
  { "campo": "Descarga Granel Contenedor de 40'" },
  { "campo": "Descarga Granel Contenedor de 20'" },
  { "campo": "FURGON" },
  { "campo": "Descarga Contenedor 20' mixto (latas)" }
]
```

* `CatalogosService.selectDescargas(propietario?, almacen?)` ahora acepta `propietario` (antes se
  llamaba sin parámetros); la caché es por almacén + propietario.
* `GET /api/catalogos/descargas?propietario=<código>` — nuevo parámetro de query.
* `GET /api/recepciones/:idAlbaran` (detalle) incluye ahora `descargas`: las zonas de descarga
  válidas para el `propietario` de esa recepción concreta (se llama automáticamente tras obtener
  la cabecera). Visible también en `/almacen/recepciones/:id`.
* TODO — no confirmado: si `propietario` es estrictamente obligatorio o solo recomendado (sin él
  no se ha observado ningún error, solo una lista vacía).

## 16. Watcher de logs LUX y otros procedimientos no documentados (2026-09-30)

Ver `src/watcher/actionPatterns.ts` para la tabla completa de eventos de negocio detectados a
partir de los logs de LUX (oficina + PDA de almacén), con las líneas reales que confirman cada
uno. Resumen de procedimientos/acciones no documentados en el PDF, confirmados por observación
directa del log o contra el servidor real:

* `p_wm_expSinConsolidar @estado='CERRAR'` (PDA) — cierre de picking de una expedición.
* `p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR'` — cierre de oficina forzado.
* `p_expediciones @accion='REABRIR_FORZAR'` — reapertura forzada (confirmado en vivo, EXP0000076).
* `p_expediciones @accion='ANULAR_FIN_FORZAR'` — anulación forzada.
* `p_expRutasDetalle @accion='INSERT'` — asignación de un pedido a una ruta (tercera vía de cierre).
* `p_expRutasDetalle @accion='SELECT'` con `idParent=<idRuta>` — resuelve qué pedidos lleva una ruta.
* `p_expRutas @accion='ENVIAR_FORZAR'` — envío forzado de una ruta.
* `p_expPasarAlmacenPC @accion='PASAR_ALMACEN_WMS'` — pasar a almacén (expediciones).
* `p_recepciones @accion='PASAR_ALMACEN'` — pasar a almacén (recepciones; procedimiento distinto
  de `p_recepcionesAza`, confirmado en vivo sobre REC0000068).
* `p_wm_recepcionCerrar @estado='CONFIRMAR_CERRAR'` (PDA) — cierre físico de una recepción.
* `p_wm_recepcion @estado='SELECT_MOVIMIENTO'` con `@valor` no vacío (PDA) — confirmación de una
  línea de recepción contra su HU/pallet escaneado. El mismo `estado` se repite varias veces por
  línea como menú intermedio con `valor=''`; solo dispara con `valor` no vacío.
* `p_recAlbaranHUPreinformado`, `accion=SELECT_INICIO`, `idParent=<idAlbaran>` — HUs/pallets
  físicos recepcionados de un albarán (equivalente de `p_expPedidoContenedores` para recepciones,
  forma de datos propia: `numeroSerie`, `ubicacion`, `lote`, `hu`, `piezas`, etc.). Confirmado
  contra el servidor real (REC0000068): el HU viene como `"000008901 [TAS3009261536]"`.
* `p_expCabeceraAza`/`p_recCabeceraAza`, `accion=SELECT_INICIO` con `propietario=<código>` (en vez
  de `idParent=<id>`) — plantilla de datos extra para un pedido/albarán **que todavía no existe**,
  antes de crearlo, con los valores por defecto según la configuración de ese propietario.
  Confirmado contra el servidor real. Expuesto en `GET /api/expediciones/datos-extra?propietario=`
  y `GET /api/recepciones/datos-extra?propietario=`.
* `p_expRutasDeca`, `accion=SELECT` con `id=<idRuta>` — estado del envío/manifiesto EDI hacia el
  transportista de una ruta (`shipmentReference`, `estado`, `shipmentStatus`, `documentStatus`,
  etc.). Confirmado contra el servidor real. **No integrado todavía** (pendiente de decidir si es
  endpoint propio o parte del watcher). `accion=SELECT_ENVIOS` (con o sin `id`) devuelve 200 con
  cuerpo vacío en las pruebas realizadas — no confirmado si es una acción soportada o le falta
  algún parámetro.

Todos estos procedimientos que solo se usan para lectura desde el watcher (no expuestos por ningún
endpoint de `/api/*`) están en la whitelist igualmente (`src/lux/procedures/whitelist.ts`) para que
`LuxClient` los acepte cuando el watcher los invoca.

## 17. `p_recepcionesAza`, `accion=SELECT` oculta las recepciones `CERRADO` sin filtro de `estado` (2026-10-01)

Confirmado contra el servidor real (producción, `.140`): `p_recepcionesAza SELECT` **sin** filtro
`estado` NO devuelve las recepciones en estado `CERRADO` — hacía falta pedir explícitamente
`estado='CERRADO'` para verlas. En un almacén real esto escondía **4018** recepciones `CERRADO`
frente a solo 123 del resto de estados combinados (`CREACION`, `PTE. RECEPCION`, `DISCREPANCIA`,
`RECEPCION`, `RECEPCIONADO`). Un valor vacío (`estado=''`) no cambia el comportamiento — hay que
pedir literalmente `'CERRADO'`.

**Importante**: `p_expedicionesAza SELECT` (expediciones) **no tiene este problema** — su listado
sin filtro sí incluye las `CERRADO` (confirmado: 115 de 343 filas eran `CERRADO`). Es un
comportamiento específico de `p_recepcionesAza`, no un patrón general de la API.

* `RecepcionesService.listarRecepciones` ahora hace una segunda llamada con `estado='CERRADO'` y
  fusiona el resultado, **solo cuando el llamador no pidió ya un `estado` concreto** (si se filtra
  por un estado explícito, como antes, una sola llamada). Afecta tanto a `GET /api/recepciones`
  como a `/almacen/recepciones`.
* TODO — no confirmado: si existen otros estados de recepción igual de "ocultos" sin filtro
  (se probó `ANULADO`, `RECIBIDO`, `FINALIZADO`: ninguno de los tres tiene datos actualmente, así
  que no se puede confirmar si también estarían ocultos).
* Nota de rendimiento: con el fix, el listado sin filtro de un almacén con mucho histórico puede
  devolver miles de filas (4141 en el caso probado) en una sola respuesta/tabla sin paginar — no
  se ha añadido paginación, solo se corrigió que faltaban datos.
