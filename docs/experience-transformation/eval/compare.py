"""Objective metrics for the ten-scenario evaluation, before vs after.

    python3 docs/experience-transformation/eval/compare.py [before_dir] [after_dir]

Reads each directory's scenarios.ndjson (written by e2e/staging/scenarios.spec.ts)
and prints, per scenario, figures a reader can check against the page itself:
places to sleep, stops, empty ordinary days, driving per day (from the travel rows
the page prints), the longest day's driving, and what the plan tells the traveller
to arrange. Writes metrics.json beside the after directory.
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
before_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'before'
after_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / 'after'


def load(directory: Path) -> dict:
    rows = {}
    path = directory / 'scenarios.ndjson'
    if not path.exists():
        return rows
    for line in path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row['scenario']] = row
    return rows


MIN = re.compile(r'(?:≈)?(\d+)\s*hr(?:\s*(\d+)\s*min)?|(?:≈)?(\d+)\s*min')
KM = re.compile(r'(\d+(?:\.\d+)?)\s*km')


def minutes_of(text: str) -> int:
    m = MIN.search(text)
    if not m:
        return 0
    if m.group(1):
        return int(m.group(1)) * 60 + int(m.group(2) or 0)
    return int(m.group(3))


def metrics(row: dict) -> dict:
    plan = row['plan']
    days = len(plan)
    stops = sum(len(d['stops']) for d in plan)
    interior = plan[1:-1] if days > 2 else []
    empty = sum(1 for d in interior if len(d['stops']) == 0)
    drive_by_day = []
    km_by_day = []
    for d in plan:
        drive = [t for t in d['travel'] if 'drive' in t]
        drive_by_day.append(sum(minutes_of(t) for t in drive))
        km_by_day.append(sum(float(k) for t in drive for k in KM.findall(t)))
    band = row.get('band', '')
    bases_match = re.search(r'\bBASES?\s*\n\s*(\d+)', band)
    readiness = next((w for w in ['Ready, with cautions', 'Needs a decision', 'Not ready yet', 'Ready'] if w.upper() in band.upper()), None)
    days_text = row.get('days', '')
    return {
        'days': days,
        'stops': stops,
        'stops_per_day': round(stops / max(1, days), 1),
        'empty_ordinary_days': empty,
        'bases': int(bases_match.group(1)) if bases_match else None,
        'drive_min_total': sum(drive_by_day),
        'drive_km_total': round(sum(km_by_day)),
        'drive_min_max_day': max(drive_by_day) if drive_by_day else 0,
        'one_way_walk_notes': len(re.findall(r'is one-way|send your bags ahead', days_text)),
        'length_verdict': 'fills about' in row.get('overview', '') + days_text,
        'readiness': readiness,
        'seconds': row.get('seconds'),
        'advisor_pick': (row.get('advisor') or {}).get('pick'),
    }


before, after = load(before_dir), load(after_dir)
out = {}
keys = list(before.keys() | after.keys())
for key in sorted(keys):
    b = metrics(before[key]) if key in before else None
    a = metrics(after[key]) if key in after else None
    out[key] = {'before': b, 'after': a}
    print(f'\n## {key}')
    for field in ['advisor_pick', 'bases', 'days', 'stops', 'stops_per_day', 'empty_ordinary_days', 'drive_min_total', 'drive_km_total', 'drive_min_max_day', 'one_way_walk_notes', 'length_verdict', 'readiness', 'seconds']:
        bv = b[field] if b else '—'
        av = a[field] if a else '—'
        print(f'  {field:22} {str(bv):>18}  →  {av}')
(after_dir if after_dir.exists() else HERE).mkdir(parents=True, exist_ok=True)
((after_dir if after_dir.exists() else HERE) / 'metrics.json').write_text(json.dumps(out, indent=1, ensure_ascii=False))
