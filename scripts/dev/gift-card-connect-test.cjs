#!/usr/bin/env node
// Start the public gift-card experience against the existing localhost API.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const root = resolve(__dirname, '../..');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));
const env = apiRequire('dotenv').config({
  path: resolve(root, 'apps/api/.env'),
  quiet: true,
}).parsed;
try {
  if (
    process.env.NODE_ENV === 'production' ||
    !env ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.DATABASE_URL).hostname) ||
    !env.DEMO_RESTAURANT_ID ||
    !env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ||
    !env.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_')
  )
    throw new Error('Test environment required');
} catch {
  console.error(
    'Démarrage refusé : base locale, restaurant de démonstration et clés Stripe de test requis.',
  );
  process.exit(1);
}
const child = spawn('pnpm', ['--filter', '@suppernote/connect', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    API_URL: 'http://localhost:4000',
    NEXT_PUBLIC_API_URL: 'http://localhost:4000',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: env.STRIPE_PUBLISHABLE_KEY,
  },
});
child.on('error', () => {
  console.error('Impossible de démarrer Suppernote Connect.');
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
