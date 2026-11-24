#!/usr/bin/env python3
"""Analyse l'enregistrement d'un appel vocal, au-delà de la transcription.

Récupère l'enregistrement privé (MP3 deux pistes : appelant à gauche, agent à
droite) depuis le VPS, qui seul détient les accès au stockage, puis mesure ce
que la transcription ne montre pas : silences réellement perçus par
l'appelant, chevauchements (l'agent coupe l'appelant, ou l'inverse), niveau de
bruit, saturation. Produit aussi un spectrogramme des deux pistes.

L'audio est une donnée personnelle : il est écrit hors du dépôt
(`$TMPDIR/sokar-call-audio/<appel>` par défaut) et n'est jamais commité. Les
enregistrements n'existent que pour les restaurants de
CALL_RECORDING_TEST_RESTAURANT_IDS et expirent après 30 jours au plus.

Usage :
  python3 scripts/ops/voice_call_audio.py latest --restaurant <id>
  python3 scripts/ops/voice_call_audio.py <début-de-l-id-d-appel>
  python3 scripts/ops/voice_call_audio.py report <début-de-l-id-d-appel> [--json]
  python3 scripts/ops/voice_call_audio.py report --day AAAA-MM-JJ [--restaurant <id>]
La commande `report` affiche le rapport automatique stocké à côté de l'enregistrement (voir
docs/runbooks/call-reports.md), ou le résumé d'une journée. Les autres commandes mesurent
l'enregistrement en local.
Options : --host deploy@suppernote  --out <dossier>  --no-fetch (réanalyse)
          --listen : fait écouter les deux pistes par un modèle audio (OpenRouter,
          clé lue sur le VPS, ~1 centime par appel) : ce qui a été réellement dit,
          ton de l'appelant, diction de l'agent, incompréhensions.
Dépendances locales : ffmpeg, numpy.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np

SAMPLE_RATE = 8000
FRAME_MS = 20
CHANNELS = ("appelant", "agent")

# Exécuté sur le VPS depuis /opt/suppernote/apps/api (code compilé déjà déployé).
REMOTE_FETCH = r"""
const { db } = require('./dist/shared/db/client.js');
const { getPrivateRecording } = require('./dist/modules/voice/call-recording.service.js');
(async () => {
  // Avec `node -e`, les arguments suivent directement l'exécutable.
  const [selector, restaurantId] = process.argv.slice(1);
  const where = selector === 'latest'
    ? { restaurantId, recordingStatus: 'AVAILABLE' }
    : { id: { startsWith: selector } };
  const call = await db.call.findFirst({
    where,
    orderBy: { createdAt: 'desc' },
    select: { id: true, restaurantId: true, recordingStatus: true, recordingStorageKey: true,
              recordingStartedAt: true, createdAt: true, durationSec: true },
  });
  if (!call) { process.stderr.write('Appel introuvable\n'); process.exit(2); }
  if (call.recordingStatus !== 'AVAILABLE' || !call.recordingStorageKey) {
    process.stderr.write(`Enregistrement indisponible (${call.recordingStatus})\n`); process.exit(3);
  }
  const object = await getPrivateRecording(call.recordingStorageKey);
  const chunks = [];
  for await (const chunk of object.Body) chunks.push(chunk);
  const meta = { id: call.id, restaurantId: call.restaurantId, durationSec: call.durationSec,
                 createdAt: call.createdAt, recordingStartedAt: call.recordingStartedAt };
  const header = Buffer.from(JSON.stringify(meta) + '\n');
  process.stdout.write(Buffer.concat([header, ...chunks]), () => process.exit(0));
})().catch((err) => { process.stderr.write(String(err && err.message) + '\n'); process.exit(1); });
"""

# Dialogue par tour (route interne en lecture seule, jeton lu sur le VPS).
REMOTE_TURNS = r"""
NAME=SOKAR_VOICE_READ_TOKEN
T=$(sed -n "s/^${NAME}=//p" .env | head -1 | tr -d '"')
curl -sf -H "Authorization: Bearer $T" "http://127.0.0.1:4000/api/internal/voice/calls/$1"
"""


# Écoute par un modèle audio : les deux pistes mono arrivent en JSON sur stdin.
REMOTE_LISTEN = r"""
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { caller, agent, model } = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = `Tu écoutes un appel téléphonique enregistré entre un client (piste 1) et un agent vocal IA de restaurant (piste 2), en français. Les deux pistes sont alignées dans le temps.
Réponds en JSON strict :
{"caller": [{"t": secondes, "said": "transcription exacte mot à mot de ce que dit le client, sans corriger ni résumer", "tone": "ton du client"}],
 "agent": [{"t": secondes, "said": "ce que dit l'agent", "delivery": "débit, intonation, surjeu, voix robotique ou naturelle, pauses anormales"}],
 "agent_overall": "jugement global honnête : l'agent sonne-t-il humain ou robotique, et pourquoi, en citant des moments",
 "misunderstandings": ["moments où l'agent a mal compris ou mal enchaîné"]}`;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model, temperature: 0.2, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'text', text: 'Piste 1 : client' }, { type: 'input_audio', input_audio: { data: caller, format: 'mp3' } },
        { type: 'text', text: 'Piste 2 : agent' }, { type: 'input_audio', input_audio: { data: agent, format: 'mp3' } },
      ] }],
    }),
  });
  const body = await response.json();
  const out = { status: response.status, cost: body.usage?.cost, content: body.choices?.[0]?.message?.content, error: body.error };
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
})();
"""


# Rapport automatique d'un appel : lu dans le stockage privé, sur le VPS (code compilé déjà déployé).
REMOTE_REPORT = r"""
const { readStoredReport } = require('./dist/modules/voice/call-report/report-store.js');
(async () => {
  const [selector, format] = process.argv.slice(1);
  const text = await readStoredReport(selector, format);
  if (text === null) { process.stderr.write('Aucun rapport pour cet appel\n'); process.exit(2); }
  process.stdout.write(text, () => process.exit(0));
})().catch((err) => { process.stderr.write(String(err && err.message) + '\n'); process.exit(1); });
"""

REMOTE_DAILY = r"""
const { loadDailySummary } = require('./dist/modules/voice/call-report/report-store.js');
(async () => {
  const [day, restaurantId] = process.argv.slice(1);
  const text = await loadDailySummary(day, restaurantId === '-' ? undefined : restaurantId);
  process.stdout.write(text, () => process.exit(0));
})().catch((err) => { process.stderr.write(String(err && err.message) + '\n'); process.exit(1); });
"""


def stored_report(host: str, selector: str, as_json: bool) -> str:
    """Rapport automatique d'un appel (Markdown, ou JSON avec --json)."""
    out = run_remote(host, REMOTE_REPORT, [selector, "json" if as_json else "markdown"], node=True)
    return out.decode()


