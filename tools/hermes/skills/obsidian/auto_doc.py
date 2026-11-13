"""
auto_doc — Obsidian auto-documentation helpers for Suppernote.

Usage:
    from tools.hermes.skills.obsidian.auto_doc import (
        update_context,
        add_decision,
        link_notes,
        detect_module_from_task,
    )
"""
from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

def find_sokar_root() -> Path:
    current = Path(__file__).resolve().parent
    for parent in [current] + list(current.parents):
        if (parent / "package.json").exists() and (parent / "pnpm-workspace.yaml").exists():
            return parent
    return Path(os.environ.get("SOKAR_ROOT", str(Path.home() / "Projects" / "Sokar")))

SOKAR_ROOT = find_sokar_root()
CONTEXT_PATH = SOKAR_ROOT / "docs" / "obsidian" / "Context.md"
VAULT_PATH = SOKAR_ROOT / "docs" / "obsidian"


# ── Module detection ──


def detect_module_from_task(task_text: str) -> str:
    """Devine le module Suppernote concerne a partir du texte d'une tache.

    Priorite:
      apps/api > apps/dashboard > packages/database > packages/voice > agent > docs > general

    Args:
        task_text: Description de la tache (ex: 'Ajouter Zod validation aux routes API').

    Returns:
        Nom du module : api, dashboard, database, voice, agent, docs, ou general.
    """
    patterns: list[tuple[str, str]] = [
        # Chemins explicites (priorite haute)
        (r"apps/api/", "api"),
        (r"apps/dashboard/", "dashboard"),
        (r"packages/database/", "database"),
        (r"packages/voice/", "voice"),
        (r"agent/", "agent"),
        (r"docs/", "docs"),
        # Mots-cles specifiques (voice avant api car telnyx est surtout voix)
        (r"\b(?:voice|call|stt|tts|elevenlabs|cartesia|telnyx)\b", "voice"),
        (r"\b(?:api|route|endpoint|fastify|webhook)\b", "api"),
        (r"\b(?:dashboard|ui|component|next\.?js|tailwind|page)\b", "dashboard"),
        (r"\b(?:prisma|schema|model|migration|db|database|pgvector)\b", "database"),
        (r"\b(?:hermes|agent|skill|mcp)\b", "agent"),
        (r"\b(?:doc|readme|obsidian|context|journal)\b", "docs"),
    ]
    for pattern, label in patterns:
        if re.search(pattern, task_text, re.IGNORECASE):
            return label
    return "general"


# ── Context.md helpers ──


_SECTION_RE = re.compile(r"^## .+", re.MULTILINE)


def _normalize(text: str) -> str:
    """Strip accents, lower-case, and collapse whitespace for comparison."""
    import unicodedata
    nfkd = unicodedata.normalize("NFKD", text)
    return nfkd.encode("ascii", "ignore").decode("ascii").lower().strip()


def _ensure_context_md() -> None:
    """Cree Context.md avec les sections minimales si inexistant."""
    CONTEXT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CONTEXT_PATH.exists():
        CONTEXT_PATH.write_text(
            "# Contexte Suppernote\n\n"
            "## Dernière activité\n\n\n"
            "## Décisions récentes\n\n\n"
            "## TODOs actifs\n\n\n"
            "## Liens rapides\n\n\n",
            encoding="utf-8",
        )


def _find_section_boundaries(text: str, header: str) -> Optional[tuple[int, int, int]]:
    """Retourne (start_header, start_body, end_section) ou None si introuvable.

    La recherche ignore la casse et les accents (ex: 'activite' matche 'activite', 'activité').

    start_header : debut de '## Section'
    start_body   : debut du contenu apres le titre (sauts de ligne inclus)
    end_section  : debut de la section suivante ou len(text)
    """
    lines = text.splitlines(keepends=True)
    norm_header = _normalize(header)

    header_start = -1
    header_len = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("## ") and _normalize(stripped) == norm_header:
            header_start = sum(len(l) for l in lines[:i])
            header_len = len(line.rstrip("\n\r"))
            break

    if header_start == -1:
        return None

    body_start = header_start + header_len
    while body_start < len(text) and text[body_start] in ("\n", "\r", " "):
        body_start += 1

    # section suivante = prochain '## ' (pas de sous-section '###')
    end = len(text)
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("## ") and not stripped.startswith("### "):
            line_start = sum(len(l) for l in lines[:lines.index(line)])
            if line_start > header_start:
                end = line_start
                break

    return (header_start, body_start, end)


