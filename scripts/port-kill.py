#!/usr/bin/env python3
import os
import sys
import subprocess
import platform

PORTS = [4098, 4100, 4444]

def kill_ports():
    is_windows = platform.system() == "Windows"
    for p in PORTS:
        try:
            if is_windows:
                # Windows: use netstat to find listening PID
                out = subprocess.check_output(f"netstat -ano | findstr :{p}", shell=True, text=True).strip()
                for line in out.splitlines():
                    parts = line.strip().split()
                    if len(parts) >= 5 and f":{p}" in parts[1]:
                        pid = parts[-1]
                        if pid and pid != "0":
                            print(f"Killing process {pid} on port {p} (Windows)...")
                            subprocess.run(["taskkill", "/F", "/PID", pid], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                # macOS / Linux: use lsof
                out = subprocess.check_output(["lsof", "-ti", f":{p}"], text=True).strip()
                if out:
                    for pid in out.splitlines():
                        print(f"Killing process {pid} on port {p}...")
                        subprocess.run(["kill", "-9", pid], check=False)
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass
        except Exception as e:
            print(f"Error checking port {p}: {e}")

if __name__ == "__main__":
    kill_ports()
