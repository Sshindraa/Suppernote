// PM2 ecosystem pour l'environnement de STAGING Suppernote.
//
// Services séparés de la prod (préfixe suppernote-staging-*) sur ports décalés :
//   API      → 4100 (prod: 4000)
//   Dashboard → 3100 (prod: 3000)
//   Connect  → 4102 (prod: 4002)
//
// Isolement : DB sokar_staging, Redis dédié redis-staging sur 127.0.0.1:6380 base 0 (prod: redis sur 6379, bases 0/1/2), Clerk staging keys,
// voice désactivée (STAGING_DISABLE_VOICE=true via .env).
module.exports = {
  apps: [
    {
      name: 'suppernote-staging-api',
      cwd: '/opt/suppernote-staging/apps/api',
      script: 'dist/main.js',
      node_args: '--env-file=.env --enable-source-maps',
      env: {
        // Même valeur que max_memory_restart ci-dessous : sert au calcul du seuil d'appels simultanés.
        PROCESS_MEMORY_LIMIT_MB: '500',
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'staging',
        PORT: '4100',
        HOST: '127.0.0.1',
        // Les workers tournent dans `suppernote-staging-workers` (R1-1).
        RUN_WORKERS_IN_PROCESS: 'false',
      },
      watch: false,
      max_memory_restart: '500M',
      error_file: '/var/log/suppernote/staging-api-error.log',
      out_file: '/var/log/suppernote/staging-api-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Health check readiness (P0 DEP-005) : PM2 attend le signal 'ready' de l'API.
      wait_ready: true,
      listen_timeout: 30000,
      kill_timeout: 30000, // > VOICE_SHUTDOWN_GRACE_MS : laisse finir les appels en cours
      exp_backoff_restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      // Process dédié aux workers BullMQ et aux jobs récurrents (R1-1).
      name: 'suppernote-staging-workers',
      cwd: '/opt/suppernote-staging/apps/api',
      script: 'dist/worker.js',
      node_args: '--env-file=.env --enable-source-maps',
      env: {
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'staging',
        RUN_WORKERS_IN_PROCESS: 'false',
        // Endpoint de métriques du worker (R1-6). Port dédié côté staging pour
        // ne pas entrer en collision avec la prod sur le même VPS.
        METRICS_PORT: '4101',
      },
      watch: false,
      max_memory_restart: '700M',
      error_file: '/var/log/suppernote/staging-workers-error.log',
      out_file: '/var/log/suppernote/staging-workers-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      wait_ready: true,
      listen_timeout: 30000,
      kill_timeout: 15000,
      exp_backoff_restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'suppernote-staging-dashboard',
      cwd: '/opt/suppernote-staging/apps/dashboard',
      script: 'bin/run-dashboard.sh',
      env: {
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'staging',
        PORT: '3100',
        HOSTNAME: '::',
      },
      watch: false,
      max_memory_restart: '500M',
      error_file: '/var/log/suppernote/staging-dashboard-error.log',
      out_file: '/var/log/suppernote/staging-dashboard-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      listen_timeout: 30000,
      kill_timeout: 8000,
      exp_backoff_restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'suppernote-staging-connect',
      cwd: '/opt/suppernote-staging/apps/connect',
      script: 'bin/run-connect.sh',
      env: {
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'staging',
        PORT: '4102',
        HOSTNAME: '127.0.0.1',
      },
      watch: false,
      max_memory_restart: '400M',
      error_file: '/var/log/suppernote/staging-connect-error.log',
      out_file: '/var/log/suppernote/staging-connect-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      listen_timeout: 30000,
      kill_timeout: 8000,
      exp_backoff_restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
