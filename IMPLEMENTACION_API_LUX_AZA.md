# API LUX (WHALES) — IMPLEMENTACIÓN PARA AZA LOGISTICS

## 0. MISIÓN PRINCIPAL

Estás trabajando en el proyecto de integración de **AZA Logistics** con el SGA **Whales / LUX**.

El proveedor del SGA estaba desarrollando una API para AZA, pero ha decidido entregar la documentación técnica para que **AZA desarrolle y mantenga su propia integración**.

Tu misión es:

> **Analizar toda la documentación disponible, inspeccionar el proyecto existente, diseñar e implementar la integración/API necesaria para AZA y dejar el proyecto preparado para desarrollo, pruebas y producción.**

No quiero únicamente documentación ni ejemplos de código.

Quiero que **construyas el proyecto real**.

Debes trabajar de forma autónoma utilizando los agentes y skills disponibles en Claude Code Pro cuando sean útiles.

---

# 1. REGLA FUNDAMENTAL

Antes de escribir código:

1. Inspecciona completamente el directorio del proyecto.
2. Localiza todos los archivos existentes.
3. Detecta el lenguaje y framework actuales.
4. Detecta si existe ya código relacionado con:

   * Whales
   * LUX
   * API
   * SQL Server
   * MySQL
   * pedidos
   * expediciones
   * recepciones
   * clientes
   * transportistas
   * almacenes
5. Revisa los archivos de configuración.
6. Revisa README, documentación y scripts.
7. Revisa `.gitignore`.
8. Revisa `.env.example` si existe.
9. Identifica las dependencias actuales.
10. Identifica cualquier integración existente que pueda reutilizarse.

### MUY IMPORTANTE

No destruyas código existente.

No sustituyas una implementación existente sin comprender primero para qué sirve.

Si existe código relacionado con la antigua integración Whales, determina qué partes pueden reutilizarse y cuáles deben sustituirse.

---

# 2. DOCUMENTACIÓN FUENTE

La documentación proporcionada por el proveedor describe:

**API Lux (Whales) — Guía de integración para AZA**

La arquitectura descrita es:

```text
AZA
 |
 | HTTP + JSON
 v
API LUX
 |
 | EXEC procedimiento almacenado
 v
SQL Server / Whales
```

La API LUX actúa como una capa REST delante de SQL Server.

No contiene la lógica de negocio principal.

Las llamadas terminan ejecutando procedimientos almacenados de Whales.

---

# 3. PRINCIPIO "SOURCE OF TRUTH"

Debes considerar como fuentes de verdad, en este orden:

1. Código/procedimientos SQL reales disponibles en el proyecto.
2. Documentación oficial proporcionada por el proveedor.
3. Dataproviders de Whales.
4. Código existente de integración de AZA.
5. Inferencias técnicas únicamente cuando sean imprescindibles.

### PROHIBIDO

No inventes:

* endpoints
* parámetros
* nombres de procedimientos
* reglas de negocio
* códigos de error
* campos
* estados
* credenciales
* URLs
* estructuras SQL

Si algo no está definido:

```text
TODO — INFORMACIÓN NO DEFINIDA EN LA DOCUMENTACIÓN
```

y continúa con el resto de la implementación que sí esté definida.

---

# 4. OBJETIVO FUNCIONAL

La integración debe permitir a AZA trabajar con:

## EXPEDICIONES

* Crear pedido de expedición.
* Actualizar pedido.
* Consultar expediciones.
* Consultar cabecera.
* Consultar datos extra.
* Crear líneas.
* Actualizar líneas.
* Consultar líneas.
* Obtener catálogos necesarios.

## RECEPCIONES

* Crear albarán de recepción.
* Actualizar albarán.
* Consultar recepciones.
* Consultar cabecera.
* Consultar datos extra.
* Crear líneas.
* Actualizar líneas.
* Consultar líneas.
* Obtener catálogos necesarios.

---

# 5. AUTENTICACIÓN

Implementar:

```http
POST /login
```

Body:

```json
{
  "username": "usuarioAPI",
  "password": "********"
}
```

Respuesta esperada:

```json
{
  "name": "usuarioAPI",
  "token": "<JWT>",
  "refreshToken": "<token>",
  "issuedAt": "...",
  "expiresAt": "...",
  "permisos": []
}
```

