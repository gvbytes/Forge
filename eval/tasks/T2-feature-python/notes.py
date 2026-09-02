#!/usr/bin/env python3
"""notes — a tiny markdown notes CLI.

Usage:
    notes [--root DIR] add TITLE [--body TEXT]
    notes [--root DIR] list
    notes [--root DIR] show ID
    notes [--root DIR] rm ID

Notes are plain ``.md`` files inside the notes home (``--root``, the
``NOTES_HOME`` environment variable, or ``~/.notes``).
"""
from __future__ import annotations

import argparse
import sys

import noteslib


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="notes", description="tiny markdown notes CLI")
    parser.add_argument("--root", default=None, help="notes directory (default: $NOTES_HOME or ~/.notes)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="create a note")
    p_add.add_argument("title")
    p_add.add_argument("--body", default="", help="markdown body text")

    sub.add_parser("list", help="list note titles by id")

    p_show = sub.add_parser("show", help="print one note's markdown")
    p_show.add_argument("id", type=int)

    p_rm = sub.add_parser("rm", help="delete a note")
    p_rm.add_argument("id", type=int)

    return parser


def main(argv: list[str] | None = None) -> int:
    ns = build_parser().parse_args(argv)
    root = ns.root

    if ns.cmd == "add":
        note_id = noteslib.create_note(root, ns.title, ns.body)
        print(f"created note {note_id}")
        return 0

    if ns.cmd == "list":
        for note in noteslib.list_notes(root):
            print(f"{note['id']:>4}  {note['title']}")
        return 0

    if ns.cmd == "show":
        note = noteslib.read_note(root, ns.id)
        if note is None:
            print(f"note {ns.id} not found", file=sys.stderr)
            return 1
        print(note["body"], end="" if note["body"].endswith("\n") else "\n")
        return 0

    if ns.cmd == "rm":
        if noteslib.delete_note(root, ns.id):
            print(f"deleted note {ns.id}")
            return 0
        print(f"note {ns.id} not found", file=sys.stderr)
        return 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
