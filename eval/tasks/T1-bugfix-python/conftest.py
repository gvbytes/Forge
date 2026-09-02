# Makes the repository root importable when running `pytest -q`
# (the bare pytest binary does not put the working directory on sys.path).
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
