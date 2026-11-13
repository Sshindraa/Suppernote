#!/usr/bin/env node
// Preuve que le commit de `main` à déployer a déjà passé les checks CI requis.
//
// La fusion se fait par PR et la protection de `main` exige les checks listés ci-dessous.
// L'arbre du commit squash doit être celui de la tête de la PR, déjà testée.
// Ce script le vérifie à chaque déploiement :
//   1. une PR fusionnée vers `main` correspond à ce commit ;
//   2. l'arbre Git du commit est identique à celui de la tête de cette PR ;
//   3. les checks requis de la tête de la PR sont terminés et verts.
// Sans preuve, le script échoue : le déploiement ne démarre pas et il faut
// lancer la CI complète sur `main` (workflow_dispatch) avant de relancer.
//
// Usage : GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node verify-merged-tree-ci.mjs <sha>
// Variables optionnelles : GITHUB_RUN_ID (exclut les vérifications du run en cours),
// VERIFY_TIMEOUT_SECONDS (attente des vérifications en cours, 900 par défaut).

import { fileURLToPath } from 'node:url';

const GREEN_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
// Keep in sync with the required status checks on the `main` branch.
const REQUIRED_CHECKS = [
  'Secret Scanning',
  'API',
  'Dashboard',
  'Suppernote Connect',
  'Packages (shared / config / database)',
  'Semgrep',
];

/** Retrouve la PR fusionnée vers `main` qui a produit ce commit. */
export function findMergedPull(pulls, sha) {
  return (
    pulls.find(
      (pull) => pull.base?.ref === 'main' && pull.merged_at && pull.merge_commit_sha === sha,
    ) ?? null
  );
}

/**
 * Résume les checks protégés : les analyses facultatives (par exemple CodeQL) ne bloquent
 * pas le déploiement, et une relance garde sa valeur la plus récente.
 */
export function evaluateChecks(checkRuns, { ignoreRunId } = {}) {
  const latestByName = new Map();
  for (const run of checkRuns) {
    if (!REQUIRED_CHECKS.includes(run.name)) continue;
    if (ignoreRunId && String(run.details_url ?? '').includes(`/actions/runs/${ignoreRunId}/`)) {
      continue;
    }
    const previous = latestByName.get(run.name);
    const startedAt = Date.parse(run.started_at ?? run.completed_at ?? '') || 0;
    const previousStartedAt = previous
      ? Date.parse(previous.started_at ?? previous.completed_at ?? '') || 0
      : -1;
    if (!previous || startedAt >= previousStartedAt) latestByName.set(run.name, run);
  }
  const missing = REQUIRED_CHECKS.filter((name) => !latestByName.has(name));
  if (missing.length > 0) {
    return {
      state: 'failed',
      reason: `checks requis absents : ${missing.join(', ')}`,
    };
  }
  const runs = REQUIRED_CHECKS.map((name) => latestByName.get(name));

  const failed = runs.filter(
    (run) => run.status === 'completed' && !GREEN_CONCLUSIONS.has(run.conclusion),
  );
  if (failed.length > 0) {
    return {
      state: 'failed',
      reason: `vérifications en échec : ${failed.map((run) => `${run.name} (${run.conclusion})`).join(', ')}`,
    };
  }
  const pending = runs.filter((run) => run.status !== 'completed');
  if (pending.length > 0) {
    return {
      state: 'pending',
      reason: `vérifications en cours : ${pending.map((run) => run.name).join(', ')}`,
    };
  }
  return {
    state: 'ok',
    reason: `${runs.length} checks requis verts`,
    names: runs.map((run) => run.name),
  };
}

/** Compare l'arbre du commit à déployer à celui de la tête de la PR. */
export function evaluateTree({ commitTreeSha, headTreeSha }) {
  if (!commitTreeSha || !headTreeSha) return { ok: false, reason: 'arbre Git introuvable' };
  if (commitTreeSha !== headTreeSha) {
    return {
      ok: false,
      reason: `l'arbre du commit (${commitTreeSha}) diffère de celui de la tête de la PR (${headTreeSha}) : la CI de la PR ne prouve rien`,
    };
  }
  return { ok: true, reason: `arbre identique (${commitTreeSha})` };
}

async function githubGet(path, { token, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path} → HTTP ${response.status}`);
  return response.json();
}

async function listCheckRuns(repository, sha, ctx) {
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await githubGet(
      `/repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      ctx,
    );
    runs.push(...body.check_runs);
    if (body.check_runs.length < 100) break;
  }
  return runs;
}

export async function verifyMergedTreeCi({
  repository,
  sha,
  token,
  runId,
  timeoutSeconds = 900,
  pollSeconds = 30,
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const ctx = { token, fetchImpl };
  const pulls = await githubGet(`/repos/${repository}/commits/${sha}/pulls`, ctx);
  const pull = findMergedPull(pulls, sha);
  if (!pull) return { ok: false, reason: `aucune PR fusionnée vers main ne correspond à ${sha}` };
  log(`PR #${pull.number}, tête ${pull.head.sha}`);

  const [commit, headCommit] = await Promise.all([
    githubGet(`/repos/${repository}/git/commits/${sha}`, ctx),
    githubGet(`/repos/${repository}/git/commits/${pull.head.sha}`, ctx),
  ]);
  const tree = evaluateTree({ commitTreeSha: commit.tree?.sha, headTreeSha: headCommit.tree?.sha });
  if (!tree.ok) return tree;
  log(tree.reason);

  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const checks = evaluateChecks(await listCheckRuns(repository, pull.head.sha, ctx), {
      ignoreRunId: runId,
    });
    if (checks.state === 'ok') {
      log(checks.reason);
      return { ok: true, reason: `PR #${pull.number} : ${tree.reason}, ${checks.reason}` };
    }
    if (checks.state === 'failed') return { ok: false, reason: checks.reason };
    if (Date.now() >= deadline) return { ok: false, reason: `délai dépassé, ${checks.reason}` };
    log(`${checks.reason} ; nouvelle lecture dans ${pollSeconds} s`);
    await sleep(pollSeconds * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2];
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, VERIFY_TIMEOUT_SECONDS } = process.env;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.error(
      'Usage : GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node verify-merged-tree-ci.mjs <sha>',
    );
    process.exit(2);
  }
  verifyMergedTreeCi({
    repository: GITHUB_REPOSITORY,
    sha,
    token: GITHUB_TOKEN,
    runId: GITHUB_RUN_ID,
    timeoutSeconds: Number(VERIFY_TIMEOUT_SECONDS) || 900,
  })
    .then((result) => {
      if (result.ok) {
        process.stdout.write(`✅ ${result.reason}\n`);
        return;
      }
      console.error(`::error::Pas de preuve de CI pour ${sha} : ${result.reason}`);
      console.error(
        'Lancer la CI complète (gh workflow run ci.yml --ref main), puis Deploy Staging en manuel.',
      );
      process.exit(1);
    })
    .catch((error) => {
      console.error(`::error::Vérification impossible : ${error.message}`);
      process.exit(1);
    });
}
