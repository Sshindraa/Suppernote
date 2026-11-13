import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildJudgeRequest,
  buildJudgeRequests,
  expectsComplete,
  isJudgeCase,
  JUDGE_DRAWS,
  JUDGE_INSTRUCTIONS,
  JUDGE_INSTRUCTIONS_CANDIDATE,
  judgeAsTurn,
  judgeInstructionsVerdict,
  turnCompleteOnly,
} from '../behavior-eval/judge';
import { scoreAll } from '../behavior-eval/score';
import type { BehaviorCasesFile } from '../behavior-eval/types';
import type { AbReport } from '../behavior-eval/paired';

const file = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../../scripts/fixtures/voice-behavior/cases.json'),
    'utf8',
  ),
) as BehaviorCasesFile;

describe('juge de fin de tour (prototype de banc)', () => {
  it('ne voit que la dernière question de l’agent et la parole de l’appelant', () => {
    const testCase = file.cases.find((entry) => entry.id === 'attend-annonce-intention')!;
    const request = buildJudgeRequest(testCase, file);
    expect(request.messages).toHaveLength(2);
    const user = String(request.messages[1].content);
    expect(user).toContain(testCase.transcript);
    expect(user).toContain('Vers quelle heure');
    // Pas le reste du dialogue, ni état, calendrier ou règles de réservation.
    expect(user).not.toContain('bonjour je souhaite');
    expect(JSON.stringify(request.messages)).not.toMatch(/ÉTAT VÉRIFIÉ|CALENDRIER|draft|action/);
    expect(request.format.json_schema.schema).toEqual({
      type: 'object',
      properties: { complete: { type: 'boolean' } },
      required: ['complete'],
      additionalProperties: false,
    });
  });

  it('la consigne ne contient ni exemple, ni mot de l’appelant du banc, ni les principes du prompt actuel', () => {
    const spoken = file.cases.map((entry) => entry.transcript).filter(Boolean);
    for (const transcript of spoken) expect(JUDGE_INSTRUCTIONS).not.toContain(transcript);
    expect(JUDGE_INSTRUCTIONS).not.toMatch(/annonce|rejet|nie|réserv|« /iu);
  });

  it('couvre la famille « attente » et ses témoins, aux tirages du plan chiffré', () => {
    const requests = buildJudgeRequests(file);
    const cases = file.cases.filter(isJudgeCase);
    expect(requests.map((request) => request.id)).toEqual(cases.map((entry) => entry.id));
    expect(cases.every((entry) => entry.family === 'attente')).toBe(true);
    for (const entry of cases) {
      const request = requests.find((candidate) => candidate.id === entry.id)!;
      // Tout cas qui attend « complet » compte comme témoin : 24 tirages (95 % à une erreur près).
      expect(request.samples).toBe(
        expectsComplete(entry) || entry.origin === 'control'
          ? JUDGE_DRAWS.control
          : JUDGE_DRAWS.defect,
      );
    }
  });

  it('a des témoins « complet » : début abandonné puis demande complète, réponses courtes, questions mal transcrites', () => {
    const witnesses = file.cases.filter(expectsComplete);
    const real = witnesses.find((entry) => entry.id === 'juge-debut-abandonne-question')!;
    expect(real.origin).toBe('real');
    expect(real.transcript).toBe('bonjour je voudrais faire vous êtes ouvert dimanche soir');
    expect(
      witnesses.filter((entry) => entry.variantOf === 'juge-debut-abandonne-question').length,
    ).toBeGreaterThanOrEqual(3);
    expect(witnesses.filter((entry) => entry.id.startsWith('juge-reponse-courte')).length).toBe(3);
    expect(
      witnesses.filter((entry) => entry.id.startsWith('juge-question-mal-transcrite')).length,
    ).toBe(3);
    for (const entry of witnesses) {
      const check = entry.checks.find((c) => 'path' in c && c.path === 'turnComplete');
      expect(check && 'minRate' in check ? check.minRate : 0).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('la consigne candidate ajoute un principe sans exemple, et la consigne de production reste inchangée', () => {
    expect(JUDGE_INSTRUCTIONS_CANDIDATE.startsWith(JUDGE_INSTRUCTIONS)).toBe(true);
    expect(JUDGE_INSTRUCTIONS_CANDIDATE.length).toBeGreaterThan(JUDGE_INSTRUCTIONS.length);
    const spoken = file.cases.map((entry) => entry.transcript).filter(Boolean);
    for (const transcript of spoken) expect(JUDGE_INSTRUCTIONS_CANDIDATE).not.toContain(transcript);
    const testCase = file.cases.find((entry) => entry.id === 'juge-debut-abandonne-question')!;
    const current = buildJudgeRequest(testCase, file);
    const candidate = buildJudgeRequest(testCase, file, undefined, JUDGE_INSTRUCTIONS_CANDIDATE);
    expect(current.messages[0].content).toBe(JUDGE_INSTRUCTIONS);
    expect(candidate.messages[0].content).toBe(JUDGE_INSTRUCTIONS_CANDIDATE);
    // Même question de l'agent, même parole : seule la consigne change.
    expect(candidate.messages[1]).toEqual(current.messages[1]);
    expect(String(current.messages[1].content)).toContain(
      'Bonjour, ici Chez Suppernote. Je vous écoute.',
    );
  });

  it('se note sur le seul contrôle turnComplete, comme le tour structuré', () => {
    const testCase = file.cases.find((entry) => entry.id === 'repond-reponse-complete')!;
    expect(testCase.checks.length).toBeGreaterThan(1);
    const [only] = [testCase].map(turnCompleteOnly);
    expect(only.checks).toHaveLength(1);
    const raw = {
      model: 'm',
      responses: {
        [testCase.id]: [{ complete: true }, { complete: true }, { complete: false }, null],
      },
    };
    const [result] = scoreAll([only], judgeAsTurn(raw));
    // Une réponse invalide (null) est écartée du taux : 2 réussis sur 3 valides.
    expect(result.valid).toBe(3);
    expect(result.checks[0].rate).toBeCloseTo(2 / 3);
  });

  it('juge la consigne candidate : témoins à 95 %, lignée b686b241 qui ne baisse pas, cas réel rapporté', () => {
    const arm = (successes: number, draws: number) => ({ successes, draws, invalid: 0 });
    const entry = (id: string, reference: [number, number], candidate: [number, number]) => ({
      id,
      family: 'attente' as const,
      origin: 'control' as const,
      measures: 'model' as const,
      reference: arm(...reference),
      candidate: arm(...candidate),
      delta: 0,
    });
    const report = {
      cases: [
        entry('juge-reponse-courte-nombre', [24, 24], [24, 24]),
        entry('juge-question-mal-transcrite', [20, 24], [22, 24]),
        entry('juge-debut-abandonne-question', [3, 24], [23, 24]),
      ],
      lineages: [
        {
          root: 'attend-annonce-intention',
          cases: 4,
          drawsPerArm: 64,
          referenceRate: 0.9,
          candidateRate: 0.7,
          delta: -0.2,
          low: -0.3,
          high: -0.1,
        },
      ],
    } as unknown as AbReport;
    const verdict = judgeInstructionsVerdict(
      report,
      new Set([
        'juge-reponse-courte-nombre',
        'juge-question-mal-transcrite',
        'juge-debut-abandonne-question',
      ]),
      'juge-debut-abandonne-question',
    );
    expect(verdict).toContain('✓ juge-reponse-courte-nombre ≥ 95 %');
    expect(verdict).toContain('✗ juge-question-mal-transcrite ≥ 95 % : 92 %');
    expect(verdict).toContain('✓ juge-debut-abandonne-question ≥ 95 % : 96 %');
    expect(verdict).toContain('✗ lignée b686b241');
    expect(verdict).toContain('Cas réel 03b19223 (juge-debut-abandonne-question) : 3/24 → 23/24');
  });
});