También:

```http
POST /login/refreshToken
```

Body:

```json
{
  "refreshToken": "<token>"
}
```

## Reglas

El JWT debe enviarse:

```http
Authorization: Bearer <JWT>
```

Las llamadas de datos necesitan:

```http
Almacen: <codigo_almacen>
```

y:

```http
Content-Type: application/json
```

Nunca guardar credenciales en código.

Nunca incluir:

* passwords
* tokens
* refresh tokens
* secretos

en Git.

Utilizar variables de entorno.

Crear:

```text
.env.example
```

pero nunca:

```text
.env
```

con credenciales reales.

---

# 6. GESTIÓN DEL TOKEN

Implementar un módulo centralizado de autenticación.

Debe:

1. Hacer login.
2. Guardar temporalmente el JWT.
3. Conocer `expiresAt`.
4. Renovar mediante `refreshToken`.
5. Reintentar una petición cuando sea apropiado si el token ha expirado.
6. Evitar múltiples refresh simultáneos.
7. Registrar errores de autenticación sin revelar secretos.

Debe existir una estrategia segura para procesos largos.

---

# 7. ENDPOINT PRINCIPAL DE LUX

La API documentada utiliza:

```http
PUT /proc/{nombreProcedimiento}
```

Ejemplo:

```http
PUT /proc/p_expCabeceraAza
```

Headers:

```http
Authorization: Bearer <JWT>
Almacen: <almacen>
Content-Type: application/json
```

Body:

```json
{
  "accion": "ACTUALIZAR",
  "idPedido": "0"
}
```

---

# 8. REGLA DEL ENDPOINT /proc

El body es:

```text
string -> string
```

Cada clave corresponde a un parámetro del procedimiento almacenado.

Ejemplo:

```json
{
  "accion": "INSERT",
  "pedido": "PED-1",
  "referencia": "REF-100",
  "cantidadPedida": "24"
}
```

equivale conceptualmente a:

```sql
EXEC p_expPedidoLineas
    @accion='INSERT',
    @pedido='PED-1',
    @referencia='REF-100',
    @cantidadPedida='24',
    @usuario='<usuario>',
    @almacen='<almacen>'
```

---

# 9. USUARIO Y ALMACÉN

Nunca enviar:

```json
{
  "usuario": "...",
  "almacen": "..."
}
```

El proveedor indica que:

```text
usuario = obtenido del JWT
almacen = obtenido de header Almacen
```

La aplicación debe respetar esto.

---

# 10. SEGURIDAD DEL NOMBRE DEL PROCEDIMIENTO

Los procedimientos deben comenzar por:

```text
p_
```

Si no:

```text
403
```

La implementación debe validar esto antes de realizar llamadas.

No permitir que un usuario pueda utilizar arbitrariamente procedimientos SQL.

Preferiblemente utilizar una whitelist de procedimientos permitidos.

---

# 11. PROCEDIMIENTOS AUTORIZADOS

Inicialmente:

## Expediciones

```text
p_expCabeceraAza
p_expPedidoLineas
p_expedicionesAza
```

## Recepciones

```text
p_recCabeceraAza
p_recAlbaranLineas
p_recepcionesAza
```

---

# 12. ACCIONES

## Expediciones

### Cabecera

```text
ACTUALIZAR
SELECT_ONE
SELECT_INICIO
SELECT_CARGAS
SELECT_SERVICE_LEVEL
select_propietarios
select_tipos
select_transportistas
```

### Líneas

```text
INSERT
UPDATE
SELECT
```

### Visor

```text
SELECT
```

---

# 13. RECEPCIONES

### Cabecera

```text
ACTUALIZAR
SELECT_ONE
SELECT_INICIO
SELECT_DESCARGAS
```

### Líneas

```text
INSERT
UPDATE
SELECT
```

### Visor

```text
SELECT
```

---

# 14. EXPEDICIONES — CABECERA

Procedimiento:

```text
p_expCabeceraAza
```

Crear/actualizar:

```text
accion = ACTUALIZAR
```

Crear:

```text
idPedido = "0"
```

Actualizar:

```text
idPedido = "<ID REAL>"
```

Parámetros principales:

