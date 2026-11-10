import fs from 'node:fs';
const env = fs.readFileSync('/Users/hamza/Projects/Sokar/apps/api/.env', 'utf8');
const key = env
  .match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1]
  ?.trim()
  .replace(/^["']|["']$/g, '');
if (!key) throw new Error('no key');
const audio = fs.readFileSync(process.argv[2]).toString('base64');
const prompt = `Tu écoutes la voix d'un agent téléphonique de restaurant (voix synthétique, qualité téléphone) pendant un appel réel. Les silences sont les moments où l'appelant parle.
Objectif : dire précisément pourquoi cette voix « sonne très IA » et ce qui la rendrait plus humaine.
1. Transcris chaque réplique avec son horodatage approximatif (mm:ss).
2. Pour chaque réplique, note : débit, rythme, intonation (plate, montante en fin de phrase, courbe répétitive), mise en avant des mots, liaisons, respirations/hésitations, artefacts (coupures, clics, voix métallique), registre trop écrit/lu.
3. Dégage les 5 défauts qui trahissent le plus l'IA, classés par poids, chacun avec 1-2 exemples horodatés.
4. Sépare ce qui vient de la voix (prosodie, timbre) de ce qui vient du texte (phrases trop complètes, formules, absence d'hésitation).
5. Donne 5 corrections concrètes, applicables soit au texte, soit au réglage TTS.
Réponds en français, de façon factuelle ; ne flatte pas.`;
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'google/gemini-2.5-pro',
    temperature: 0.2,
    max_tokens: 6000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'input_audio', input_audio: { data: audio, format: 'wav' } },
        ],
      },
    ],
  }),
});
const json = await res.json();
if (!res.ok) {
  console.error(res.status, JSON.stringify(json).slice(0, 400));
  process.exit(1);
}
// eslint-disable-next-line no-console -- sortie du script
console.log(json.choices?.[0]?.message?.content);
console.error('usage', JSON.stringify(json.usage));
