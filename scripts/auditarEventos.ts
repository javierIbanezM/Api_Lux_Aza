/**
 * Auditoria de eventos del watcher: comprueba que NINGUN evento de la whitelist (pedidos y albaranes)
 * detectado en los logs de LUX ha quedado sin su JSON en `watcher-events`.
 *
 * Lee TODOS los ficheros de log (lux.log.N de LUX y LUX_mobile), detecta los eventos con los mismos
 * patrones que el watcher (actionPatterns.ts) y, por cada pedido/albaran afectado, mira si existe un
 * JSON en `watcher-events` (por id o por numero de pedido/albaran) generado DESPUES del ultimo evento
 * (con tolerancia de reloj). Es de solo lectura.
 *
 * Uso:
 *   npx tsx scripts/auditarEventos.ts [--desde=2026-10-05T14:00] [--events=data/watcher-events]
 *                                     [--logs=T:/TLSI/LUX,T:/TLSI/LUX_mobile] [--reparar]
 *   --reparar: vuelve a consultar en LUX y a generar el JSON de los pedidos/albaranes que se quedaron SIN JSON
 *              (usa las mismas variables .env que el watcher: LUX_*, WATCHER_JSON_DIR...). Sin esta opcion es solo lectura.
 * Por defecto: los directorios de LUX_LOG_PATH / LUX_MOBILE_LOG_PATH del .env, la carpeta
 * WATCHER_JSON_DIR y los ultimos 2 dias.
 */
import 'dotenv/config';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logging';
import { buildDependencies } from '../src/app';
import { LuxActionWatcher } from '../src/watcher/luxActionWatcher';
import { createJsonFileSink } from '../src/watcher/jsonFileSink';
import { loadWatcherConfig } from '../src/watcher/watcherConfig';
import { matchActionLine } from '../src/watcher/actionPatterns';
import { parseLogTime } from '../src/watcher/logTime';

const TOLERANCIA_RELOJ_MS = 120_000;
/** Un evento muy reciente puede estar todavia en el debounce / en cola. */
const MARGEN_RECIENTE_MS = 5 * 60_000;
const IGNORADOS = new Set(['rutaEnviada', 'rutaConsultada', 'decaGenerada']); // estos van a watcher-rutas-deca

