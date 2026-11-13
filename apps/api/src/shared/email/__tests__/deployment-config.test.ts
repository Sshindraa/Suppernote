import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve(__dirname, '../../../../../../scripts/ops/sync-env.sh');

function synchronize(url: string | undefined, environment = 'staging') {
  const directory = mkdtempSync(join(tmpdir(), 'suppernote-email-config-'));
  const target = join(directory, '.env');
  const original = 'UNRELATED=preserved\nRESEND_RATE_LIMIT_REDIS_URL=redis://localhost:6379/9\n';
  writeFileSync(target, original, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, SOKAR_API_ENV_FILE: target };
  for (const key of [
    'SENTRY_DSN',
    'ALERT_EMAIL_TO',
    'ALERT_WEBHOOK_URL',
    'ALERT_SMS_TO',
    'RESEND_RATE_LIMIT_REDIS_URL',
  ])
    delete env[key];
  if (url !== undefined) env.RESEND_RATE_LIMIT_REDIS_URL = url;
  try {
    const result = spawnSync('bash', [script, 'alerting', environment], { env, encoding: 'utf8' });
    return {
      ...result,
      contents: readFileSync(target, 'utf8'),
      mode: statSync(target).mode & 0o777,
      original,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Resend coordination deployment configuration', () => {
  it.each(['staging', 'prod'])(
    'synchronizes an explicit shared Redis database for %s',
    (environment) => {
      const url = 'redis://localhost:6379/8';
      const result = synchronize(url, environment);
      expect(result.status).toBe(0);
      expect(result.contents).toBe(`UNRELATED=preserved\nRESEND_RATE_LIMIT_REDIS_URL=${url}\n`);
      expect(result.mode).toBe(0o600);
      expect(result.stdout + result.stderr).not.toContain(url);
    },
  );

  it.each([undefined, ''])(
    'preserves existing configuration when the secret is absent (%s)',
    (url) => {
      const result = synchronize(url);
      expect(result.status).toBe(0);
      expect(result.contents).toBe(result.original);
    },
  );

  it.each([
    'https://localhost/8',
    'redis://localhost',
    'redis://localhost/8\nINJECTED=true',
    'redis://localhost/8#fragment',
  ])('rejects unsafe or ambiguous values without exposing them', (url) => {
    const result = synchronize(url);
    expect(result.status).toBe(1);
    expect(result.contents).toBe(result.original);
    expect(result.stdout + result.stderr).not.toContain(url);
  });
});
