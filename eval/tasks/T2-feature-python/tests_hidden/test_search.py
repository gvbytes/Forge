"""HIDDEN acceptance tests for `notes search`.

Contract under test (from the task instruction):
  * ``notes search TEXT`` scans every note body - the ``.md`` files in the
    notes home - line by line for a case-insensitive substring match.
    The ``# Title`` heading line counts as part of the body.
  * Each match prints one line ``RELATIVE_PATH:LINE_NO: TEXT`` where
    RELATIVE_PATH is relative to the notes home, LINE_NO is 1-based and
    TEXT is the stripped source line.
  * Results are ordered by path, then by line number.
  * Zero matches prints nothing and exits 0.

These tests are copied into the repo by the eval runner at grading time
only; the agent never sees them during the run.
"""
import re

import noteslib
import notes


def run_search(capsys, needle):
    """Invoke `notes search` and normalise a missing subcommand to a
    regular AssertionError so the failure reads clearly. The caller must
    have drained capsys after seeding."""
    try:
        rc = notes.main(["search", needle])
    except SystemExit as exc:  # argparse rejects the unknown subcommand
        raise AssertionError(f"`notes search` is not implemented (parser exited with {exc.code})")
    return rc, capsys.readouterr().out


def seed(tmp_path, monkeypatch, capsys=None):
    monkeypatch.setenv(noteslib.NOTES_HOME_ENV, str(tmp_path / "home"))
    assert notes.main(["add", "Shopping", "--body", "buy OAT milk\nplus rye bread"]) == 0
    assert notes.main(["add", "Work journal", "--body", "standup at nine\nSHIP the demo\nship docs later"]) == 0
    if capsys is not None:
        capsys.readouterr()  # discard the seeding chatter


def test_search_is_case_insensitive(tmp_path, monkeypatch, capsys):
    seed(tmp_path, monkeypatch, capsys)
    rc, out = run_search(capsys, "oat")
    assert rc == 0
    assert any("OAT milk" in line for line in out.splitlines())
    # an uppercase needle must match lowercase text too
    rc, out = run_search(capsys, "MILK")
    assert rc == 0 and "OAT milk" in out


def test_search_prints_path_line_format(tmp_path, monkeypatch, capsys):
    seed(tmp_path, monkeypatch, capsys)
    rc, out = run_search(capsys, "ship")
    assert rc == 0
    lines = out.strip().splitlines()
    assert len(lines) == 2
    for line in lines:
        assert re.fullmatch(r"\S+\.md:\d+: \S.*", line), f"bad format: {line!r}"
    paths = [line.split(":")[0] for line in lines]
    assert all(p.endswith("002-work-journal.md") for p in paths)


def test_search_orders_results_by_path_then_line(tmp_path, monkeypatch, capsys):
    seed(tmp_path, monkeypatch, capsys)
    rc, out = run_search(capsys, "SHIP")
    assert rc == 0
    lines = out.strip().splitlines()
    numbers = [int(line.split(":")[1]) for line in lines]
    assert numbers == sorted(numbers)
    assert lines[0].endswith("SHIP the demo")
    assert lines[1].endswith("ship docs later")


def test_search_reaches_notes_created_after_earlier_ones(tmp_path, monkeypatch, capsys):
    seed(tmp_path, monkeypatch, capsys)
    assert notes.main(["add", "Zoo trip", "--body", "feed the zebra"]) == 0
    capsys.readouterr()  # discard the creation message
    rc, out = run_search(capsys, "zebra")
    assert rc == 0
    assert out.strip().splitlines() == ["003-zoo-trip.md:3: feed the zebra"]


def test_search_matches_title_heading_too(tmp_path, monkeypatch, capsys):
    seed(tmp_path, monkeypatch, capsys)
    rc, out = run_search(capsys, "shopping")
    assert rc == 0
    assert any(":1: # Shopping" in line for line in out.strip().splitlines())


def test_search_no_match_is_quiet_and_successful(tmp_path, monkeypatch, capsys):
    seed(tmp_path, monkeypatch, capsys)
    rc, out = run_search(capsys, "nonexistent-xyz")
    assert rc == 0
    assert out == ""
