import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateChecks,
  evaluateTree,
  findMergedPull,
  verifyMergedTreeCi,
} from '../verify-merged-tree-ci.mjs';

const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

const check = (name, status, conclusion, startedAt = '2026-10-22T20:00:00Z', details = '') => ({
  name,
  status,
  conclusion,
  started_at: startedAt,
  details_url: details,
});

const REQUIRED_CHECKS = [
  'Secret Scanning',
  'API',
  'Dashboard',
  'Sokar Connect',
  'Packages (shared / config / database)',
  'Semgrep',
];
const requiredRuns = (overrides = {}) =>
  REQUIRED_CHECKS.map((name) => overrides[name] ?? check(name, 'completed', 'success'));

const pull = {
  number: 560,
  base: { ref: 'main' },
  merged_at: '2026-10-22T20:38:13Z',
  merge_commit_sha: SHA,
  head: { sha: HEAD },
};

test('findMergedPull ignore les PR non fusionnées ou vers une autre branche', () => {
  assert.equal(findMergedPull([{ ...pull, merged_at: null }], SHA), null);
  assert.equal(findMergedPull([{ ...pull, base: { ref: 'dev' } }], SHA), null);
  assert.equal(findMergedPull([{ ...pull, merge_commit_sha: HEAD }], SHA), null);
  assert.equal(findMergedPull([pull], SHA).number, 560);
});

test('evaluateTree exige des arbres identiques', () => {
  assert.equal(evaluateTree({ commitTreeSha: TREE, headTreeSha: TREE }).ok, true);
  assert.equal(evaluateTree({ commitTreeSha: TREE, headTreeSha: HEAD }).ok, false);
  assert.equal(evaluateTree({ commitTreeSha: TREE }).ok, false);
});

test('evaluateChecks accepte success, skipped et neutral', () => {
  const result = evaluateChecks(
    requiredRuns({
      Dashboard: check('Dashboard', 'completed', 'skipped'),
      'Sokar Connect': check('Sokar Connect', 'completed', 'neutral'),
    }),
  );
  assert.equal(result.state, 'ok');
});

test('evaluateChecks refuse un échec, une annulation et l’absence de vérification', () => {
  assert.equal(
    evaluateChecks(requiredRuns({ API: check('API', 'completed', 'failure') })).state,
    'failed',
  );
  assert.equal(
    evaluateChecks(requiredRuns({ API: check('API', 'completed', 'cancelled') })).state,
    'failed',
  );
  assert.equal(evaluateChecks([]).state, 'failed');
});

test('evaluateChecks signale une vérification en cours sans la juger', () => {
  const result = evaluateChecks(
    requiredRuns({ Dashboard: check('Dashboard', 'in_progress', null) }),
  );
  assert.equal(result.state, 'pending');
  assert.match(result.reason, /Dashboard/);
});

test('evaluateChecks retient la dernière exécution d’un même nom (push et pull_request)', () => {
  const rerun = [
    ...requiredRuns({ API: check('API', 'completed', 'failure', '2026-10-22T20:00:00Z') }),
    check('API', 'completed', 'success', '2026-10-22T20:10:00Z'),
  ];
  assert.equal(evaluateChecks(rerun).state, 'ok');
  assert.equal(evaluateChecks([...rerun].reverse()).state, 'ok');
  const regression = [
    ...requiredRuns(),
    check('API', 'completed', 'failure', '2026-10-22T20:10:00Z'),
  ];
  assert.equal(evaluateChecks(regression).state, 'failed');
});

test('evaluateChecks ignore les vérifications du run en cours', () => {
  const result = evaluateChecks(
    [
      ...requiredRuns(),
      check(
        'Analyze (swift)',
        'in_progress',
        null,
        undefined,
        'https://github.com/o/r/actions/runs/42/job/1',
      ),
    ],
    { ignoreRunId: '42' },
  );
  assert.equal(result.state, 'ok');
});

function fakeGithub({ pulls = [pull], commitTree = TREE, headTree = TREE, checkRuns }) {
  const calls = [];
  const fetchImpl = async (url) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    let body;
    if (path.endsWith(`/commits/${SHA}/pulls`)) body = pulls;
    else if (path.endsWith(`/git/commits/${SHA}`)) body = { tree: { sha: commitTree } };
    else if (path.endsWith(`/git/commits/${HEAD}`)) body = { tree: { sha: headTree } };
    else if (path.includes(`/commits/${HEAD}/check-runs`)) {
      const next = Array.isArray(checkRuns[0]) ? checkRuns.shift() : checkRuns;
      body = { check_runs: next };
    } else return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const run = (github, extra = {}) =>
  verifyMergedTreeCi({
    repository: 'o/r',
    sha: SHA,
    token: 't',
    fetchImpl: github.fetchImpl,
    log: () => {},
    sleep: async () => {},
    ...extra,
  });

test('verifyMergedTreeCi réussit : PR fusionnée, arbre identique, vérifications vertes', async () => {
  const github = fakeGithub({ checkRuns: requiredRuns() });
  assert.equal((await run(github)).ok, true);
});

test('verifyMergedTreeCi échoue sans PR fusionnée (poussée directe)', async () => {
  const github = fakeGithub({ pulls: [], checkRuns: [] });
  const result = await run(github);
  assert.equal(result.ok, false);
  assert.match(result.reason, /aucune PR/);
});

test('verifyMergedTreeCi échoue si l’arbre diffère (fusion sans mise à jour)', async () => {
  const github = fakeGithub({
    headTree: 'd'.repeat(40),
    checkRuns: requiredRuns(),
  });
  const result = await run(github);
  assert.equal(result.ok, false);
  assert.match(result.reason, /diffère/);
});

test('verifyMergedTreeCi ignore un contrôle facultatif en échec', async () => {
  const github = fakeGithub({
    checkRuns: [...requiredRuns(), check('Analyze (swift)', 'completed', 'failure')],
  });
  const result = await run(github);
  assert.equal(result.ok, true);
});

test('verifyMergedTreeCi attend une vérification en cours puis réussit', async () => {
  const github = fakeGithub({
    checkRuns: [
      requiredRuns({ Dashboard: check('Dashboard', 'in_progress', null) }),
      requiredRuns(),
    ],
  });
  assert.equal((await run(github)).ok, true);
});

test('verifyMergedTreeCi abandonne au délai', async () => {
  const github = fakeGithub({
    checkRuns: requiredRuns({ Dashboard: check('Dashboard', 'in_progress', null) }),
  });
  const result = await run(github, { timeoutSeconds: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /délai dépassé/);
});
