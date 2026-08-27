#!/usr/bin/env python3
import subprocess
import sys

PORTS = [4098, 4100, 4444]

def kill_ports():
    for p in PORTS:
        try:
            out = subprocess.check_output(["lsof", "-ti", f":{p}"], text=True).strip()
            if out:
                for pid in out.splitlines():
                    print(f"Killing process {pid} on port {p}...")
                    subprocess.run(["kill", "-9", pid], check=False)
        except subprocess.CalledProcessError:
            pass
        except Exception as e:
            print(f"Error checking port {p}: {e}")

if __name__ == "__main__":
    kill_ports()
