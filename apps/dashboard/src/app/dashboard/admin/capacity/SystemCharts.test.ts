import { describe, expect, it } from 'vitest';
import { mergeSeries, type PanelData } from './SystemCharts';

describe('mergeSeries', () => {
  it('aligne les séries sur leurs horodatages, triés, avec une clé par série', () => {
    const panel: PanelData = {
      id: 'calls',
      title: 'Appels',
      unit: 'appels',
      series: [
        {
          name: 'A',
          points: [
            { t: 2000, v: 4.123 },
            { t: 1000, v: 1 },
          ],
        },
        { name: 'B', points: [{ t: 1000, v: 66 }] },
      ],
    };
    expect(mergeSeries(panel)).toEqual([
      { t: 1000, s0: 1, s1: 66 },
      { t: 2000, s0: 4.12 },
    ]);
  });

  it('un panneau sans point donne aucune ligne', () => {
    expect(
      mergeSeries({ id: 'x', title: 'x', unit: '', series: [{ name: 'A', points: [] }] }),
    ).toEqual([]);
  });
});