def daily_summary(host: str, day: str, restaurant: str | None) -> str:
    """Résumé d'une journée (jour local de Paris) : appels, silences, divergences, abandons."""
    return run_remote(host, REMOTE_DAILY, [day, restaurant or "-"], node=True).decode()


def listen(host: str, folder: Path, model: str) -> dict:
    """Fait écouter les deux pistes par un modèle audio ; la clé reste sur le VPS."""
    payload = {"model": model}
    for channel, key in ((0, "caller"), (1, "agent")):
        mono = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(folder / "call.mp3"), "-af", f"pan=mono|c0=c{channel}",
             "-ar", "16000", "-b:a", "48k", "-f", "mp3", "-"],
            capture_output=True, check=True,
        ).stdout
        payload[key] = base64.b64encode(mono).decode()
    remote = "/opt/suppernote/apps/api/.voice-listen.cjs"
    subprocess.run(["ssh", host, f"cat > {remote}"], input=REMOTE_LISTEN.encode(), check=True)
    try:
        result = subprocess.run(
            ["ssh", host, f"cd /opt/suppernote/apps/api && node --env-file=.env {remote}"],
            input=json.dumps(payload).encode(), capture_output=True, check=True,
        )
    finally:
        subprocess.run(["ssh", host, f"rm -f {remote}"], check=False)
    raw = json.loads(result.stdout)
    content = (raw.get("content") or "").strip().removeprefix("```json").removesuffix("```")
    heard = json.loads(content) if raw.get("status") == 200 and content else {"error": raw.get("error")}
    heard["_cost_usd"] = raw.get("cost")
    heard["_model"] = model
    (folder / "listen.json").write_text(json.dumps(heard, ensure_ascii=False, indent=1))
    return heard


def run_remote(host: str, script: str, args: list[str], node: bool) -> bytes:
    remote_cmd = (
        "cd /opt/suppernote/apps/api && "
        + ("node --env-file=.env -e \"$(cat)\" " if node else "bash -s -- ")
        + " ".join(args)
    )
    result = subprocess.run(
        ["ssh", host, remote_cmd], input=script.encode(), capture_output=True, check=False
    )
    if result.returncode != 0:
        noise = result.stderr.decode(errors="replace").strip().splitlines()
        message = [line for line in noise if '"level":30' not in line][-3:]
        raise SystemExit(f"Échec côté VPS : {' / '.join(message) or result.returncode}")
    return result.stdout


