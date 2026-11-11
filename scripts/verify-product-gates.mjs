#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const gatesPath = path.join(repositoryRoot, 'docs', 'release', 'product-gates.json');

const requiredGateIds = [
  'P0_USAGE',
  'P1_ESSENTIAL',
  'P2_CRM',
  'P3_MARKETING',
  'P4_ATTRIBUTION',
  'P5_PAYMENTS',
  'P6_POS',
  'P7_CUSTOMER_GROUP',
  'P8_REPUTATION',
  'P9_ECOSYSTEM',
  'PILOTS',
];
const validStatuses = new Set(['OPEN', 'LOCAL_ONLY', 'CLOSED']);
const validReleaseModes = new Set(['SCOPED', 'FULL']);
const knownFeatureFlags = new Set([
  'CRM_ADVANCED_ENABLED',
  'MARKETING_SENDS_ENABLED',
  'MARKETING_WHATSAPP_ENABLED',
  'POS_CONNECTORS_ENABLED',
  'RESERVATION_PAYMENTS_ENABLED',
  'CUSTOMER_GROUPS_ENABLED',
  'EXPERIENCES_ENABLED',
  'EVENTS_ENABLED',
  'DISTRIBUTION_ENABLED',
]);

function fail(message) {
  console.error(`❌ Product release gate: ${message}`);
  process.exitCode = 1;
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
} catch (error) {
  fail(`impossible de lire ${path.relative(repositoryRoot, gatesPath)}`);
  if (error instanceof Error) console.error(`   ${error.message}`);
  process.exit();
}

if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.gates)) {
  fail('manifest invalide: schemaVersion=1 et gates[] sont requis');
  process.exit();
}

const gateIds = new Set(manifest.gates.map((gate) => gate?.id).filter(Boolean));
if (gateIds.size !== manifest.gates.length) {
  fail('manifest invalide: les identifiants de porte doivent être uniques');
  process.exit();
}
const missingGateIds = requiredGateIds.filter((id) => !gateIds.has(id));
if (missingGateIds.length > 0) {
  fail(`manifest incomplet: portes requises absentes (${missingGateIds.join(', ')})`);
  process.exit();
}

const invalidStatusGates = manifest.gates.filter((gate) => !validStatuses.has(gate?.status));
if (invalidStatusGates.length > 0) {
  fail(
    `manifest invalide: statut attendu OPEN, LOCAL_ONLY ou CLOSED (${invalidStatusGates
      .map((gate) => gate?.id ?? 'sans-id')
      .join(', ')})`,
  );
  process.exit();
}

const invalidEvidenceGates = manifest.gates.filter(
  (gate) =>
    !Array.isArray(gate?.evidence) ||
    gate.evidence.length === 0 ||
    gate.evidence.some(
      (evidence) =>
        typeof evidence !== 'string' ||
        evidence.trim().length === 0 ||
        !fs.existsSync(path.resolve(repositoryRoot, evidence)),
    ),
);
if (invalidEvidenceGates.length > 0) {
  fail(
    `manifest incomplet: chaque porte doit référencer des preuves existantes (${invalidEvidenceGates
      .map((gate) => gate?.id ?? 'sans-id')
      .join(', ')})`,
  );
  process.exit();
}

const invalidBlockerGates = manifest.gates.filter(
  (gate) =>
    gate?.status !== 'CLOSED' &&
    (!Array.isArray(gate?.blockers) ||
      gate.blockers.length === 0 ||
      gate.blockers.some((blocker) => typeof blocker !== 'string' || blocker.trim().length === 0)),
);
if (invalidBlockerGates.length > 0) {
  fail(
    `manifest incomplet: chaque porte non fermée doit lister ses bloqueurs (${invalidBlockerGates
      .map((gate) => gate?.id ?? 'sans-id')
      .join(', ')})`,
  );
  process.exit();
}

