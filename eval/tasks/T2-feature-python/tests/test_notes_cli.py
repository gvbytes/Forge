"""Tests for the existing notes CLI commands (add / list / show / rm).

Run with `pytest -q`. Each test isolates itself via NOTES_HOME.
"""
import noteslib
import notes


def test_add_and_list_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv(noteslib.NOTES_HOME_ENV, str(tmp_path / "home"))
    assert notes.main(["add", "Shopping list", "--body", "buy oat milk"]) == 0
    assert notes.main(["add", "Paper ideas"]) == 0
    listed = noteslib.list_notes(None)
    assert [n["title"] for n in listed] == ["Shopping list", "Paper ideas"]
    assert [n["id"] for n in listed] == [1, 2]


def test_note_is_markdown_on_disk(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv(noteslib.NOTES_HOME_ENV, str(home))
    notes.main(["add", "Hello World", "--body", "content here"])
    files = sorted(home.glob("*.md"))
    assert len(files) == 1
    assert files[0].name.endswith("hello-world.md")
    assert files[0].read_text(encoding="utf-8").startswith("# Hello World")


def test_show_prints_body(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(noteslib.NOTES_HOME_ENV, str(tmp_path / "home"))
    notes.main(["add", "Groceries", "--body", "buy oat milk"])
    assert notes.main(["show", "1"]) == 0
    out = capsys.readouterr().out
    assert "# Groceries" in out and "buy oat milk" in out


def test_rm_deletes_note(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(noteslib.NOTES_HOME_ENV, str(tmp_path / "home"))
    notes.main(["add", "Temp"])
    capsys.readouterr()  # drain output of `add`
    assert notes.main(["rm", "1"]) == 0
    assert capsys.readouterr().out.strip() == "deleted note 1"
    assert noteslib.list_notes(None) == []
    assert notes.main(["rm", "1"]) == 1  # second delete reports not found


def test_explicit_root_flag_overrides_env(tmp_path, monkeypatch):
    monkeypatch.setenv(noteslib.NOTES_HOME_ENV, str(tmp_path / "env-home"))
    root = str(tmp_path / "flag-home")
    assert notes.main(["--root", root, "add", "Rooted"]) == 0
    assert [n["title"] for n in noteslib.list_notes(root)] == ["Rooted"]
    assert noteslib.list_notes(None) == []  # env home untouched