```text
accion
idPedido
pedido
propietario
codCliente
clienteNombre
transportista
serviceLevel
tipoPedido
fecha
prioridad
observaciones
pedidoCliente
bloqueo
direccion
cp
poblacion
provincia
pais
telefono
correo
contacto
razonSocial
```

Datos extra:

```text
facturarTransporte
expedicion
observacionesAlbaran
observacionesAlmacen
carga
fechaEntrega
serviceLevel
```

---

# 15. EXPEDICIONES — LÍNEAS

Procedimiento:

```text
p_expPedidoLineas
```

Acciones:

```text
INSERT
UPDATE
SELECT
```

Parámetros:

```text
accion
pedido
idParent
id
referencia
cantidadPedida
linea
lote
bloqueo
observaciones
referenciaCliente
vidaUtil
```

Crear:

```json
{
  "accion": "INSERT",
  "pedido": "PED-0001",
  "linea": "1",
  "referencia": "REF-100",
  "cantidadPedida": "24"
}
```

Actualizar:

```json
{
  "accion": "UPDATE",
  "id": "55010",
  "cantidadPedida": "30"
}
```

---

# 16. EXPEDICIONES — CONSULTA

Procedimiento:

```text
p_expedicionesAza
```

Acción:

```text
SELECT
```

Filtros disponibles:

```text
pedido
propietario
cliente
clienteNombre
estado
tipo
fecha
fecha_fin
fechaCreacion
fechaCreacion_fin
fechaCerrado
fechaCerrado_fin
expedicion
deliveryNumber
transportista
pedidoCliente
observaciones
agrupacion
prioridad
ruta
referencia
poblacion
pais
provincia
```

Los filtros de texto utilizan:

```text
LIKE
```

y pueden utilizar:

```text
%
```

Ejemplo:

```json
{
  "accion": "SELECT",
  "propietario": "AZA",
  "estado": "TODOS",
  "pedido": "PED-0001%"
}
```

---

# 17. DETALLE DE EXPEDICIÓN

Una consulta de expedición debe permitir obtener:

### Cabecera

```text
p_expCabeceraAza
SELECT_ONE
```

### Datos extra

```text
p_expCabeceraAza
SELECT_INICIO
```

### Líneas

```text
p_expPedidoLineas
SELECT
```

---

# 18. RECEPCIONES — CABECERA

Procedimiento:

```text
p_recCabeceraAza
```

Crear:

```text
idAlbaran = "0"
```

Actualizar:

```text
idAlbaran = "<ID REAL>"
```

Acción:

```text
ACTUALIZAR
```

Parámetros:

```text
accion
idAlbaran
albaran
propietario
codProveedor
fecha
tipoAlbaran
ue
agencia
ubicacionRecepcion
empresa
bloqueo
observaciones
```

Datos extra:

```text
matricula
matRemolque
dni
nombre
apellidos
telefono
observacionesPDA
descarga
```

---

# 19. RECEPCIONES — LÍNEAS

Procedimiento:

```text
p_recAlbaranLineas
```

Acciones:

```text
INSERT
UPDATE
SELECT
```

Parámetros:

```text
accion
idParent
id
referencia
piezasAlbaran
linea
lote
fechaCaducidad
observaciones
cliente
entrega
bloqueo
```

---

# 20. RECEPCIONES — CONSULTA

Procedimiento:

```text
p_recepcionesAza
```

Acción:

```text
SELECT
```

Filtros:

```text
albaran
matricula
proveedor
propietario
cliente
estado
tipo
observaciones
fechaPrevista
fechaPrevista_FIN
fechaRecepcion
fechaRecepcion_FIN
```

---

# 21. DETALLE DE RECEPCIÓN

### Cabecera

```text
p_recCabeceraAza
SELECT_ONE
```

### Datos extra

```text
p_recCabeceraAza
SELECT_INICIO
```

### Líneas

```text
p_recAlbaranLineas
SELECT
```

---

# 22. FECHAS

Todos los procedimientos utilizan:

```text
dd/MM/yyyy
```

Ejemplo:

```text
15/08/2026
```

No convertir automáticamente a otro formato cuando se habla con LUX.

La capa interna de la aplicación puede utilizar objetos Date/DateTime, pero el adaptador hacia LUX debe convertir correctamente a:

```text
dd/MM/yyyy
```

Crear un módulo centralizado:

```text
date formatter
```

para evitar conversiones inconsistentes.

---

# 23. DATOS EXTRA — REGLA CRÍTICA

Existe una diferencia fundamental:

### Clave no enviada

```text
no modificar
```

### Clave enviada con ""

```text
borrar valor
```

### Clave enviada con valor

```text
establecer valor
```

Ejemplo:

Si actualmente:

```text
matricula = "1234ABC"
```

y queremos conservarla:

```json
{
  "accion": "ACTUALIZAR",
  "idAlbaran": "3012"
}
```

No enviar:

```json
{
  "matricula": ""
}
```

porque eso significa:

```text
BORRAR
```

Esta regla debe estar documentada y cubierta por tests.

---

# 24. UPSERT

Para cabeceras:

```text
id = 0
```

significa:

```text
CREAR
```

Mientras:

```text
id = ID_REAL
```

significa:

```text
ACTUALIZAR
```

La aplicación debe proporcionar funciones claramente separadas conceptualmente:

```text
createExpedition()
updateExpedition()
createReception()
updateReception()
```

aunque internamente utilicen:

```text
ACTUALIZAR
```

---

# 25. RESPUESTAS

La API devuelve:

```json
[
  {
    "mensaje": "OK",
    "idPedido": "1234"
  }
]
```

o errores como:

```json
[
  {
    "mensaje": "ERR_TRANSPORTISTA_NOT_EXISTS",
    "campo": "TRANSPORTISTA",
    "tab": "GENERAL"
  }
]
```

Siempre analizar:

```text
mensaje
```

Regla:

```text
mensaje === "OK"
```

=> éxito.

Cualquier otro valor:

=> error funcional.

---

# 26. CAPA DE CLIENTE

Crear una capa específica para hablar con LUX.

Por ejemplo:

```text
LuxClient
```

Responsabilidades:

* autenticación
* refresh token
* headers
* llamadas HTTP
* timeout
* retry controlado
* serialización
* deserialización
* errores HTTP
* errores funcionales LUX
* logging
* trazabilidad

NO mezclar esta lógica con la lógica de negocio de AZA.

---

# 27. CAPA DE SERVICIOS

Crear servicios de alto nivel.

Por ejemplo:

```text
ExpedicionesService
RecepcionesService
CatalogosService
```

### ExpedicionesService

Debe proporcionar conceptualmente:

```text
crearExpedicion()
actualizarExpedicion()
crearLineaExpedicion()
actualizarLineaExpedicion()
listarExpediciones()
obtenerExpedicion()
obtenerLineasExpedicion()
obtenerDatosExtraExpedicion()
```

### RecepcionesService

```text
crearRecepcion()
actualizarRecepcion()
crearLineaRecepcion()
actualizarLineaRecepcion()
listarRecepciones()
obtenerRecepcion()
obtenerLineasRecepcion()
obtenerDatosExtraRecepcion()
```

### CatalogosService

Gestionar:

```text
transportistas
service levels
propietarios
tipos
estados
cargas
descargas
```

según los procedimientos disponibles.

---

# 28. VALIDACIÓN

Antes de enviar una petición:

Validar como mínimo:

* procedimiento permitido
* acción válida
* campos obligatorios
* formato de fechas
* tipos de datos
* ID válido
* almacén configurado
* autenticación disponible

No duplicar innecesariamente las reglas de negocio que ya realiza Whales.

La API LUX realiza las validaciones de negocio.

Nuestra aplicación debe validar errores básicos de entrada y delegar las reglas de negocio a LUX.

---

# 29. FLUJO DE CREACIÓN DE EXPEDICIÓN

Implementar el flujo:

```text
1. Crear cabecera
        |
        v
2. Recibir idPedido
        |
        v
3. Crear líneas
        |
        v
4. Comprobar respuestas
        |
        v
5. Devolver resultado completo
```

Nunca crear líneas si la cabecera ha fallado.

---

# 30. FLUJO DE CREACIÓN DE RECEPCIÓN

```text
1. Crear cabecera
        |
        v
2. Recibir idAlbaran
        |
        v
3. Crear líneas
        |
        v
4. Comprobar respuestas
        |
        v
5. Devolver resultado
```

---

# 31. TRANSACCIONES Y CONSISTENCIA

