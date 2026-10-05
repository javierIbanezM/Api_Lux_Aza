import axios, { type AxiosInstance } from 'axios';

/** Las dos llamadas de descarga de documentos de un envio (shipment) de Docuten eCMR. */
export type VarianteDescarga = 'include-all' | 'simple';

/**
 * Un documento recibido de Docuten. La API responde `{"documents":[{file_name, content, document_type}]}`
 * con `content` en base64 (comprobado en produccion el 2026-10-05: un PDF "Porte ruta ...pdf",
 * `document_type: transport_control_document`); aqui ya va decodificado.
 */
export interface DocumentoDocuten {
  fileName: string;
  documentType?: string;
  bytes: number;
  datos: Buffer;
}

/** Resultado de una llamada de descarga. */
export interface DescargaDocumento {
  shipmentId: string;
  variante: VarianteDescarga;
  /** URL llamada (sin credenciales: la clave va en la cabecera X-API-KEY y no se registra). */
  url: string;
  status: number;
  ok: boolean;
  contentType?: string;
  /** Nombre que sugiere Docuten (Content-Disposition), si lo hay. */
  nombreSugerido?: string;
  /** Extension con la que se guarda el fichero (pdf, zip, json, bin...). */
  extension: string;
  bytes: number;
  /** Motivo si no fue ok (cuerpo de la respuesta de error, recortado). */
  error?: string;
  /** Documentos decodificados de la respuesta JSON `documents[]` (lo normal en Docuten). */
  documentos?: DocumentoDocuten[];
  /** Contenido crudo, SOLO si la respuesta no era el JSON `documents[]` (p.ej. un PDF o ZIP directo). */
  datos?: Buffer;
}

/** Extrae y decodifica `documents[]` si la respuesta es el JSON de Docuten; `undefined` si no lo es. */
export function extraerDocumentos(contenido: Buffer, contentType: string | undefined): DocumentoDocuten[] | undefined {
  const pareceJson = /json/i.test(contentType ?? '') || contenido.subarray(0, 1).toString() === '{';
  if (!pareceJson) {
    return undefined;
  }
  try {
    const cuerpo = JSON.parse(contenido.toString('utf-8')) as { documents?: unknown };
    if (!Array.isArray(cuerpo.documents)) {
      return undefined;
    }
    const documentos: DocumentoDocuten[] = [];
    for (const d of cuerpo.documents as Array<Record<string, unknown>>) {
      if (typeof d?.content !== 'string') {
        continue;
      }
      const datos = Buffer.from(d.content, 'base64');
      documentos.push({
        fileName: typeof d.file_name === 'string' ? d.file_name : '',
        documentType: typeof d.document_type === 'string' ? d.document_type : undefined,
        bytes: datos.length,
        datos,
      });
    }
    return documentos;
  } catch {
    return undefined;
  }
}

/** Quien descarga documentos de Docuten (lo implementa DocutenClient; inyectable en tests). */
export interface DocutenDescargador {
  descargarDocumentos(shipmentId: string): Promise<DescargaDocumento[]>;
}

/** Fallo que se resuelve esperando (red caida, 5xx, 429, 408): el evento se reintenta. Un 401/403/404
 *  NO es transitorio: se devuelve como descarga no ok. */
export class DocutenTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocutenTransientError';
  }
}

const EXTENSION_POR_TIPO: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/html': 'html',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const MAX_REDIRECCIONES = 3;
const TIMEOUT_POR_DEFECTO_MS = 30_000;

/** Nombre de fichero de un Content-Disposition (`filename="x.pdf"` o `filename*=UTF-8''x.pdf`). */
export function nombreDeContentDisposition(valor: string | undefined): string | undefined {
  if (!valor) {
    return undefined;
  }
  const extendido = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(valor);
  if (extendido?.[1]) {
    try {
      return decodeURIComponent(extendido[1].trim());
    } catch {
      return extendido[1].trim();
    }
  }
  const simple = /filename\s*=\s*"?([^";]+)"?/i.exec(valor);
  return simple?.[1]?.trim();
}