function arg(nombre: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${nombre}=`))?.slice(nombre.length + 3);
}

/** `2026-10-06T18-10-26-630--...json` (hora local) -> ms. */
function tiempoDeNombre(nombre: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?--/.exec(nombre);
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +(m[7] ?? 0)).getTime() : undefined;
}

interface Objetivo {
  dominio: 'expedicion' | 'recepcion';
  ids: Set<string>;
  textos: Set<string>;
  ultimo: number;
  eventos: number;
  tipos: Set<string>;
  almacen?: string;
}

async function main(): Promise<void> {
  const desde = arg('desde') ? new Date(arg('desde') as string).getTime() : Date.now() - 2 * 24 * 3600_000;
  const eventsDir = arg('events') ?? process.env.WATCHER_JSON_DIR ?? 'data/watcher-events';
  const dirsLogs = (arg('logs')?.split(',') ?? [dirname(process.env.LUX_LOG_PATH ?? ''), dirname(process.env.LUX_MOBILE_LOG_PATH ?? '')]).filter(Boolean);

  // 1) Indice de JSON existentes: id/texto -> hora del JSON mas reciente
  const jsonPorClave = new Map<string, number>();
  const anotar = (clave: string | undefined, t: number): void => {
    if (clave && clave !== '0' && (jsonPorClave.get(clave) ?? 0) < t) {
      jsonPorClave.set(clave, t);
    }
  };
  let jsonLeidos = 0;
  /** ids cuyo JSON lleva la fila del listado de OTRO pedido/albaran (mismo numero, distinto propietario). */
  const jsonIncorrectos = new Set<string>();
  for (const f of readdirSync(eventsDir)) {
    const t = tiempoDeNombre(f);
    if (t === undefined || !/--(expedicion|recepcion)-/.test(f)) {
      continue;
    }
    try {
      const d = JSON.parse(readFileSync(join(eventsDir, f), 'utf-8')) as Record<string, string | undefined> & { listado?: { id?: string } };
      jsonLeidos += 1;
      const id = d.idPedido ?? d.idAlbaran;
      anotar(`id:${id}`, t);
      anotar(`txt:${(d.pedido ?? d.albaran ?? '').toUpperCase()}`, t);
      if (id && d.listado?.id && String(d.listado.id) !== String(id)) {
        jsonIncorrectos.add(String(id));
      }
    } catch {
      // JSON ilegible: se ignora
    }
  }

  // 2) Eventos de los logs
  const objetivos = new Map<string, Objetivo>();
  let lineasEvento = 0;
  let ficheros = 0;
  for (const dir of dirsLogs) {
    let nombres: string[] = [];
    try {
      nombres = readdirSync(dir).filter((n) => /^lux(_mobile)?\.log\.\d+(\.\d+)?$/.test(n));
    } catch {
      console.log(`(no se puede leer ${dir})`);
      continue;
    }
    for (const nombre of nombres) {
      ficheros += 1;
      const lector = createInterface({ input: createReadStream(join(dir, nombre), { encoding: 'latin1' }), crlfDelay: Infinity });
      for await (const linea of lector) {
        if (!linea.includes('exec p_')) {
          continue;
        }
        const t = parseLogTime(linea);
        if (t === undefined || t < desde) {
          continue;
        }
        const e = matchActionLine(linea);
        if (!e || IGNORADOS.has(e.type)) {
          continue;
        }
        const dominio = e.type.startsWith('recepcion') ? 'recepcion' : 'expedicion';
        const id = (dominio === 'recepcion' ? e.idAlbaran : e.idPedido) ?? '';
        const texto = ((dominio === 'recepcion' ? e.albaran : e.pedido) ?? '').toUpperCase();
        if ((id === '' || id === '0') && texto === '') {
          continue;
        }
        const clave = `${dominio}:${id !== '' && id !== '0' ? `id:${id}` : `txt:${texto}`}`;
        const o = objetivos.get(clave) ?? { dominio, ids: new Set(), textos: new Set(), ultimo: 0, eventos: 0, tipos: new Set(), almacen: e.almacen };
        if (id !== '' && id !== '0') o.ids.add(id);
        if (texto !== '') o.textos.add(texto);
        o.ultimo = Math.max(o.ultimo, t);
        o.eventos += 1;
        o.tipos.add(e.type);
        objetivos.set(clave, o);
        lineasEvento += 1;
      }
    }
  }

  // 3) Comparacion
  const ahora = Date.now();
  const sinJson: Array<[string, Objetivo]> = [];
  const desactualizados: Array<[string, Objetivo, number]> = [];
  const incorrectos: Array<[string, Objetivo, number]> = [];
  let ok = 0;
  let recientes = 0;
  for (const [clave, o] of objetivos) {
    if (ahora - o.ultimo < MARGEN_RECIENTE_MS) {
      recientes += 1;
      continue;
    }
    // Con id conocido se exige JSON de ESE id (el numero de pedido puede repetirse con otro propietario y
    // un JSON de otro pedido no cuenta); el texto solo vale para eventos sin id (altas).
    const tJson = o.ids.size > 0
      ? Math.max(0, ...[...o.ids].map((i) => jsonPorClave.get(`id:${i}`) ?? 0))
      : Math.max(0, ...[...o.textos].map((x) => jsonPorClave.get(`txt:${x}`) ?? 0));
    if (tJson === 0) {
      sinJson.push([clave, o]);
    } else if ([...o.ids].some((i) => jsonIncorrectos.has(i))) {
      incorrectos.push([clave, o, tJson]);
    } else if (tJson < o.ultimo - TOLERANCIA_RELOJ_MS) {
      desactualizados.push([clave, o, tJson]);
    } else {
      ok += 1;
    }
  }

  const f = (ms: number): string => new Date(ms).toLocaleString('sv-SE').replace(' ', 'T');
  console.log(`Logs leidos: ${ficheros} ficheros | eventos de la whitelist desde ${f(desde)}: ${lineasEvento} lineas sobre ${objetivos.size} pedidos/albaranes distintos`);
  console.log(`JSON en ${basename(eventsDir)}: ${jsonLeidos}`);
  console.log(`  OK (JSON posterior al ultimo evento): ${ok}`);
  console.log(`  muy recientes (<5 min, en cola): ${recientes}`);
  console.log(`  SIN JSON: ${sinJson.length}`);
  console.log(`  JSON mas ANTIGUO que el ultimo evento: ${desactualizados.length}`);
  console.log(`  JSON con el listado de OTRO pedido (mismo numero, otro propietario): ${incorrectos.length}`);
  for (const [clave, o] of sinJson.slice(0, 40)) {
    console.log(`   SIN JSON  ${clave} almacen=${o.almacen ?? '?'} ultimo=${f(o.ultimo)} eventos=${o.eventos} tipos=${[...o.tipos].join(',')}`);
  }
  for (const [clave, o, t] of desactualizados.slice(0, 40)) {
    console.log(`   ANTIGUO   ${clave} almacen=${o.almacen ?? '?'} ultimoEvento=${f(o.ultimo)} jsonMasReciente=${f(t)} tipos=${[...o.tipos].join(',')}`);
  }

  for (const [clave, o, t] of incorrectos.slice(0, 40)) {
    console.log(`   INCORRECTO ${clave} almacen=${o.almacen ?? '?'} json=${f(t)} (lleva el listado de otro pedido con el mismo numero)`);
  }

  if (process.argv.includes('--reparar') && sinJson.length + desactualizados.length + incorrectos.length > 0) {
    const logger = createLogger('error');
    const config = loadConfig();
    const watcherConfig = loadWatcherConfig();
    const deps = buildDependencies(config, logger);
    const sink = createJsonFileSink(watcherConfig.jsonEventsDir, logger, undefined, watcherConfig.rutasDecaDir, { borrarFinales: watcherConfig.borrarJsonFinales });
    const watcher = new LuxActionWatcher(watcherConfig, deps.luxClient, deps.expedicionesService, deps.recepcionesService, logger, sink);
    for (const [clave, o] of [...sinJson, ...desactualizados.map(([c, o]) => [c, o] as [string, Objetivo]), ...incorrectos.map(([c, o]) => [c, o] as [string, Objetivo])]) {
      const id = [...o.ids][0];
      if (!id) {
        console.log(`   (sin id, no se puede reparar: ${clave})`);
        continue;
      }
      try {
        await watcher.reprocesar(o.dominio, id, o.almacen);
        console.log(`   REPARADO  ${clave}`);
      } catch (err) {
        console.log(`   FALLO     ${clave}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await watcher.stop();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