IMPORTANTE:

La documentación indica que cada llamada a `/proc` ejecuta un procedimiento almacenado.

No asumir que varias llamadas REST forman una única transacción SQL.

Por tanto:

```text
Crear cabecera
+
Crear 5 líneas
```

puede producir un estado parcial si la línea 4 falla.

Implementar una estrategia clara de:

* detección de fallo
* logging
* identificación del pedido/albarán
* reintento seguro cuando sea posible
* reporte de líneas procesadas
* reporte de líneas fallidas

No realizar reintentos automáticos indiscriminados sobre operaciones de escritura.

Especialmente:

```text
ACTUALIZAR
INSERT
```

pueden tener efectos en base de datos.

---

# 32. IDEMPOTENCIA

Estudiar la posibilidad de hacer operaciones idempotentes.

Especialmente:

```text
crear expedición
crear recepción
crear línea
```

No inventar un mecanismo de idempotencia que LUX no soporte.

Si la API de LUX no proporciona un `idempotency-key`, documentar claramente cómo evitar duplicados utilizando los identificadores disponibles.

---

# 33. LOGGING

Implementar logs estructurados.

Registrar:

```text
timestamp
operación
procedimiento
acción
almacén
resultado
duración
HTTP status
mensaje LUX
identificador de pedido/albarán
```

Nunca registrar:

```text
password
JWT
refreshToken
Authorization header
secretos
```

---

# 34. CORRELATION ID

Si el proyecto lo permite, implementar:

```text
correlationId
```

por petición.

Esto permitirá rastrear:

```text
AZA
 -> API
 -> LUX
 -> SQL
```

sin necesidad de registrar información sensible.

---

# 35. ERRORES

Diferenciar:

## Error de red

Ejemplo:

```text
timeout
connection refused
DNS
```

## Error HTTP

```text
401
403
404
500
```

## Error de autenticación

```text
token expirado
credenciales incorrectas
refresh inválido
```

## Error funcional Whales

```text
ERR_TRANSPORTISTA_NOT_EXISTS
```

## Error de validación AZA

Datos enviados incorrectamente antes de llamar a LUX.

---

# 36. RETRIES

Implementar retries únicamente para errores potencialmente transitorios:

```text
timeout
connection reset
5xx
```

No hacer retry automático indiscriminado de:

```text
400
401
403
404
errores funcionales
```

Para operaciones de escritura, analizar cuidadosamente el riesgo de duplicación antes de reintentar.

---

# 37. CONFIGURACIÓN

Toda configuración externa debe estar en variables de entorno.

Como mínimo estudiar:

```text
LUX_BASE_URL
LUX_USERNAME
LUX_PASSWORD
LUX_WAREHOUSE
LUX_TIMEOUT
LUX_REFRESH_MARGIN
LOG_LEVEL
```

Los nombres definitivos pueden adaptarse al proyecto.

Crear:

```text
.env.example
```

Nunca introducir credenciales reales.

---

# 38. ESTRUCTURA RECOMENDADA

Adapta esta estructura al lenguaje/framework real detectado:

```text
src/
├── config/
├── auth/
├── lux/
│   ├── client/
│   ├── models/
│   ├── procedures/
│   ├── errors/
│   └── utils/
├── services/
│   ├── expediciones/
│   ├── recepciones/
│   └── catalogos/
├── validation/
├── logging/
├── controllers/
└── utils/

tests/
├── auth/
├── lux/
├── expediciones/
├── recepciones/
└── integration/

docs/
├── architecture.md
├── expediciones.md
├── recepciones.md
├── authentication.md
└── troubleshooting.md
```

No fuerces esta estructura si el proyecto existente utiliza otra arquitectura razonable.

---

# 39. MODELOS

Crear modelos/DTOs para:

```text
LoginRequest
LoginResponse
RefreshTokenRequest
ProcRequest
ProcResponse
Expedicion
ExpedicionLinea
Recepcion
RecepcionLinea
LuxError
```

No asumir que todos los campos devueltos por LUX tienen tipos distintos de string.

La documentación indica que los parámetros de `/proc` son strings.

La capa de dominio puede convertirlos a tipos apropiados cuando tenga sentido.

---

# 40. CATÁLOGOS

Los campos SELECT pueden obtener sus valores mediante acciones del procedimiento.

