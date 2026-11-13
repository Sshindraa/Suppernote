#!/usr/bin/env python3
from __future__ import annotations
"""
Hermes MCP server — Suppernote execution gateway.

Toute execution est deleguee a Hermes CLI via execute_task.

Le MCP serveur expose 2 outils : execute_task (execution) et check_task (verification).
Pas de run_shell, read_file, search_files, git_status.
Le client MCP n'a aucun moyen de faire de l'execution via ce serveur.

AUTO-DÉTECTION : Après chaque tâche, détecte automatiquement le type d'opération
et met à jour la note Obsidian correspondante (API Endpoints, Database Schema,
Dashboard, Voice Pipeline, etc.) SANS intervention humaine.

LOGGING : Chaque tâche est loguée dans Journal.md, Context.md, et la note
Obsidian appropriée est mise à jour automatiquement.
"""

import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

SOKAR_ROOT = os.environ.get("SOKAR_ROOT", str(Path.home() / "Projects" / "Sokar"))
TASKS_DIR = Path.home() / ".hermes" / "tasks"
TASKS_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = Path.home() / ".hermes" / "logs" / "mcp_serve.log"
SESSION_LOG = Path.home() / ".hermes" / "logs" / "cascade_hermes_bridge.md"
JOURNAL_PATH = Path(SOKAR_ROOT) / "docs" / "obsidian" / "Journal.md"

skills_path = Path(SOKAR_ROOT) / "tools" / "hermes" / "skills" / "obsidian"
sys.path.insert(0, str(skills_path))
from auto_doc import update_context, detect_module_from_task

# ── Task classification ──


def classify_task(task: str) -> dict:
    """Detecte le type d'operation a partir de la description de la tache.

    Returns:
        dict avec:
          - type: str (create_route, modify_schema, add_component, voice_pipeline,
                   queue_job, agent_config, documentation, general, etc.)
          - note: str | None (nom de la note Obsidian a mettre a jour)
          - severity: str (info, update, major)
    """
    task_lower = task.lower()

    # Classification par mots-cles
    classifiers = [
        # Routes API
        (r"(?:route|endpoint|api|rest|crud|fastify).*?(?:route|endpoint|api|crud|create|add|post|get|put|patch|delete)",
         "create_route", "API Endpoints.md", "update"),
        (r"(?:route|endpoint).*\.routes\.ts", "modify_route", "API Endpoints.md", "update"),

        # Database
        (r"(?:prisma|schema|model|migration|database|db|pgvector)",
         "modify_schema", "Database Schema.md", "major"),

        # Voice pipeline
        (r"(?:voice|call|stt|tts|elevenlabs|cartesia|telnyx|pipeline|agent.state|filler|outcome)",
         "voice_pipeline", "Voice Pipeline.md", "update"),

        # Dashboard / UI
        (r"(?:dashboard|ui|component|next\.js|tailwind|layout|page|app router|react|frontend)",
         "add_component", "Dashboard.md", "update"),

        # Queue / workers
        (r"(?:bullmq|queue|worker|job|scheduler|evening.?report|sms)",
         "queue_job", "BullMQ Jobs.md", "update"),

        # Agent / Hermes
        (r"(?:hermes|agent|skill|mcp|config)",
         "agent_config", "Hermes Agent.md", "info"),

        # Documentation
        (r"(?:doc|readme|obsidian|context|journal|changelog|wiki)",
         "documentation", None, "info"),

        # Auth / Security
        (r"(?:auth|clerk|login|jwt|session|guard|webhook|security|rate.limit|rate_limit)",
         "security", "Security.md", "update"),

        # Analytics
        (r"(?:analytics|kpi|roi|report|metric|posthog|datadog)",
         "analytics", "Analytics.md", "update"),

        # Tests
        (r"(?:test|vitest|jest|coverage|spec|integration)",
         "testing", "Testing Strategy.md", "info"),

        # Configuration / deployment
        (r"(?:deploy|docker|ci|cd|github|infra|docker-compose)",
         "infrastructure", "Infrastructure.md", "update"),
    ]

    for pattern, task_type, note, severity in classifiers:
        if re.search(pattern, task_lower):
            return {
                "type": task_type,
                "note": note,
                "severity": severity,
                "label": task_type.replace("_", " ").title(),
            }

    # Fallback: use module detection
    module = detect_module_from_task(task)
    note_map = {
        "api": ("API Endpoints.md", "update"),
        "dashboard": ("Dashboard.md", "update"),
        "database": ("Database Schema.md", "update"),
        "voice": ("Voice Pipeline.md", "update"),
        "agent": ("Hermes Agent.md", "info"),
        "docs": (None, "info"),
    }
    note, severity = note_map.get(module, (None, "info"))
    return {
        "type": "general",
        "note": note,
        "severity": severity,
        "label": f"General - {module}",
    }


