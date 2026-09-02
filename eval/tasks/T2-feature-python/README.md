# notes — a tiny markdown notes CLI

`notes` keeps plain-text thinking cheap: every note is a standalone
markdown file inside a *notes home* directory, with a `meta.json` index
mapping ids to files.

## Usage

```
notes [--root DIR] add TITLE [--body TEXT]   # create a note
notes [--root DIR] list                      # ids + titles
notes [--root DIR] show ID                   # print the markdown
notes [--root DIR] rm ID                     # delete a note
```

The notes home resolves to `--root`, else `$NOTES_HOME`, else `~/.notes`.

## Layout

```
notes.py           argparse CLI entry point (main(argv) -> exit code)
noteslib.py        storage layer: create/list/read/delete notes
tests/             pytest suite for existing commands (`pytest -q`)
```

## Roadmap

* full-text `search TEXT` across note bodies — planned, not yet built.