Ejemplos:

```text
SELECT_CARGAS
SELECT_SERVICE_LEVEL
SELECT_DESCARGAS
select_transportistas
pedido_estado
pedido_tipos
```

Implementar una forma limpia de consultar estos catálogos.

Considerar caché cuando sea apropiado, pero:

> No cachear indefinidamente información que pueda cambiar en Whales.

---

# 41. TESTS UNITARIOS

Crear tests para:

### Autenticación

* login correcto
* login incorrecto
* token expirado
* refresh correcto
* refresh fallido

### /proc

* procedimiento válido
* procedimiento inválido
* body vacío
* headers correctos
* transformación de parámetros

### Fechas

* conversión correcta a dd/MM/yyyy
* fecha inválida
* fecha vacía

### Datos extra

Comprobar:

```text
no enviado -> no tocar
"" -> borrar
valor -> establecer
```

### Expediciones

* crear cabecera
* actualizar cabecera
* crear línea
* actualizar línea
* listar
* detalle

### Recepciones

* crear cabecera
* actualizar cabecera
* crear línea
* actualizar línea
* listar
* detalle

---

# 42. TESTS DE INTEGRACIÓN

Si se dispone de un entorno LUX de pruebas:

Implementar tests contra el entorno real.

Nunca ejecutar tests destructivos contra producción.

Crear configuración separada:

```text
test
staging
production
```

---

# 43. MOCK DE LUX

Crear mocks para poder probar el proyecto sin conexión real al SGA.

Debe poder simular:

```text
200
400
401
403
404
500
timeout
ERR_*
mensaje = OK
```

Esto permitirá desarrollar sin depender constantemente de Whales.

---

# 44. DOCUMENTACIÓN

Crear documentación clara para desarrolladores de AZA.

Debe explicar:

```text
arquitectura
configuración
autenticación
refresh token
/ proc
expediciones
recepciones
errores
logs
tests
despliegue
troubleshooting
```

Incluir ejemplos reales basados exclusivamente en la documentación proporcionada.

---

# 45. SWAGGER / OPENAPI

Si el framework lo permite:

Generar documentación OpenAPI/Swagger.

Documentar los endpoints propios de la aplicación.

No documentar endpoints inexistentes.

---

# 46. HEALTH CHECK

Si el proyecto va a ejecutarse como servicio:

Implementar un endpoint de health check.

Separar conceptualmente:

```text
liveness
readiness
```

No realizar necesariamente login contra LUX en cada health check.

---

# 47. DOCKER

Si el proyecto está destinado a desplegarse como servicio:

Crear:

```text
Dockerfile
docker-compose.yml
```

si es apropiado para la arquitectura detectada.

No introducir Docker si el proyecto existente tiene otro sistema de despliegue claramente definido.

---

# 48. CI/CD

Si existe GitHub Actions u otro sistema CI/CD:

Integrarlo.

Como mínimo:

```text
lint
tests
build
```

No desplegar automáticamente a producción sin comprobar primero la infraestructura existente.

---

# 49. VARIABLES Y SECRETOS

Revisar:

```text
.gitignore
```

Debe excluir:

```text
.env
.env.*
!.env.example
```

adaptándolo a las convenciones del proyecto.

Buscar accidentalmente:

```text
password=
token=
Bearer
JWT
secret
api_key
```

y comprobar que no haya credenciales reales en Git.

---

# 50. COMPATIBILIDAD CON EL CÓDIGO ACTUAL DE AZA

Hay que revisar especialmente si existe código que actualmente consulta Whales.

El proyecto de AZA ya ha trabajado con integraciones Whales y puede existir código que:

* consulta pedidos
* normaliza pedidos
* almacena pedidos
* actualiza MySQL
* utiliza `idExterno`
* utiliza `deliveryOrder`
* realiza polling

No eliminar estas funcionalidades sin comprobar primero si forman parte de otra integración.

Si existe una integración anterior:

```text
Whales -> AZA
```

determinar si:

1. puede reutilizarse;
2. debe adaptarse;
3. debe coexistir;
4. debe migrarse progresivamente.

Documentar la decisión.

---

# 51. MIGRACIÓN

Si existe una integración anterior:

Diseñar una migración progresiva.

Por ejemplo:

