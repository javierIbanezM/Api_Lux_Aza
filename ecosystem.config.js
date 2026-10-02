/**
 * PM2: mantiene vivos los dos procesos del proyecto y los reinicia solos si caen.
 *
 *   api-whales          servidor HTTP (API /api, interfaz /almacen, /docs, /health)
 *   api-whales-watcher  watcher de logs de LUX (genera los JSON de data/watcher-events)
 *
 * Uso (desde la raiz del proyecto, ver README "Produccion con PM2"):
 *   npm ci && npm run build
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * IMPORTANTE:
 *  - instances: 1 y exec_mode 'fork' en AMBOS. El watcher NO puede duplicarse (dos copias
 *    generarian eventos repetidos y se pisarian el estado de data/watcher-state) y el servidor
 *    guarda las sesiones web en memoria (no vale el modo cluster).
 *  - Las variables (.env) las lee la propia aplicacion desde `cwd`, no hace falta duplicarlas aqui.
 *  - Estos nombres no afectan a otras aplicaciones de PM2 del servidor (cada app se gestiona por
 *    nombre); no uses `pm2 restart all` / `pm2 delete all` si hay mas apps.
 */
const common = {
  cwd: __dirname,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true, // si el proceso cae, PM2 lo vuelve a levantar
  watch: false, // nunca reiniciar por cambios de ficheros (data/ cambia constantemente)
  // Reinicios: espera creciente (100 ms, 150, 225... hasta ~15 s) para no entrar en un bucle
  // frenetico si falla algo persistente (p.ej. configuracion incorrecta), pero sin rendirse.
  exp_backoff_restart_delay: 100,
  min_uptime: '15s', // un arranque que dura menos se considera "inestable"
  max_restarts: 1000, // reinicios inestables consecutivos antes de rendirse (practicamente nunca)
  // Parada ordenada: en Windows PM2 no entrega senales, pide el cierre con un mensaje IPC
  // ('shutdown') que la app atiende (ver src/server.ts y scripts/watchLuxLogs.ts). Si no cierra
  // en kill_timeout ms, se mata a la fuerza.
  shutdown_with_message: true,
  kill_timeout: 15000,
  windowsHide: true,
  time: true, // marca de hora en los logs de PM2
  merge_logs: true,
  env: {
    NODE_ENV: 'production',
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'api-whales',
      script: 'dist/src/server.js',
      max_memory_restart: '600M', // red de seguridad ante una fuga de memoria
      out_file: 'logs/api-whales.out.log',
      error_file: 'logs/api-whales.err.log',
    },
    {
      ...common,
      name: 'api-whales-watcher',
      script: 'dist/scripts/watchLuxLogs.js',
      max_memory_restart: '400M',
      out_file: 'logs/watcher.out.log',
      error_file: 'logs/watcher.err.log',
    },
  ],
};
