"""Stand-in for app/semantic/worker_main.py in tests: same JSON-lines protocol, no MetricFlow."""

import json
import os
import sys

print(json.dumps({"id": None, "ok": True, "result": {"ready": True}}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    op = req.get("op")
    if op == "crash":
        os._exit(3)
    if op == "crash_once" and not os.path.exists(req["marker"]):
        open(req["marker"], "w").close()
        os._exit(3)
    if op == "fail":
        reply = {"id": req["id"], "ok": False, "error": {"code": "invalid_query", "message": "no such metric"}}
    elif op == "hang":
        continue
    else:
        print("noise that is not JSON", flush=True)
        reply = {"id": req["id"], "ok": True, "result": {"op": op, "echo": req, "pid": os.getpid()}}
    print(json.dumps(reply), flush=True)