/** Extension del fichero: la del nombre sugerido si la hay; si no, segun el Content-Type. */
export function extensionDe(nombreSugerido: string | undefined, contentType: string | undefined): string {
  const delNombre = nombreSugerido ? /\.([A-Za-z0-9]{1,8})$/.exec(nombreSugerido)?.[1] : undefined;
  if (delNombre) {
    return delNombre.toLowerCase();
  }
  const tipo = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSION_POR_TIPO[tipo] ?? 'bin';
}

/**
 * Cliente de la API de Docuten eCMR: descarga los documentos de un envio.
 *
 *   GET {base}/shipments/{id}/documents/download?include=all   -> variante 'include-all'
 *   GET {base}/shipments/{id}/documents/download               -> variante 'simple'
 *
 * Autenticacion: cabecera `X-API-KEY`. La clave NUNCA se registra. Las redirecciones se siguen a
 * mano y la clave solo se reenvia al mismo host (una URL firmada de otro host no debe recibirla).
 */
export class DocutenClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number = TIMEOUT_POR_DEFECTO_MS,
    private readonly http: AxiosInstance = axios.create(),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Las dos descargas (include=all y simple) de un envio. */
  async descargarDocumentos(shipmentId: string): Promise<DescargaDocumento[]> {
    const resultados: DescargaDocumento[] = [];
    for (const variante of ['include-all', 'simple'] as const) {
      resultados.push(await this.descargar(shipmentId, variante));
    }
    return resultados;
  }

  private urlDe(shipmentId: string, variante: VarianteDescarga): string {
    const base = `${this.baseUrl}/shipments/${encodeURIComponent(shipmentId)}/documents/download`;
    return variante === 'include-all' ? `${base}?include=all` : base;
  }

  private async descargar(shipmentId: string, variante: VarianteDescarga): Promise<DescargaDocumento> {
    const urlInicial = this.urlDe(shipmentId, variante);
    let url = urlInicial;
    const hostInicial = new URL(urlInicial).host;

    for (let salto = 0; salto <= MAX_REDIRECCIONES; salto += 1) {
      let respuesta;
      try {
        respuesta = await this.http.get<ArrayBuffer>(url, {
          headers: new URL(url).host === hostInicial ? { 'X-API-KEY': this.apiKey } : {},
          responseType: 'arraybuffer',
          timeout: this.timeoutMs,
          maxRedirects: 0,
          validateStatus: () => true,
        });
      } catch (err) {
        throw new DocutenTransientError(
          `Error de red llamando a Docuten (${variante}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const { status } = respuesta;
      const cabecera = (nombre: string): string | undefined => {
        const valor = respuesta.headers[nombre];
        return Array.isArray(valor) ? valor[0] : (valor as string | undefined);
      };

      if (status >= 300 && status < 400 && cabecera('location')) {
        url = new URL(cabecera('location') as string, url).toString();
        continue;
      }
      if (status >= 500 || status === 429 || status === 408) {
        throw new DocutenTransientError(`Docuten respondio HTTP ${status} (${variante})`);
      }

      const contenido = Buffer.from(respuesta.data);
      const contentType = cabecera('content-type');
      const nombreSugerido = nombreDeContentDisposition(cabecera('content-disposition'));
      const ok = status >= 200 && status < 300;
      const documentos = ok ? extraerDocumentos(contenido, contentType) : undefined;
      return {
        shipmentId,
        variante,
        url: urlInicial,
        status,
        ok,
        contentType,
        nombreSugerido,
        extension: extensionDe(nombreSugerido, contentType),
        bytes: contenido.length,
        ...(ok
          ? documentos
            ? { documentos } // JSON documents[]: se guardan los documentos decodificados, no el JSON bruto
            : { datos: contenido }
          : { error: contenido.toString('utf-8').slice(0, 300) }),
      };
    }
    throw new DocutenTransientError(`Demasiadas redirecciones llamando a Docuten (${variante})`);
  }
}