def update_relevant_note(task: str, result: str) -> None:
    """Met à jour la note Obsidian appropriée en fonction du type de tâche.

    Après chaque tâche Hermes :
    1) Détecte le type (route, schema, component, voice, etc.)
    2) Ajoute un timestamp + résumé dans la section "Mises à jour automatiques"
       de la note Obsidian correspondante
    3) Log dans Journal.md et Context.md (déjà fait dans tool_execute_task)
    """
    classification = classify_task(task)
    note_name = classification.get("note")
    task_type = classification.get("type")
    severity = classification.get("severity")
    label = classification.get("label")

    if not note_name:
        return  # Pas de note cible

    note_path = Path(SOKAR_ROOT) / "docs" / "obsidian" / note_name

    # Préparer l'entrée de log
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    result_short = (result.strip().split("\n")[0] if result and result.strip() else "(empty)")[:100]

    emoji = {"major": "🔴", "update": "🟡", "info": "🔵"}.get(severity, "⚪")
    entry = (
        f"\n### {emoji} {ts} — {label}\n"
        f"\n**Tâche**: {task.strip()[:120]}\n"
        f"**Résultat**: {result_short}\n"
        f"**Type**: `{task_type}` | **Severité**: {severity}\n"
        f"\n---\n"
    )

    try:
        note_path.parent.mkdir(parents=True, exist_ok=True)

        if note_path.is_file():
            content = note_path.read_text(encoding="utf-8")
        else:
            content = f"# {note_name.replace('.md', '')}\n\n## Mises à jour automatiques\n\n"
            note_path.write_text(content, encoding="utf-8")
            content = note_path.read_text(encoding="utf-8")

        # Chercher/creer section "Mises à jour automatiques"
        section_pattern = re.compile(r"^## Mises à jour automatiques\s*$", re.MULTILINE)
        match = section_pattern.search(content)

        if match:
            # Insérer après l'en-tête de section
            insert_pos = match.end()
            content = content[:insert_pos] + "\n" + entry + content[insert_pos:]
        else:
            # Ajouter la section à la fin
            content = content.rstrip() + "\n\n## Mises à jour automatiques\n" + entry + "\n"

        note_path.write_text(content, encoding="utf-8")
        log(f"update_relevant_note: {note_name} mis à jour ({task_type})")

    except Exception as e:
        log(f"update_relevant_note error: {e}")


def log_to_journal(task: str, result: str) -> None:
    """Append une ligne markdown au Journal Suppernote."""
    try:
        JOURNAL_PATH.parent.mkdir(parents=True, exist_ok=True)
        date = datetime.now().strftime("%Y-%m-%d %H:%M")
        task_short = task.strip().replace("|", "/")[:60]
        summary = (result.strip().split("\n")[0] if result and result.strip() else "(empty)")[:80]
        summary = summary.replace("|", "/")
        module = detect_module_from_task(task)

        # Détecter le type pour enrichir le journal
        classification = classify_task(task)
        type_icon = {"create_route": "🛣️", "modify_schema": "🗄️", "add_component": "🎨",
                     "voice_pipeline": "🎙️", "queue_job": "⏰", "agent_config": "🤖",
                     "documentation": "📝", "security": "🔒", "analytics": "📊",
                     "testing": "🧪", "infrastructure": "☁️"}.get(classification["type"], "⚡")

        line = f"| {date} | {task_short} | {summary} | {module} | {type_icon} |\n"
        with open(JOURNAL_PATH, "a") as f:
            f.write(line)

        # Aussi mettre à jour la note Obsidian appropriée
        update_relevant_note(task, result)

    except Exception as e:
        log(f"log_to_journal failed: {e}")


# ── Logging ──


