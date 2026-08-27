#!/usr/bin/env python3
"""Print a free TCP port on 127.0.0.1.

Usage: free-port.py [preferred]

If `preferred` is given and nothing is listening on it, it is returned as-is so
normal runs keep the documented defaults (engine 4100 / router 4098 / web 4444).
If it is busy (e.g. a stale/orphaned service holds it), an OS-assigned ephemeral
port is returned instead, so launch tooling never dead-locks on a taken port.

Detection is connect-based (works even where lsof/fuser are unavailable): a
successful TCP connect to 127.0.0.1:<port> means something is listening.
"""
import socket
import sys


def busy(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def os_assigned() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def main() -> None:
    preferred = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    if preferred and not busy(preferred):
        print(preferred)
    else:
        print(os_assigned())


if __name__ == "__main__":
    main()