def fetch(host: str, selector: str, restaurant: str | None, out_root: Path) -> Path:
    if selector == "latest" and not restaurant:
        raise SystemExit("« latest » demande --restaurant <id>.")
    raw = run_remote(host, REMOTE_FETCH, [selector, restaurant or "-"], node=True)
    header, _, audio = raw.partition(b"\n")
    meta = json.loads(header)
    folder = out_root / meta["id"][:8]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "call.mp3").write_bytes(audio)
    try:
        turns = json.loads(run_remote(host, REMOTE_TURNS, [meta["id"]], node=False))
        meta["turns"] = turns.get("turns", [])
    except (SystemExit, json.JSONDecodeError):
        meta["turns"] = []
    (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    return folder


def decode_channel(mp3: Path, channel: int) -> np.ndarray:
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(mp3), "-af", f"pan=mono|c0=c{channel}",
         "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def speech_segments(samples: np.ndarray) -> tuple[list[tuple[float, float]], dict]:
    """Détection d'énergie : seuil adaptatif au bruit de fond de la piste."""
    frame = SAMPLE_RATE * FRAME_MS // 1000
    count = len(samples) // frame
    frames = samples[: count * frame].reshape(count, frame)
    rms = np.sqrt(np.mean(frames**2, axis=1)) + 1e-9
    db = 20 * np.log10(rms)
    floor = float(np.percentile(db, 10))
    threshold = max(floor + 10.0, -50.0)
    active = db > threshold
    segments: list[list[float]] = []
    start = None
    for index, on in enumerate(active):
        if on and start is None:
            start = index
        elif not on and start is not None:
            segments.append([start * FRAME_MS / 1000, index * FRAME_MS / 1000])
            start = None
    if start is not None:
        segments.append([start * FRAME_MS / 1000, count * FRAME_MS / 1000])
    merged: list[list[float]] = []
    for segment in segments:  # une pause < 350 ms reste dans la même prise de parole
        if merged and segment[0] - merged[-1][1] < 0.35:
            merged[-1][1] = segment[1]
        else:
            merged.append(segment)
    kept = [(round(a, 2), round(b, 2)) for a, b in merged if b - a >= 0.15]
    speech_db = db[active]
    stats = {
        "noise_floor_dbfs": round(floor, 1),
        "speech_level_dbfs": round(float(np.percentile(speech_db, 50)), 1) if speech_db.size else None,
        "clipped_ratio": round(float(np.mean(np.abs(samples) >= 0.99)), 5),
    }
    return kept, stats


def spectrogram(mp3: Path, folder: Path, duration: float) -> Path:
    width = int(min(4000, max(1200, duration * 30)))
    target = folder / "spectrogram.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(mp3), "-lavfi",
         f"showspectrumpic=s={width}x400:mode=separate:legend=1:color=intensity:scale=log",
         str(target)],
        check=True,
    )
    return target


def recording_offset(meta: dict, iso: str | None) -> float | None:
    if not iso or not meta.get("recordingStartedAt"):
        return None
    start = datetime.fromisoformat(meta["recordingStartedAt"].replace("Z", "+00:00"))
    return round((datetime.fromisoformat(iso.replace("Z", "+00:00")) - start).total_seconds(), 2)


