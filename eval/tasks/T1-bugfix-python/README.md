# todos — a tiny Flask-like todo webapp

A deliberately small todo application: a Flask-flavoured micro framework
(`app.py`, no external dependencies), a domain model (`models.py`) and
JSON-file persistence (`storage.py`).

## Layout

```
app.py            route table + JSON API + HTML page + dev server
models.py         Todo dataclass and TodoBoard service
storage.py        TodoStorage: load/save the todo list as JSON
templates/        index.html (string.Template)
static/           style.css
tests/            pytest suite (`pytest -q`)
data/             created on first save (TODO_DB overrides the location)
```

## API

| Method | Path                    | Description          |
|--------|-------------------------|----------------------|
| GET    | `/`                     | HTML UI              |
| GET    | `/api/todos`            | list todos           |
| POST   | `/api/todos`            | create `{"text":…}`  |
| POST   | `/api/todos/<id>/toggle`| toggle done flag     |
| DELETE | `/api/todos/<id>`       | delete a todo        |

## Development

```
pytest -q                 # run the test-suite
python3 app.py            # dev server on http://127.0.0.1:5000
TODO_DB=/tmp/t.json ...   # relocate the database
```

## Known issues

* Users report that **todos vanish after adding a second item** — under
  investigation (see the failing regression tests in `tests/test_app.py`).
