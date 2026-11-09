#!/usr/bin/env python3
"""Merge interleaved A/B rounds into medians per build, page and form factor.

    summarise.py <ab-dir> <method>   -> prints JSON {before: {...}, after: {...}}
"""
import glob
import json
import statistics
import sys

ab_dir, method = sys.argv[1:3]
KEYS = ["lcpMs", "fcpMs", "tbtMs", "cls", "speedIndexMs", "performanceScore", "serverResponseMs", "totalTransferBytes", "requestCount", "mainThreadTotalMs", "scriptBootupMs"]
out = {}
for side in ("before", "after"):
    runs = {}
    for path in sorted(glob.glob(f"{ab_dir}/{side}-{method}-*.json")):
        data = json.load(open(path))
        for page, forms in data["pages"].items():
            for form, sample in forms.items():
                if form == "url":
                    continue
                runs.setdefault(page, {}).setdefault(form, []).append(sample)
    side_out = {}
    for page, forms in runs.items():
        side_out[page] = {}
        for form, samples in forms.items():
            entry = {"runs": len(samples), "lcpMsRuns": [s["lcpMs"] for s in samples]}
            for key in KEYS:
                values = [s[key] for s in samples if s.get(key) is not None]
                entry[key] = statistics.median(values) if values else None
            entry["lcpElements"] = sorted({(s.get("lcpElement") or {}).get("selector", "(none reported)") for s in samples})
            entry["transferBytes"] = {k: statistics.median([s["transferBytes"].get(k, 0) for s in samples]) for k in sorted({k for s in samples for k in s["transferBytes"]})}
            entry["requestCounts"] = {k: statistics.median([s["requestCounts"].get(k, 0) for s in samples]) for k in sorted({k for s in samples for k in s["requestCounts"]})}
            entry["mainThreadMs"] = {k: statistics.median([s["mainThreadMs"].get(k, 0) for s in samples]) for k in sorted({k for s in samples for k in s["mainThreadMs"]})}
            side_out[page][form] = entry
    out[side] = side_out
json.dump(out, sys.stdout, indent=1)