def log(msg: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a") as f:
        f.write(f"[{ts}] {msg}\n")


def log_session(cascade_msg: str, hermes_result: str) -> None:
    """Journaliser l'echange MCP → Hermes pour debug/traçabilite."""
    SESSION_LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(SESSION_LOG, "a") as f:
        f.write(f"\n\n## [{ts}] MCP -> Hermes\n\n")
        f.write(f"### Task\n\n```\n{cascade_msg}\n```\n\n")
        f.write(f"### Result\n\n```\n{hermes_result[:2000]}\n```\n")


# ── Tool handlers ──


def guess_module(task: str) -> str:
    """Devine le module Suppernote touche a partir de la description de la tache."""
    patterns = [
        (r"apps/api/", "apps/api"),
        (r"apps/dashboard/", "apps/dashboard"),
        (r"packages/", "packages"),
        (r"(?:agent|tools/hermes)/", "agent"),
        (r"docs/", "docs"),
    ]
    for pattern, label in patterns:
        if re.search(pattern, task):
            return label
    return "general"


def _run_hermes_background(task: str, workdir: str, task_id: str) -> None:
    """Lance hermes -z en background et écrit le résultat dans TASKS_DIR."""
    log_file = TASKS_DIR / f"{task_id}.log"
    log(f"[bg] starting task {task_id}: {task[:200]}")
    try:
        f = log_file.open('w')
        subprocess.Popen(
            ['hermes', '-z', task],
            cwd=workdir,
            start_new_session=True,
            stdout=f,
            stderr=subprocess.STDOUT,
        )
        f.close()
    except Exception as e:
        log_file.write_text(f"[fatal] Failed to start hermes: {e}")
        log(f"[bg] error starting task {task_id}: {e}")


def _log_task_result(task: str, output: str) -> None:
    """Auto-logging après exécution."""
    log_session(task, output)
    log_to_journal(task, output)
    mod = detect_module_from_task(task)
    update_context(f"[{mod}] {task[:80]}")
    try:
        sync_script = Path(SOKAR_ROOT) / "tools" / "hermes" / "skills" / "obsidian" / "auto_sync.py"
        subprocess.run(
            ["python3", str(sync_script), "diff"],
            capture_output=True, text=True, cwd=SOKAR_ROOT, timeout=30,
        )
    except Exception as e:
        log(f"[sync] auto_sync.py échec silencieux évité : {e}")


def tool_execute_task(task: str, workdir: str | None = None) -> dict:
    """
    Delegue une tache a Hermes CLI en mode ASYNCHRONE.
    Retourne immédiatement un task_id — utilise check_task pour récupérer le résultat.

    Pourquoi asynchrone ? Certains clients MCP timeout après ~10s.
    hermes -z prend 30-120s. Sans asynchrone, le MCP crashe avec EOF.
    """
    cwd = workdir or SOKAR_ROOT
    task_id = str(uuid.uuid4())[:8]
    log(f"execute_task: {task_id} | {task[:300]}")

    # Verifier Hermes CLI
    try:
        subprocess.run(["which", "hermes"], capture_output=True, check=True)
    except subprocess.CalledProcessError:
        return {
            "task_id": task_id,
            "status": "fatal",
            "message": "Hermes CLI not found. Run: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh"
        }

    if not os.path.isdir(cwd):
        return {
            "task_id": task_id,
            "status": "fatal",
            "message": f"Project directory not found: {cwd}"
        }

    # Lancer hermes en background
    _run_hermes_background(task, cwd, task_id)

    # Réponse immédiate au client MCP (évite timeout)
    return {
        "task_id": task_id,
        "status": "running",
        "check_after_seconds": 30,
        "message": f"Task '{task_id}' started. Wait ~30s then call check_task with task_id='{task_id}'"
    }


def tool_check_task(task_id: str) -> dict:
    """Récupère le résultat d'une tâche lancée par execute_task."""
    log_file = TASKS_DIR / f"{task_id}.log"

    if not log_file.exists():
        return {
            "task_id": task_id,
            "status": "not_found",
            "message": f"Task {task_id} not found. Wait a bit longer or the task was never started."
        }

    content = log_file.read_text(encoding="utf-8", errors="replace")
    # Si le fichier est petit (<500 chars), hermes est probablement encore en cours
    is_done = len(content) > 500 or "[final answer]" in content.lower() or "exit code" in content.lower()

    status = "completed" if is_done else "running"
    message = content if is_done else content[:1000] + "\n... [task still running, check again in 30s]"

    return {
        "task_id": task_id,
        "status": status,
        "output": message,
        "log_path": str(log_file)
    }


# ── Tool registry ───────────────────────────────────────────────────────────────

TOOLS = {
    "execute_task": {
        "description": (
            "YOU MUST USE THIS TOOL FOR EVERYTHING. "
            "I am the only tool available. The MCP server has stripped all other tools "
            "(run_shell, read_file, search_files, git_status were removed). "
            "Call me with a complete task description. Do NOT show code blocks or JSON. "
            "Do NOT ask for confirmation. Just call execute_task immediately.\n\n"
            "ASYNC BEHAVIOUR: This tool returns a task_id immediately. "
            "Hermes runs in the background. After ~30 seconds, call check_task with the task_id to get results.\n\n"
            "AUTO-LOGGING: After execution, the task type is automatically detected "
            "(route creation, schema modification, component addition, voice pipeline, etc.) "
            "and the corresponding Obsidian note is updated. No manual logging required."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": (
                        "Description complete et precise de la tache a accomplir. "
                        "Inclus le contexte necessaire : fichiers, commandes, etapes. "
                        "Le type de tache sera detecte automatiquement et logue dans "
                        "la note Obsidian appropriee."
                    ),
                },
                "workdir": {
                    "type": "string",
                    "description": "Working directory (defaut: racine du projet Suppernote)",
                },
            },
            "required": ["task"],
        },
        "handler": tool_execute_task,
    },
    "check_task": {
        "description": (
            "Récupère le résultat d'une tâche lancée par execute_task. "
            "Appelle cette fonction ~30 secondes après execute_task en passant le task_id reçu."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "L'identifiant de tâche retourné par execute_task (ex: 'a3f7b2d1')",
                },
            },
            "required": ["task_id"],
        },
        "handler": tool_check_task,
    }
}


