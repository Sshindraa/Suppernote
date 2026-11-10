#!/usr/bin/env bash
# Écoute un appel enregistré : télécharge le MP3 (VPS, lecture seule), isole la piste de l'agent (canal droit),
# mesure les pauses, puis demande à un modèle audio (Gemini via OpenRouter, ~0,06 $ par appel) de décrire la voix.
# Usage : listen-call.sh <callId> [dossier de sortie]. Nécessite ssh sokar, ffmpeg et OPENROUTER_API_KEY dans apps/api/.env.
set -euo pipefail
CALL_ID="${1:?callId}"; OUT="${2:-$(mktemp -d)}"; HERE="$(cd "$(dirname "$0")" && pwd)"
[[ "$CALL_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "callId invalide" >&2; exit 1; }
KEY=$(ssh sokar "cd /opt/sokar/apps/api && set -a && . ./.env >/dev/null 2>&1; psql \"\${DATABASE_URL%%\\?*}\" -At -c \"select recording_storage_key from calls where id='$CALL_ID' and recording_status='AVAILABLE'\"")
[ -n "$KEY" ] || { echo "pas d'enregistrement disponible" >&2; exit 1; }
ssh sokar "cd /opt/sokar/apps/api && timeout 60 node -e '
const {S3Client,GetObjectCommand}=require(\"@aws-sdk/client-s3\");require(\"dotenv\").config({path:\".env\"});const e=process.env;
new S3Client({region:\"auto\",endpoint:e.CALL_RECORDINGS_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:e.CALL_RECORDINGS_ACCESS_KEY_ID,secretAccessKey:e.CALL_RECORDINGS_SECRET_ACCESS_KEY}})
.send(new GetObjectCommand({Bucket:e.CALL_RECORDINGS_BUCKET,Key:\"$KEY\"})).then(async r=>{process.stdout.write(Buffer.from(await r.Body.transformToByteArray()),()=>process.exit(0))}).catch(x=>{console.error(x.message);process.exit(1)})'" > "$OUT/call.mp3"
# stéréo : appelant à gauche, agent à droite (cf. call-report/energy.ts)
ffmpeg -v error -y -i "$OUT/call.mp3" -af "pan=mono|c0=c1" -ar 16000 "$OUT/agent.wav"
echo "Pauses de l'agent (>=120 ms) :"
ffmpeg -hide_banner -i "$OUT/agent.wav" -af silencedetect=n=-45dB:d=0.12 -f null - 2>&1 | grep -E "silence_(start|end)" \
  | awk '/silence_start/{s=$5} /silence_end/{printf "%.1f→%.1f (%.2fs)\n", s, $5, $8}'
node "$HERE/judge.mjs" "$OUT/agent.wav" | tee "$OUT/verdict.txt"
