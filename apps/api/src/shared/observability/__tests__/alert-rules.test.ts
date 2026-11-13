import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { registeredMetricNames } from '../metrics';

/**
 * Garde-fou R1-6 : une règle d'alerte qui référence une métrique inexistante ne
 * se déclenche jamais, et personne ne s'en aperçoit avant l'incident. Ce test
 * compare les métriques citées dans `infra/prometheus/alerts.yml` à celles que
 * le code enregistre réellement.
 *
 * Limite connue : il valide les noms, pas le fait qu'une métrique soit peuplée
 * dans le process scrapé. La répartition API / worker est documentée dans
 * `docs/runbooks/observability.md`.
 */
const ALERTS_PATH = path.resolve(process.cwd(), '../../infra/prometheus/alerts.yml');

describe('règles d’alerte Prometheus', () => {
  const alertsText = readFileSync(ALERTS_PATH, 'utf8');

  it('déclare des règles complètes (expr, for, severity, summary)', () => {
    const alertCount = (alertsText.match(/^\s*- alert:/gm) ?? []).length;
    const exprCount = (alertsText.match(/^\s*expr:/gm) ?? []).length;
    const forCount = (alertsText.match(/^\s*for:/gm) ?? []).length;
    const summaryCount = (alertsText.match(/^\s*summary:/gm) ?? []).length;

    expect(alertCount).toBeGreaterThanOrEqual(8);
    expect(exprCount).toBe(alertCount);
    expect(forCount).toBe(alertCount);
    expect(summaryCount).toBe(alertCount);
  });

  it('ne référence que des métriques réellement enregistrées', () => {
    const referenced = [...new Set(alertsText.match(/suppernote_[a-z0-9_]+/g) ?? [])];
    expect(referenced.length).toBeGreaterThan(5);

    const registered = new Set(registeredMetricNames());
    const unknown = referenced.filter((name) => !registered.has(name));
    expect(unknown).toEqual([]);
  });

  it('toutes les métriques maison portent le préfixe suppernote_', () => {
    // `collectDefaultMetrics` ajoute process_*, nodejs_*, etc. : on ne garde que
    // les séries définies dans ce module.
    const registered = registeredMetricNames().filter(
      (name) => !name.startsWith('process_') && !name.startsWith('nodejs_'),
    );
    const unprefixed = registered.filter((name) => !name.startsWith('suppernote_'));
    expect(unprefixed).toEqual([]);
  });
});
