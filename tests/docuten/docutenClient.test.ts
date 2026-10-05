import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DocutenClient, DocutenTransientError, extensionDe, extraerDocumentos, nombreDeContentDisposition } from '../../src/docuten';

describe('docuten/DocutenClient', () => {
  let server: Server;
  let base: string;
  let peticiones: Array<{ url: string; apiKey: string | undefined }>;
  let manejador: (req: IncomingMessage, res: ServerResponse) => void;

  beforeEach(async () => {
    peticiones = [];
    manejador = (_req, res) => {
      res.statusCode = 200;
      res.end('x');
    };
    server = createServer((req, res) => {
      peticiones.push({ url: req.url ?? '', apiKey: req.headers['x-api-key'] as string | undefined });
      manejador(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('hace las 2 llamadas (include=all y simple) con X-API-KEY y el shipmentId en la URL, y devuelve los ficheros', async () => {
    manejador = (req, res) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="carta-porte.pdf"');
      res.end(req.url?.includes('include=all') ? 'TODO' : 'UNO');
    };
    const cliente = new DocutenClient(base, 'mi-clave');
    const r = await cliente.descargarDocumentos('356d6b5c-9d15-4677-8fcc-2b83e1ace474');

    expect(peticiones).toEqual([
      { url: '/api/v1/shipments/356d6b5c-9d15-4677-8fcc-2b83e1ace474/documents/download?include=all', apiKey: 'mi-clave' },
      { url: '/api/v1/shipments/356d6b5c-9d15-4677-8fcc-2b83e1ace474/documents/download', apiKey: 'mi-clave' },
    ]);
    expect(r.map((d) => [d.variante, d.status, d.ok, d.extension, d.datos?.toString()])).toEqual([
      ['include-all', 200, true, 'pdf', 'TODO'],
      ['simple', 200, true, 'pdf', 'UNO'],
    ]);
    expect(r[0]?.nombreSugerido).toBe('carta-porte.pdf');
  });

  it('si la respuesta es el JSON de Docuten (documents[] con content en base64) devuelve los documentos YA decodificados', async () => {
    const pdf = Buffer.from('%PDF-1.4 contenido de prueba');
    manejador = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        documents: [{ file_name: 'Porte ruta RT1_2026_X -AZA.pdf', content: pdf.toString('base64'), document_type: 'transport_control_document' }],
      }));
    };
    const [primera] = await new DocutenClient(base, 'k').descargarDocumentos('S1');
    expect(primera?.ok).toBe(true);
    expect(primera?.datos).toBeUndefined(); // no se guarda el JSON bruto
    expect(primera?.documentos).toHaveLength(1);
    expect(primera?.documentos?.[0]).toMatchObject({ fileName: 'Porte ruta RT1_2026_X -AZA.pdf', documentType: 'transport_control_document', bytes: pdf.length });
    expect(primera?.documentos?.[0]?.datos.equals(pdf)).toBe(true);
  });

  it('extraerDocumentos ignora lo que no es el JSON documents[] (se guarda el contenido crudo)', () => {
    expect(extraerDocumentos(Buffer.from('%PDF-1.4'), 'application/pdf')).toBeUndefined();
    expect(extraerDocumentos(Buffer.from('{"otra":1}'), 'application/json')).toBeUndefined();
    expect(extraerDocumentos(Buffer.from('{no es json'), 'application/json')).toBeUndefined();
  });

  it('un 401/404 NO es transitorio: se devuelve como descarga no ok con el motivo, sin lanzar', async () => {
    manejador = (_req, res) => {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"error_code":"UNAUTHORIZED","error_message":"Authentication required"}');
    };
    const r = await new DocutenClient(base, 'mala').descargarDocumentos('S1');
    expect(r.every((d) => !d.ok && d.status === 401 && d.datos === undefined)).toBe(true);
    expect(r[0]?.error).toContain('UNAUTHORIZED');
  });

  it('un 5xx o un fallo de red SI es transitorio (se reintenta)', async () => {
    manejador = (_req, res) => {
      res.statusCode = 503;
      res.end('caido');
    };
    await expect(new DocutenClient(base, 'k').descargarDocumentos('S1')).rejects.toBeInstanceOf(DocutenTransientError);
    await expect(new DocutenClient('http://127.0.0.1:1/api/v1', 'k', 1000).descargarDocumentos('S1')).rejects.toBeInstanceOf(DocutenTransientError);
  });

  it('sigue redirecciones a mano y NO reenvia la clave a otro host', async () => {
    const otro = createServer((req, res) => {
      peticiones.push({ url: `OTRO${req.url}`, apiKey: req.headers['x-api-key'] as string | undefined });
      res.setHeader('Content-Type', 'application/zip');
      res.end('ZIP');
    });
    await new Promise<void>((resolve) => otro.listen(0, '127.0.0.2', resolve));
    const puertoOtro = (otro.address() as AddressInfo).port;
    manejador = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `http://127.0.0.2:${puertoOtro}/firmada?sig=abc`);
      res.end();
    };
    try {
      const r = await new DocutenClient(base, 'secreta').descargarDocumentos('S1');
      expect(r[0]).toMatchObject({ ok: true, extension: 'zip', status: 200 });
      const aOtroHost = peticiones.filter((p) => p.url.startsWith('OTRO'));
      expect(aOtroHost.length).toBeGreaterThan(0);
      expect(aOtroHost.every((p) => p.apiKey === undefined)).toBe(true); // la clave no sale del host original
    } finally {
      await new Promise<void>((resolve) => otro.close(() => resolve()));
    }
  });

  it('extension y nombre: del Content-Disposition si lo hay; si no, del Content-Type; si no, bin', () => {
    expect(nombreDeContentDisposition(`attachment; filename*=UTF-8''doc%20final.pdf`)).toBe('doc final.pdf');
    expect(extensionDe('docs.ZIP', 'application/pdf')).toBe('zip');
    expect(extensionDe(undefined, 'application/pdf; charset=binary')).toBe('pdf');
    expect(extensionDe(undefined, 'application/octet-stream')).toBe('bin');
  });
});
