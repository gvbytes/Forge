"""Core library for the notes CLI.

Notes live in a *notes home* directory (``--root``, ``$NOTES_HOME``, or
``~/.notes``). Each note is a standalone markdown file named
``NNN-<slug>.md``; ``meta.json`` keeps the id -> file mapping and the
next free id.
"""
from __future__ import annotations

import json
import os
import re

NOTES_HOME_ENV = "NOTES_HOME"


def home(root: str | None = None) -> str:
    """Resolve the notes home directory."""
    if root:
        return os.path.abspath(root)
    base = os.environ.get(NOTES_HOME_ENV) or os.path.join(os.path.expanduser("~"), ".notes")
    return os.path.abspath(base)


def _meta_path(root: str | None) -> str:
    return os.path.join(home(root), "meta.json")


def _load_meta(root: str | None) -> dict:
    try:
        with open(_meta_path(root), encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {"next_id": 1, "notes": {}}


def _save_meta(root: str | None, meta: dict) -> None:
    os.makedirs(home(root), exist_ok=True)
    with open(_meta_path(root), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "note"


def create_note(root: str | None, title: str, body: str = "") -> int:
    """Write a new markdown note and register it; returns its id."""
    h = home(root)
    os.makedirs(h, exist_ok=True)
    meta = _load_meta(root)
    note_id = int(meta["next_id"])
    meta["next_id"] = note_id + 1
    fname = f"{note_id:03d}-{slugify(title)}.md"
    with open(os.path.join(h, fname), "w", encoding="utf-8") as fh:
        fh.write(f"# {title}\n\n{body.strip()}\n")
    meta["notes"][str(note_id)] = {"file": fname, "title": title}
    _save_meta(root, meta)
    return note_id


def _entry(meta: dict, note_id: int) -> dict | None:
    entry = meta["notes"].get(str(note_id))
    if entry is not None:
        entry = dict(entry)
        entry["id"] = note_id
    return entry


def list_notes(root: str | None) -> list[dict]:
    """All notes ordered by id."""
    meta = _load_meta(root)
    entries = []
    for key in sorted(meta["notes"], key=int):
        entry = _entry(meta, int(key))
        if entry:
            entries.append(entry)
    return entries


def read_note(root: str | None, note_id: int) -> dict | None:
    """A single note with its full markdown body (or None)."""
    meta = _load_meta(root)
    entry = _entry(meta, note_id)
    if entry is None:
        return None
    path = os.path.join(home(root), entry["file"])
    try:
        with open(path, encoding="utf-8") as fh:
            entry["body"] = fh.read()
    except FileNotFoundError:
        return None
    return entry


def delete_note(root: str | None, note_id: int) -> bool:
    """Remove a note (file + index entry). True when it existed."""
    meta = _load_meta(root)
    entry = _entry(meta, note_id)
    if entry is None:
        return False
    path = os.path.join(home(root), entry["file"])
    if os.path.exists(path):
        os.remove(path)
    del meta["notes"][str(note_id)]
    _save_meta(root, meta)
    return True
