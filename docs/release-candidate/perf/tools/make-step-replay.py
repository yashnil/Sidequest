#!/usr/bin/env python3
"""Add a replayable interview-step request to a seed file.

    make-step-replay.py <seed.json> <app dir> <db>

The request a browser sends for `advisorStepAction`: POST to the session's own
path with the build's `next-action` id and the stored answers as the one
argument. The id comes from that build's manifest, so it is right for the build
being measured. The stored answers are the session's own, so this ranks exactly
what a traveller's step would rank.
"""
import json
import sqlite3
import sys

seed_path, app, db_path = sys.argv[1:4]
seed = json.load(open(seed_path))
manifest = json.load(open(f"{app}/.next/server/server-reference-manifest.json"))

action = None
for action_id, entry in manifest["node"].items():
    if entry.get("exportedName") == "advisorStepAction":
        action = action_id
if action is None:
    # Older manifest shape: the export name lives in the workers table.
    for action_id, entry in manifest["node"].items():
        if "decide" in json.dumps(entry) and "advisorStepAction" in json.dumps(entry):
            action = action_id
if action is None:
    sys.exit("advisorStepAction not found in the manifest")

db = sqlite3.connect(db_path)
row = db.execute("select answers_json from decision_sessions where id = ?", (seed["decisionId"],)).fetchone()
if row is None:
    sys.exit("decision session not found")

seed["stepReplay"] = {
    "path": f"/decide/{seed['decisionId']}",
    "headers": {"next-action": action, "content-type": "text/plain;charset=UTF-8", "accept": "text/x-component", "origin": "http://127.0.0.1:4420"},
    "body": json.dumps([json.loads(row[0])]),
}
json.dump(seed, open(seed_path, "w"), indent=2)
print("action", action[:12], "body bytes", len(seed["stepReplay"]["body"]))