```text
FASE 1
API LUX nueva
        |
        v
tests

FASE 2
API LUX
        |
        v
entorno staging

FASE 3
API LUX + sistema actual

FASE 4
producción

FASE 5
retirada de integración antigua
```

No eliminar código antiguo hasta confirmar que no se utiliza.

---

# 52. AGENTES

Utiliza agentes especializados cuando Claude Code Pro lo permita.

Divide el trabajo conceptualmente en:

## Agente 1 — Auditoría

Analiza:

* repositorio
* arquitectura
* dependencias
* código existente
* configuración

## Agente 2 — Documentación

Analiza:

* API LUX
* procedimientos
* parámetros
* acciones
* reglas

## Agente 3 — Arquitectura

Diseña:

* capas
* módulos
* modelos
* errores
* autenticación

## Agente 4 — Implementación

Construye el código.

## Agente 5 — Tests

Crea tests unitarios e integración.

## Agente 6 — Seguridad

Audita:

* secretos
* autenticación
* autorización
* logs
* inputs
* SSRF
* inyección
* configuración

## Agente 7 — Code Review

Revisa el resultado completo.

---

# 53. SKILLS

Utiliza las skills disponibles para:

* backend
* API REST
* SQL
* testing
* seguridad
* Docker
* documentación
* revisión de código

si están disponibles.

No utilizar una skill simplemente por utilizarla.

Debe aportar valor real.

---

# 54. PLAN DE EJECUCIÓN

Trabaja en este orden:

## FASE 0 — INVENTARIO

No modificar código.

Analizar completamente el proyecto.

Resultado:

```text
docs/audit.md
```

Debe explicar:

* estructura
* tecnología
* dependencias
* puntos de integración
* riesgos
* código reutilizable
* código obsoleto

---

## FASE 1 — ANÁLISIS DE LUX

Crear:

```text
docs/lux-api-analysis.md
```

Debe contener:

* autenticación
* endpoints
* procedimientos
* acciones
* parámetros
* respuestas
* errores
* flujos

---

## FASE 2 — ARQUITECTURA

Crear:

```text
docs/architecture.md
```

Explicar:

```text
AZA
 |
LuxClient
 |
Auth
 |
/proc
 |
Whales
```

---

## FASE 3 — IMPLEMENTACIÓN BASE

Implementar:

* configuración
* autenticación
* refresh
* LuxClient
* errores
* logging
* configuración

---

## FASE 4 — EXPEDICIONES

Implementar completamente:

```text
cabecera
líneas
consulta
detalle
catálogos
```

---

## FASE 5 — RECEPCIONES

Implementar:

```text
cabecera
líneas
consulta
detalle
catálogos
```

---

## FASE 6 — TESTS

Implementar:

```text
unit tests
integration tests
mocks
```

---

## FASE 7 — SEGURIDAD

Realizar auditoría.

---

## FASE 8 — CODE REVIEW

Revisar todo el proyecto.

Buscar:

* bugs
* duplicación
* malas prácticas
* errores de tipos
* errores de autenticación
* errores de refresh
* errores de fechas
* errores de datos extra
* retries peligrosos
* secretos

---

## FASE 9 — DOCUMENTACIÓN

Actualizar:

```text
README.md
docs/
.env.example
```

---

# 55. DEFINITION OF DONE

No considerar el proyecto terminado hasta que:

* [ ] Se ha inspeccionado el proyecto existente.
* [ ] Se ha analizado la documentación LUX.
* [ ] Se ha documentado la arquitectura.
* [ ] Login implementado.
* [ ] Refresh token implementado.
* [ ] Headers implementados.
* [ ] `/proc` implementado.
* [ ] Whitelist de procedimientos.
* [ ] Manejo de errores.
* [ ] Logging.
* [ ] Expediciones implementadas.
* [ ] Líneas de expediciones implementadas.
* [ ] Consultas de expediciones implementadas.
* [ ] Detalle de expediciones implementado.
* [ ] Recepciones implementadas.
* [ ] Líneas de recepciones implementadas.
* [ ] Consultas de recepciones implementadas.
* [ ] Detalle de recepciones implementado.
* [ ] Catálogos implementados.
* [ ] Conversión de fechas implementada.
* [ ] Semántica null/""/valor protegida.
* [ ] Tests unitarios.
* [ ] Tests de integración/mock.
* [ ] Auditoría de seguridad.
* [ ] README.
* [ ] `.env.example`.
* [ ] `.gitignore` revisado.
* [ ] Proyecto ejecutable.
* [ ] Build correcto.
* [ ] Tests correctos.

