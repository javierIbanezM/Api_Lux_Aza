# FASE 0 — Auditoría del proyecto

Fecha: 2026-09-07

## Estado del directorio `C:\API.WHALES` antes de empezar

Contenido encontrado:

```text
C:\API.WHALES\
├── GuiaAPILUX_AZA (1).pdf        (documentación oficial del proveedor)
└── IMPLEMENTACION_API_LUX_AZA.md (instrucciones de esta tarea)
```

No hay:

* código fuente de ningún lenguaje.
* `package.json`, `pom.xml`, `requirements.txt`, `.csproj` ni ningún manifiesto de dependencias.
* control de versiones (`git init` no ejecutado; no es un repositorio git).
* `README`, `.env`, `.env.example`, `.gitignore`.
* ninguna referencia a Whales, LUX, SQL Server, MySQL, pedidos, expediciones, recepciones,
  clientes, transportistas o almacenes en forma de código.

Por instrucción explícita del usuario, **no se ha inspeccionado ningún otro directorio** fuera de
`C:\API.WHALES`. Todo el análisis se basa exclusivamente en:

1. `IMPLEMENTACION_API_LUX_AZA.md` — reglas de ejecución de esta tarea.
2. `GuiaAPILUX_AZA (1).pdf` — documentación funcional/técnica de la API Lux proporcionada por el
   proveedor de Whales.

## Conclusión de la Fase 0

No existe ningún proyecto ni integración previa que auditar, reutilizar o migrar dentro de este
directorio. Se trata de una implementación **greenfield** (desde cero).

Por tanto:

* Las secciones del documento de instrucciones relativas a "no destruir código existente",
  "reutilizar integración anterior" y el plan de migración por fases (§50-51 del documento de
  instrucciones) **no aplican** — se documentan como `TODO — NO APLICA (no existe integración
  previa en este directorio)`.
* Se decide libremente la tecnología a emplear, ya que no hay ningún stack previo que condicione
  la decisión.

## Decisión de stack tecnológico

No hay ningún framework o lenguaje impuesto por el proyecto existente (no existe proyecto
existente). Se elige:

* **Node.js 20+ con TypeScript** — tipado estático para los DTOs de LUX (Login, ProcRequest,
  ProcResponse, Expedicion, Recepcion, etc.), buen soporte de Express para exponer una API REST
  propia de AZA si se decide envolver la integración detrás de endpoints propios, y ecosistema
  maduro para HTTP client (axios), validación (zod) y testing (vitest).
* **Express** como framework HTTP mínimo, únicamente para exponer health checks y, si se desea,
  una capa de fachada propia de AZA sobre los servicios (`ExpedicionesService`,
  `RecepcionesService`, `CatalogosService`). La integración con LUX en sí se modela como una
  librería interna (`src/lux/`), no como servidor obligatorio: puede consumirse también desde un
  script, un worker o un futuro backend de AZA.
* **Vitest** para tests unitarios y de integración (rápido, nativo TS, sin configuración pesada).
* **Axios** como cliente HTTP hacia LUX (soporta interceptores, útil para inyectar
  `Authorization`/`Almacen` y para el mecanismo de refresh de token).

Justificación: es un stack estándar, ampliamente soportado por los agentes especializados
disponibles (`node-backend`), fácil de desplegar (Docker/PM2) y idiomático para una capa de
integración HTTP→HTTP como la descrita en la documentación (AZA → API LUX → SQL Server).

## Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| La documentación no cubre el 100% de los parámetros de cada procedimiento (solo "parámetros principales") | Se implementa solo lo documentado; cualquier parámetro no confirmado se marca `TODO — INFORMACIÓN NO DEFINIDA EN LA DOCUMENTACIÓN` |
| No hay entorno real de LUX disponible para probar | Se construye un mock HTTP completo (`tests/mocks`) que simula `/login`, `/login/refreshToken` y `/proc/{procedimiento}` |
| Semántica `null` (no tocar) vs `""` (borrar) es fácil de romper accidentalmente | Se centraliza en un único helper (`buildProcBody`) con tests dedicados |
| Reintentos automáticos sobre operaciones de escritura (`INSERT`/`ACTUALIZAR`) pueden duplicar datos | Los retries del `LuxClient` solo se aplican a errores de red/5xx y **nunca** a la petición ya enviada si la respuesta llegó a producirse; se documenta explícitamente en `docs/troubleshooting.md` |
| Credenciales en el repositorio | `.env` en `.gitignore`, solo se distribuye `.env.example` sin valores reales |

## Código reutilizable / obsoleto

No aplica (no existe código previo en este directorio).
