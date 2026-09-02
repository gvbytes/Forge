"""Behavioural tests for the todo app.

The persistence regression under test: users report that todos vanish
once they add a second item. Run with `pytest -q`.
"""
import json

import pytest

from app import create_app
from models import TodoBoard
from storage import TodoStorage


@pytest.fixture()
def db_path(tmp_path):
    return str(tmp_path / "todos.json")


def fresh_board(db_path):
    """A brand-new process-equivalent view of the database on disk."""
    return TodoBoard(TodoStorage(db_path))


def test_empty_board_lists_nothing(db_path):
    assert fresh_board(db_path).list() == []


def test_add_assigns_sequential_ids(db_path):
    board = fresh_board(db_path)
    first = board.add("write eval harness")
    second = board.add("profile the runner")
    assert (first["id"], second["id"]) == (1, 2)


def test_single_todo_survives_storage_roundtrip(db_path):
    board = fresh_board(db_path)
    board.add("write eval harness")
    again = fresh_board(db_path)
    assert [t["text"] for t in again.list()] == ["write eval harness"]


def test_toggle_and_delete_same_session(db_path):
    board = fresh_board(db_path)
    todo = board.add("ship it")
    board.toggle(todo["id"])
    reloaded = fresh_board(db_path)
    assert reloaded.list() == [{"id": 1, "text": "ship it", "done": True}]
    reloaded.delete(1)
    assert fresh_board(db_path).list() == []


def test_second_todo_keeps_the_first(db_path):
    board = fresh_board(db_path)
    board.add("first")
    board.add("second")
    texts = [t["text"] for t in fresh_board(db_path).list()]
    assert texts == ["first", "second"]


def test_many_adds_all_persist(db_path):
    board = fresh_board(db_path)
    for i in range(4):
        board.add(f"todo {i}")
    with open(db_path, encoding="utf-8") as fh:
        stored = json.load(fh)
    assert [t["text"] for t in stored] == [f"todo {i}" for i in range(4)]


def test_index_page_lists_every_todo(db_path):
    app = create_app(db_path)
    app.handle_request("POST", "/api/todos", json.dumps({"text": "alpha"}).encode())
    app.handle_request("POST", "/api/todos", json.dumps({"text": "beta"}).encode())
    # A fresh app instance reads the page like a user reloading the browser.
    page = create_app(db_path).handle_request("GET", "/").body
    assert "alpha" in page and "beta" in page


def test_api_create_then_reload_via_api(db_path):
    app = create_app(db_path)
    resp = app.handle_request("POST", "/api/todos", json.dumps({"text": "gamma"}).encode())
    assert resp.status == 201
    reloaded = create_app(db_path)
    body = reloaded.handle_request("POST", "/api/todos", json.dumps({"text": "delta"}).encode())
    listing = reloaded.handle_request("GET", "/api/todos")
    items = json.loads(listing.body)
    assert body.status == 201
    assert [t["text"] for t in items] == ["gamma", "delta"]
