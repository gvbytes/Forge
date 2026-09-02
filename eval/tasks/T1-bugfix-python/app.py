"""Tiny Flask-style todo webapp, standard library only.

Routes:
    GET    /                       HTML UI (templates/index.html)
    GET    /static/<file>          static assets
    GET    /api/todos              list todos
    POST   /api/todos              create a todo      {"text": "..."}
    POST   /api/todos/<id>/toggle  toggle done flag
    DELETE /api/todos/<id>         delete a todo

Run locally:  python3 app.py   ->   http://127.0.0.1:5000
"""
from __future__ import annotations

import html
import json
import mimetypes
import os
from pathlib import Path
from string import Template

from models import TodoBoard
from storage import TodoStorage

HERE = Path(__file__).resolve().parent
TEMPLATE_DIR = HERE / "templates"
STATIC_DIR = HERE / "static"


class Request:
    """Minimal request object (body bytes + lazy JSON)."""

    def __init__(self, body: bytes = b""):
        self.body = body

    @property
    def json(self):
        try:
            return json.loads(self.body.decode("utf-8") or "null")
        except ValueError:
            return None


class Response:
    def __init__(self, body="", status=200, content_type="text/html; charset=utf-8"):
        self.body = body
        self.status = status
        self.content_type = content_type


def json_response(payload, status=200) -> Response:
    return Response(json.dumps(payload), status=status, content_type="application/json")


def _match_rule(rule: str, path: str):
    """Return kwargs dict when *path* matches *rule*, else None.

    Rules support ``<name>`` (str segment) and ``<int:name>`` converters.
    """
    rule_parts, path_parts = rule.strip("/").split("/"), path.strip("/").split("/")
    if len(rule_parts) != len(path_parts):
        return None
    kwargs = {}
    for rp, pp in zip(rule_parts, path_parts):
        if rp.startswith("<int:") and rp.endswith(">"):
            if not pp.lstrip("-").isdigit():
                return None
            kwargs[rp[5:-1]] = int(pp)
        elif rp.startswith("<") and rp.endswith(">"):
            kwargs[rp[1:-1]] = pp
        elif rp != pp:
            return None
    return kwargs


class App:
    """A route table with Flask-flavoured decorators; no dependencies."""

    def __init__(self) -> None:
        self._routes: dict[tuple[str, str], callable] = {}

    def route(self, rule: str, methods=("GET",)):
        def decorator(fn):
            for method in methods:
                self._routes[(method.upper(), rule)] = fn
            return fn

        return decorator

    def handle_request(self, method: str, path: str, body: bytes = b"") -> Response:
        method = method.upper()
        path_matched = False
        for (route_method, rule), fn in self._routes.items():
            kwargs = _match_rule(rule, path)
            if kwargs is None:
                continue
            path_matched = True
            if route_method != method:
                continue
            try:
                return fn(Request(body), **kwargs)
            except KeyError:
                return json_response({"error": "not found"}, status=404)
        return Response("method not allowed", status=405) if path_matched else Response("not found", status=404)


def create_app(storage_path: str | None = None) -> App:
    app = App()
    board = TodoBoard(TodoStorage(storage_path))
    index_tpl = Template((TEMPLATE_DIR / "index.html").read_text(encoding="utf-8"))

    @app.route("/")
    def index(req: Request) -> Response:
        rows = "".join(
            f'<li class="{"done" if t["done"] else "open"}">'
            f'<span>{html.escape(t["text"])}</span></li>'
            for t in board.list()
        )
        return Response(index_tpl.substitute(todo_rows=rows or '<li class="empty">Nothing yet</li>'))

    @app.route("/static/<fname>")
    def static_file(req: Request, fname: str) -> Response:
        target = (STATIC_DIR / fname).resolve()
        if STATIC_DIR.resolve() not in target.parents or not target.is_file():
            return Response("not found", status=404)
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        return Response(target.read_text(encoding="utf-8"), content_type=ctype)

    @app.route("/api/todos", methods=("GET",))
    def list_todos(req: Request) -> Response:
        return json_response(board.list())

    @app.route("/api/todos", methods=("POST",))
    def create_todo(req: Request) -> Response:
        payload = req.json or {}
        text = str(payload.get("text", ""))
        if not text.strip():
            return json_response({"error": "text is required"}, status=400)
        return json_response(board.add(text), status=201)

    @app.route("/api/todos/<int:todo_id>/toggle", methods=("POST",))
    def toggle_todo(req: Request, todo_id: int) -> Response:
        return json_response(board.toggle(todo_id))

    @app.route("/api/todos/<int:todo_id>", methods=("DELETE",))
    def delete_todo(req: Request, todo_id: int) -> Response:
        board.delete(todo_id)
        return json_response({"deleted": todo_id})

    return app


app = create_app()

if __name__ == "__main__":  # pragma: no cover - dev server convenience
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _dispatch(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            resp = app.handle_request(self.command, self.path.split("?", 1)[0], body)
            payload = resp.body.encode("utf-8")
            self.send_response(resp.status)
            self.send_header("Content-Type", resp.content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_DELETE = _dispatch

    HTTPServer(("127.0.0.1", 5000), Handler).serve_forever()
