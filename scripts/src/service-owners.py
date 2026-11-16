"""Read-only Linux listener inventory; never reads process environments or kills processes."""
import glob
import json
import os

PORTS = {8080, 8099, 8081, 23805}
sockets = {}
for table in ("/proc/net/tcp", "/proc/net/tcp6"):
    if not os.path.exists(table):
        continue
    with open(table) as source:
        for line in source.readlines()[1:]:
            fields = line.split()
            port = int(fields[1].split(":")[1], 16)
            if fields[3] == "0A" and port in PORTS:
                sockets[fields[9]] = port
owners = {port: [] for port in sorted(PORTS)}
for proc in glob.glob("/proc/[0-9]*"):
    try:
        with open(f"{proc}/stat") as source:
            stat = source.read().rsplit(")", 1)[1].split()
        with open(f"{proc}/cmdline", "rb") as source:
            command = source.read().replace(b"\0", b" ").decode(errors="replace").strip()
        found = set()
        for fd in glob.glob(f"{proc}/fd/*"):
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith("socket:[") and target[8:-1] in sockets:
                found.add(sockets[target[8:-1]])
        for port in found:
            owners[port].append({"pid": int(proc.split("/")[-1]), "ppid": int(stat[1]),
                                 "pgid": int(stat[2]), "command": command})
    except (OSError, IndexError):
        continue
print(json.dumps(owners, indent=2))
