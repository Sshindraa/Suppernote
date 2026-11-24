// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(
  new URL('../../../../infra/nginx/suppernote-staging.conf', import.meta.url),
  'utf8',
);
const servers = [...config.matchAll(/^server \{([\s\S]*?)^\}/gm)]
  .map((match) => match[1])
  // Les redirections de l'ancien domaine ne servent aucun contenu à indexer.
  .filter((server) => !/^ +return 30\d /m.test(server));
const locations = [...config.matchAll(/^    location ([^\n]+) \{([\s\S]*?)^    \}/gm)];
const noindex = /add_header X-Robots-Tag "noindex, nofollow" always;/;

describe('staging crawler exclusion', () => {
  it('sets noindex on both staging virtual hosts', () => {
    expect(servers).toHaveLength(2);
    for (const server of servers) {
      const serverDirectives = server.replace(/^    location [^\n]+ \{[\s\S]*?^    \}/gm, '');
      expect(serverDirectives).toMatch(noindex);
    }
  });

  it('keeps noindex in every location that overrides header inheritance', () => {
    expect(locations.length).toBeGreaterThan(10);
    for (const [, location, body] of locations) {
      if (/^        add_header /m.test(body)) {
        expect(body, `location ${location} must not drop the server noindex`).toMatch(noindex);
      }
    }
  });

  it('routes the privacy document to Connect like production', () => {
    const privacy = locations.find(([, location]) => location === '= /privacy');
    expect(privacy?.[2]).toContain('proxy_pass http://sokar_staging_connect;');
  });

  it('uses always so errors and redirects retain the exclusion', () => {
    const headers = config.split('\n').filter((line) => /add_header X-Robots-Tag/.test(line));
    expect(headers.length).toBeGreaterThan(2);
    for (const header of headers) expect(header).toMatch(noindex);
  });
});