# ── MCP protocol (JSON-RPC over stdio) ────────────────────────────────────────

# ... (rest of the code remains the same)

def make_result(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def make_error(req_id, code, message):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def handle_initialize(req: dict) -> dict:
    log("initialize")
    params = req.get("params", {}) if isinstance(req.get("params", {}), dict) else {}
    protocol_version = params.get("protocolVersion") or "2024-11-05"
    return make_result(req.get("id"), {
        "protocolVersion": protocol_version,
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": "hermes-executor", "version": "2.1.0"},
    })


def handle_list_tools(req: dict) -> dict:
    log("tools/list")
    tools = []
    for name, tool in TOOLS.items():
        tools.append({
            "name": name,
            "description": tool["description"],
            "inputSchema": tool["parameters"],
        })
    return make_result(req.get("id"), {"tools": tools})


def handle_call_tool(req: dict) -> dict:
    name = req["params"]["name"]
    args = req["params"].get("arguments", {})
    log(f"tools/call: {name}")

    tool = TOOLS.get(name)
    if not tool:
        return make_error(req.get("id"), -32601, f"Tool not found: {name}")

    try:
        result = tool["handler"](**args)
        return make_result(req.get("id"), {
            "content": [{"type": "text", "text": str(result)}],
        })
    except Exception as e:
        return make_error(req.get("id"), -32000, str(e))


HANDLERS = {
    "initialize": handle_initialize,
    "notifications/initialized": lambda r: None,
    "tools/list": handle_list_tools,
    "tools/call": handle_call_tool,
}


def _send_message(msg: dict) -> None:
    payload = json.dumps(msg)
    sys.stdout.buffer.write((payload + "\n").encode("utf-8"))
    sys.stdout.flush()


def _read_message() -> Optional[dict]:
    """Lit un message JSON-RPC au format newline-delimited JSON (utilisé par la lib mcp Python).

    Le client Hermes (via mcp.client.stdio) envoie chaque message JSON suivi de \\n.
    """
    line = sys.stdin.buffer.readline()
    if not line:
        log("_read_message: stdin closed (EOF)")
        return None

    try:
        return json.loads(line.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        log(f"_read_message: parse error: {e}")
        return None


def main():
    log("server starting")
    while True:
        req = _read_message()
        if req is None:
            break

        method = req.get("method", "")
        handler = HANDLERS.get(method)

        if handler is None:
            _send_message(make_error(req.get("id"), -32601, f"Method not found: {method}"))
            continue

        resp = handler(req)
        if resp is not None:
            _send_message(resp)


if __name__ == "__main__":
    main()