---

# 56. REGLA PARA INFORMAR DEL PROGRESO

Después de cada fase, actualizar:

```text
docs/progress.md
```

Usar:

```text
COMPLETADO
EN PROGRESO
BLOQUEADO
TODO
```

Para cualquier bloqueo:

```text
BLOQUEADO:
Qué falta:
Por qué falta:
Qué información se necesita:
Qué partes pueden continuar:
```

No detener todo el proyecto por una información que solo afecte a una parte.

---

# 57. REGLA CONTRA SUPOSICIONES

Si encuentras algo ambiguo:

NO hagas:

```text
probablemente será X
```

Haz:

```text
TODO: confirmar comportamiento X.
```

y continúa con aquello que sí esté definido.

---

# 58. INFORME FINAL

Al terminar debes mostrar un resumen:

```text
========================================
API LUX AZA — IMPLEMENTACIÓN COMPLETADA
========================================

Tecnología:
Arquitectura:
Estado:

Autenticación:
    OK / TODO

Expediciones:
    OK / TODO

Recepciones:
    OK / TODO

Tests:
    X passed
    X failed

Seguridad:
    OK / TODO

Documentación:
    OK / TODO

Bloqueos:
    ...

Archivos principales:
    ...

Cómo ejecutar:
    ...

Cómo ejecutar tests:
    ...

Variables necesarias:
    ...
```

---

# 59. MUY IMPORTANTE — NO PEDIR CONFIRMACIÓN CONSTANTEMENTE

Trabaja de forma autónoma.

No preguntes al usuario cosas que puedan determinarse inspeccionando:

* código
* documentación
* configuración
* dependencias
* estructura del proyecto

Solo pide intervención humana cuando realmente sea necesaria, por ejemplo:

* credenciales reales
* URL de producción
* decisión de negocio no documentada
* acceso a infraestructura externa
* comportamiento contradictorio de la documentación

Mientras tanto:

```text
continúa implementando todo lo demás.
```

---

# 60. PRIMERA ACCIÓN

Empieza ahora.

NO escribas código todavía.

Primero:

```text
1. Inspecciona todo el proyecto.
2. Identifica la tecnología.
3. Identifica el código existente relacionado con Whales.
4. Localiza documentación.
5. Analiza dependencias.
6. Analiza configuración.
7. Comprueba si existe una API previa.
8. Genera docs/audit.md.
9. Genera docs/lux-api-analysis.md.
10. Genera docs/architecture.md.
```

Después de completar la auditoría:

```text
IMPLEMENTA EL PROYECTO.
```

No te limites a generar ejemplos.

Modifica/crea los archivos necesarios dentro del proyecto.

Al finalizar ejecuta los tests y corrige todos los errores que puedas detectar.

---

# 61. CONTEXTO DE NEGOCIO AZA

AZA Logistics utiliza Whales como SGA.

La integración tiene especial importancia para:

```text
PEDIDOS DE SALIDA
RECEPCIONES
TRANSPORTISTAS
CLIENTES
PROPIETARIOS
ALMACENES
LÍNEAS
DATOS EXTRA
```

La integración debe ser robusta porque puede formar parte de procesos operativos de almacén.

Prioridades:

```text
1. CORRECCIÓN
2. SEGURIDAD
3. TRAZABILIDAD
4. FIABILIDAD
5. MANTENIBILIDAD
6. RENDIMIENTO
```

No sacrificar corrección por implementar rápidamente.

---

# 62. REGLA FINAL

El objetivo no es crear una demo.

El objetivo es crear una **integración profesional de AZA con API LUX / Whales**, preparada para evolucionar y ser mantenida por el equipo técnico de AZA.

Antes de terminar pregúntate internamente:

> "¿Podría otro desarrollador de AZA clonar este proyecto, configurar sus variables de entorno, ejecutar los tests, entender la arquitectura y empezar a utilizar la integración sin depender del proveedor?"

Si la respuesta es NO:

```text
continúa trabajando.
```
