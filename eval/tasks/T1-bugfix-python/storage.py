"""JSON-file persistence for todos.

The board stores its items as a JSON array of ``{"id", "text", "done"}``
objects. Set ``TODO_DB`` to override the database location (handy for
tests); the default lives in ``data/todos.json`` next to the app.
"""
from __future__ import annotations

import json
import os


class TodoStorage:
    """Load/save the todo list from a single JSON file."""

    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.environ.get(
            "TODO_DB",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "todos.json"),
        )
        self._flushed = 0  # number of items already persisted

    def load(self) -> list[dict]:
        """Return the persisted todos (``[]`` when nothing is stored yet)."""
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return []
        return data if isinstance(data, list) else []

    def save(self, items: list[dict]) -> None:
        """Persist the current todo list (incremental flush)."""
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        pending = items[self._flushed:]  # only the not-yet-written tail
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(pending, fh, indent=2)
        self._flushed = len(items)