def report(folder: Path) -> str:
    meta = json.loads((folder / "meta.json").read_text())
    mp3 = folder / "call.mp3"
    tracks = {}
    for channel, name in enumerate(CHANNELS):
        segments, stats = speech_segments(decode_channel(mp3, channel))
        tracks[name] = {"segments": segments, **stats}
    duration = max((s[1] for t in tracks.values() for s in t["segments"]), default=0.0)
    image = spectrogram(mp3, folder, duration)

    events = sorted(
        [(a, b, name) for name, t in tracks.items() for a, b in t["segments"]],
        key=lambda item: item[0],
    )
    lines = [
        f"# Appel {meta['id'][:8]} — écoute instrumentée",
        f"Enregistrement démarré {meta.get('recordingStartedAt')} (l'accueil peut le précéder). "
        f"Durée analysée : {duration:.1f} s.",
        "",
        "| Piste | Bruit de fond | Niveau de parole | Saturation |",
        "|---|---|---|---|",
    ]
    for name, t in tracks.items():
        lines.append(
            f"| {name} | {t['noise_floor_dbfs']} dBFS | {t['speech_level_dbfs']} dBFS "
            f"| {t['clipped_ratio'] * 100:.2f} % |"
        )
    lines += ["", "## Chronologie (secondes depuis le début de l'enregistrement)", ""]
    lines += ["| Début | Fin | Qui | Remarque |", "|---|---|---|---|"]
    last_caller_end = None
    for index, (start, end, name) in enumerate(events):
        notes = []
        overlap = [
            other for other in events
            if other[2] != name and other[0] < start < other[1]
        ]
        if overlap:
            other = overlap[0]
            notes.append(
                f"commence pendant que l'{other[2]} parle ({other[1] - start:.1f} s de chevauchement)"
            )
        if name == "agent" and last_caller_end is not None and start >= last_caller_end:
            notes.append(f"silence perçu : {start - last_caller_end:.2f} s")
        if name == "appelant":
            last_caller_end = end
        elif start >= (last_caller_end or 0):
            last_caller_end = None
        lines.append(f"| {start:.2f} | {end:.2f} | {name} | {'; '.join(notes)} |")

    if meta.get("turns"):
        lines += ["", "## Tours transcrits, recalés sur l'enregistrement", ""]
        for turn in meta["turns"]:
            at = recording_offset(meta, turn.get("speechEndAt"))
            where = f"fin de parole ≈ {at:.2f} s" if at is not None else "position inconnue"
            lines.append(f"- #{turn['sequence']} ({where}) « {turn.get('callerText') or ''} »"
                         f" → « {turn.get('agentText') or ''} »")
    heard_path = folder / "listen.json"
    if heard_path.exists():
        heard = json.loads(heard_path.read_text())
        lines += ["", f"## Écoute par modèle audio ({heard.get('_model')}, {heard.get('_cost_usd')} $)", ""]
        if heard.get("error"):
            lines.append(f"Écoute impossible : {heard['error']}")
        lines += ["Ce que dit réellement l'appelant (à comparer aux tours transcrits) :", ""]
        for item in heard.get("caller", []):
            lines.append(f"- ~{item.get('t')} s « {item.get('said')} » — {item.get('tone')}")
        lines += ["", "Diction de l'agent :", ""]
        for item in heard.get("agent", []):
            lines.append(f"- ~{item.get('t')} s « {item.get('said')} » — {item.get('delivery')}")
        if heard.get("agent_overall"):
            lines += ["", f"Jugement global : {heard['agent_overall']}"]
        for item in heard.get("misunderstandings", []):
            lines.append(f"- Incompréhension : {item}")
        lines += ["", "Les horodatages du modèle audio sont approximatifs ; la chronologie ci-dessus fait foi."]
    lines += ["", f"Spectrogramme : {image}", f"Audio (privé, hors dépôt) : {mp3}"]
    text = "\n".join(lines) + "\n"
    (folder / "report.md").write_text(text)
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("call", help="début de l'id d'appel, « latest », ou « report »")
    parser.add_argument("report_target", nargs="?", help="avec « report » : début de l'id d'appel")
    parser.add_argument("--day", help="avec « report » : résumé de la journée AAAA-MM-JJ (heure de Paris)")
    parser.add_argument("--json", action="store_true", help="avec « report » : le JSON plutôt que le Markdown")
    parser.add_argument("--restaurant", help="restaurant (obligatoire avec latest)")
    parser.add_argument("--host", default=os.environ.get("SOKAR_SSH_HOST", "deploy@suppernote"))
    parser.add_argument("--out", type=Path,
                        default=Path(tempfile.gettempdir()) / "sokar-call-audio")
    parser.add_argument("--no-fetch", action="store_true", help="réanalyse un dossier déjà récupéré")
    parser.add_argument("--listen", action="store_true", help="écoute par un modèle audio (~1 centime)")
    parser.add_argument("--listen-model", default="google/gemini-3.8-flash")
    args = parser.parse_args()
    if args.call == "report":
        if args.day:
            sys.stdout.write(daily_summary(args.host, args.day, args.restaurant))
        elif args.report_target:
            sys.stdout.write(stored_report(args.host, args.report_target, args.json))
        else:
            raise SystemExit("« report » demande un début d'id d'appel, ou --day AAAA-MM-JJ.")
        return
    if args.no_fetch:
        folder = args.out / args.call[:8]
    else:
        folder = fetch(args.host, args.call, args.restaurant, args.out)
    if args.listen:
        listen(args.host, folder, args.listen_model)
    sys.stdout.write(report(folder))


if __name__ == "__main__":
    main()
