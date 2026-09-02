"""Domain model for the todo board."""
from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class Todo:
    id: int
    text: str
    done: bool = False

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Todo":
        return cls(id=int(data["id"]), text=str(data["text"]), done=bool(data.get("done", False)))


class TodoBoard:
    """All todo operations; persists through a :class:`TodoStorage`."""

    def __init__(self, storage) -> None:
        self.storage = storage
        self._items = [Todo.from_dict(d) for d in storage.load()]

    # -- queries ---------------------------------------------------------
    def list(self) -> list[dict]:
        return [t.to_dict() for t in self._items]

    def get(self, todo_id: int) -> dict | None:
        for t in self._items:
            if t.id == todo_id:
                return t.to_dict()
        return None

    # -- commands --------------------------------------------------------
    def add(self, text: str) -> dict:
        text = text.strip()
        new_id = max((t.id for t in self._items), default=0) + 1
        todo = Todo(id=new_id, text=text)
        self._items.append(todo)
        self.storage.save([t.to_dict() for t in self._items])
        return todo.to_dict()

    def toggle(self, todo_id: int) -> dict:
        for t in self._items:
            if t.id == todo_id:
                t.done = not t.done
                self.storage.save([x.to_dict() for x in self._items])
                return t.to_dict()
        raise KeyError(todo_id)

    def delete(self, todo_id: int) -> None:
        before = len(self._items)
        self._items = [t for t in self._items if t.id != todo_id]
        if len(self._items) == before:
            raise KeyError(todo_id)
        self.storage.save([t.to_dict() for t in self._items])