const invalidClosedBlockers = manifest.gates.filter(
  (gate) => gate?.status === 'CLOSED' && Array.isArray(gate?.blockers) && gate.blockers.length > 0,
);
if (invalidClosedBlockers.length > 0) {
  fail(
    `manifest incohérent: une porte CLOSED ne peut pas conserver de bloqueurs (${invalidClosedBlockers
      .map((gate) => gate?.id ?? 'sans-id')
      .join(', ')})`,
  );
  process.exit();
}

function validateEvidenceList(owner, label) {
  if (
    !Array.isArray(owner?.evidence) ||
    owner.evidence.length === 0 ||
    owner.evidence.some(
      (evidence) =>
        typeof evidence !== 'string' ||
        evidence.trim().length === 0 ||
        !fs.existsSync(path.resolve(repositoryRoot, evidence)),
    )
  ) {
    fail(`${label}: evidence[] doit référencer au moins un fichier existant`);
    return false;
  }
  return true;
}

function validateReleaseProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    fail('productionRelease est requis lorsque productionFreeze=true');
    return null;
  }
  if (typeof profile.id !== 'string' || profile.id.trim().length === 0) {
    fail('productionRelease.id doit être renseigné');
    return null;
  }
  if (!validReleaseModes.has(profile.mode)) {
    fail('productionRelease.mode doit être SCOPED ou FULL');
    return null;
  }

  const required = profile.requiredGateIds;
  const deferred = profile.deferredGateIds;
  if (!Array.isArray(required) || required.length === 0) {
    fail('productionRelease.requiredGateIds doit contenir au moins une porte');
    return null;
  }
  if (!Array.isArray(deferred)) {
    fail('productionRelease.deferredGateIds doit être un tableau');
    return null;
  }

  const allIds = [...required, ...deferred];
  const uniqueIds = new Set(allIds);
  const unknownIds = allIds.filter((id) => !gateIds.has(id));
  if (unknownIds.length > 0) {
    fail(
      `productionRelease référence des portes inconnues (${[...new Set(unknownIds)].join(', ')})`,
    );
    return null;
  }
  if (uniqueIds.size !== allIds.length || uniqueIds.size !== gateIds.size) {
    const missing = requiredGateIds.filter((id) => !uniqueIds.has(id));
    fail(
      `productionRelease doit partitionner exactement toutes les portes${
        missing.length > 0 ? `; absentes: ${missing.join(', ')}` : ''
      }`,
    );
    return null;
  }

  if (!validateEvidenceList(profile, 'productionRelease')) return null;

  if (profile.mode === 'SCOPED') {
    if (!Array.isArray(profile.disabledFeatureFlags) || profile.disabledFeatureFlags.length === 0) {
      fail('productionRelease SCOPED doit déclarer disabledFeatureFlags[]');
      return null;
    }
    const invalidFlags = profile.disabledFeatureFlags.filter(
      (flag) => typeof flag !== 'string' || !knownFeatureFlags.has(flag),
    );
    if (invalidFlags.length > 0) {
      fail(
        `productionRelease.disabledFeatureFlags contient des flags inconnus (${invalidFlags.join(
          ', ',
        )})`,
      );
      return null;
    }
    if (new Set(profile.disabledFeatureFlags).size !== profile.disabledFeatureFlags.length) {
      fail('productionRelease.disabledFeatureFlags doit être dédupliqué');
      return null;
    }
  } else if (deferred.length > 0 || required.length !== gateIds.size) {
    fail('productionRelease FULL doit requérir toutes les portes et ne peut pas en différer');
    return null;
  }

  return {
    requiredGateIds: new Set(required),
    deferredGateIds: new Set(deferred),
    disabledFeatureFlags: profile.disabledFeatureFlags ?? [],
  };
}