def update_context(activity_summary: str) -> None:
    """Met a jour la section '## Derniere activite' de Context.md.

    Ajoute un timestamp ISO + le resume fourni.

    Args:
        activity_summary: Resume de l'activite a enregistrer.
    """
    _ensure_context_md()

    text = CONTEXT_PATH.read_text(encoding="utf-8")
    header = "## Dernière activité"
    bounds = _find_section_boundaries(text, header)

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    new_block = f"{now} — {activity_summary.strip()}"

    if bounds is None:
        # Section absente → ajouter a la fin
        text = text.rstrip() + f"\n\n{header}\n\n{new_block}\n"
    else:
        _start_h, body_start, end = bounds
        # Si la section suivante est directement apres, insérer un blank line
        prefix = "\n\n" if end < len(text) and not text[end : end + 1] == "\n" else "\n"
        text = text[:body_start] + new_block + prefix + text[end:]

    CONTEXT_PATH.write_text(text, encoding="utf-8")


def add_decision(decision_text: str) -> None:
    """Ajoute une decision en haut de la section '## Decisions recentes'.

    Les decisions sont listees sous forme de bullet points, la plus recente en premier.

    Args:
        decision_text: Texte de la decision a ajouter.
    """
    _ensure_context_md()

    text = CONTEXT_PATH.read_text(encoding="utf-8")
    header = "## Décisions récentes"
    bounds = _find_section_boundaries(text, header)

    now = datetime.now().strftime("%Y-%m-%d")
    new_entry = f"- **{now}** — {decision_text.strip()}"

    if bounds is None:
        text = text.rstrip() + f"\n\n{header}\n\n{new_entry}\n"
    else:
        _start_h, body_start, end = bounds
        existing = text[body_start:end].strip()
        if existing:
            new_block = new_entry + "\n" + existing
        else:
            new_block = new_entry
        # Si la section suivante est directement apres, insérer un blank line
        prefix = "\n\n" if end < len(text) and not text[end : end + 1] == "\n" else "\n"
        text = text[:body_start] + new_block + prefix + text[end:]

    CONTEXT_PATH.write_text(text, encoding="utf-8")


# ── Note linking ──


def _read_note(path: str) -> Optional[tuple[Path, str]]:
    """Lit une note du vault par chemin relatif ou nom (sans ou avec .md).

    Retourne (path_resolu, contenu) ou None si introuvable.
    """
    if not path.endswith(".md"):
        path += ".md"

    candidate = VAULT_PATH / path
    if candidate.is_file():
        return (candidate, candidate.read_text(encoding="utf-8"))

    # Fallback : chercher par nom dans tout le vault
    for f in VAULT_PATH.rglob("*.md"):
        if f.name.lower() == candidate.name.lower() and ".obsidian" not in f.parts:
            return (f, f.read_text(encoding="utf-8"))

    return None


def link_notes(source: str, target: str) -> str:
    """Ajoute un wikilink [[target]] a la fin d'une note source si inexistant.

    Args:
        source: Nom ou chemin relatif de la note source (ex: 'Architecture' ou 'Sprint 1.md').
        target: Nom de la note cible (ex: 'Context').

    Returns:
        Message de confirmation ou d'erreur.
    """
    result = _read_note(source)
    if result is None:
        return f"[ERROR] Note source introuvable : {source}"

    src_path, content = result
    clean_target = target.replace(".md", "").strip()
    wikilink = f"[[{clean_target}]]"

    if wikilink in content:
        return f"[OK] Le lien {wikilink} existe deja dans {src_path.name}."

    # Ajouter a la fin avec un saut de ligne
    new_content = content.rstrip() + f"\n{wikilink}\n"
    src_path.write_text(new_content, encoding="utf-8")
    return f"[OK] Lien {wikilink} ajoute a {src_path.name}."


# ── Entry point ──

if __name__ == "__main__":
    import sys

    USAGE = (
        "Usage: python auto_doc.py <command> [args...]\n"
        "Commands:\n"
        "  update_context <summary>         — Met a jour ## Derniere activite\n"
        "  add_decision <text>              — Ajoute une decision dans ## Decisions recentes\n"
        "  link_notes <source> <target>    — Ajoute [[target]] dans source si absent\n"
        "  detect <task_text>              — Devine le module pour une tache"
    )

    if len(sys.argv) < 2:
        print(USAGE)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "update_context" and len(sys.argv) > 2:
        update_context(sys.argv[2])
        print("Context mis a jour.")
    elif cmd == "add_decision" and len(sys.argv) > 2:
        add_decision(sys.argv[2])
        print("Decision ajoutee.")
    elif cmd == "link_notes" and len(sys.argv) > 3:
        print(link_notes(sys.argv[2], sys.argv[3]))
    elif cmd == "detect" and len(sys.argv) > 2:
        print(detect_module_from_task(sys.argv[2]))
    else:
        print(USAGE)
        sys.exit(1)