function readDotEnvValues(filePath) {
  const values = new Map();
  if (!fs.existsSync(filePath)) return values;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function verifyProductionFeatureFlags(profile) {
  if (process.env.DEPLOY_ENV !== 'prod' || profile.disabledFeatureFlags.length === 0) return true;

  const apiEnvPath = path.join(repositoryRoot, 'apps', 'api', '.env');
  if (!fs.existsSync(apiEnvPath)) {
    fail(
      `fichier de configuration production absent: ${path.relative(repositoryRoot, apiEnvPath)}`,
    );
    return false;
  }

  const values = readDotEnvValues(apiEnvPath);
  const enabledFlags = profile.disabledFeatureFlags.filter((flag) => values.get(flag) === 'true');
  if (enabledFlags.length > 0) {
    fail(
      `le profil ${profile.id} exige que ces fonctionnalités restent désactivées en production (${enabledFlags.join(
        ', ',
      )})`,
    );
    return false;
  }
  return true;
}

const productionRelease = manifest.productionRelease;
const releaseProfile = productionRelease ? validateReleaseProfile(productionRelease) : null;
if (productionRelease && !releaseProfile) process.exit();

const openGates = manifest.gates.filter((gate) => gate?.status !== 'CLOSED');
const freezeActive = manifest.productionFreeze === true;
const requiredOpenGates = manifest.gates.filter(
  (gate) =>
    gate?.status !== 'CLOSED' &&
    (releaseProfile ? releaseProfile.requiredGateIds.has(gate.id) : true),
);

if (releaseProfile?.requiredGateIds && requiredOpenGates.length > 0) {
  fail('une porte requise par le profil de release n’est pas CLOSED');
  for (const gate of requiredOpenGates) {
    const statusLabel =
      gate.status === 'LOCAL_ONLY'
        ? 'LOCAL_ONLY — livraison locale présente, preuves externes ouvertes'
        : gate.status;
    const evidence =
      Array.isArray(gate.evidence) && gate.evidence.length > 0
        ? ` — preuve: ${gate.evidence.join(', ')}`
        : '';
    console.error(`   • ${gate.id}: ${gate.label ?? 'sans libellé'} [${statusLabel}]${evidence}`);
    for (const blocker of gate.blockers ?? []) console.error(`     - reste: ${blocker}`);
  }
  process.exit();
}

if (!releaseProfile && (freezeActive || openGates.length > 0)) {
  const reason = freezeActive
    ? 'le gel production est actif et aucun profil scoped n’est déclaré'
    : 'au moins une porte de sortie n’est pas CLOSED';
  fail(reason);
  for (const gate of openGates) {
    const statusLabel =
      gate.status === 'LOCAL_ONLY'
        ? 'LOCAL_ONLY — livraison locale présente, preuves externes ouvertes'
        : gate.status;
    const evidence =
      Array.isArray(gate.evidence) && gate.evidence.length > 0
        ? ` — preuve: ${gate.evidence.join(', ')}`
        : '';
    console.error(`   • ${gate.id}: ${gate.label ?? 'sans libellé'} [${statusLabel}]${evidence}`);
    for (const blocker of gate.blockers ?? []) console.error(`     - reste: ${blocker}`);
  }
  process.exit();
}

if (releaseProfile) {
  if (!verifyProductionFeatureFlags(releaseProfile)) process.exit();
  const deferredLabels = manifest.gates
    .filter((gate) => releaseProfile.deferredGateIds.has(gate.id))
    .map((gate) => gate.id)
    .join(', ');
  process.stdout.write(
    `✅ Product release profile ${productionRelease.id} accepted (required: ${
      releaseProfile.requiredGateIds.size
    } gates; deferred: ${deferredLabels}).\n`,
  );
  if (freezeActive) {
    process.stdout.write(
      `ℹ️ Le gel complet reste actif ; périmètre promu : ${productionRelease.label ?? productionRelease.id}. Les portes différées restent ouvertes.\n`,
    );
  }
} else {
  process.stdout.write(`✅ Product release gates closed (${manifest.gates.length} gates).\n`);
}
