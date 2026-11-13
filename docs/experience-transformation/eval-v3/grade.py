"""Deterministic grading for evaluation v3 (PROTOCOL.md). No model involved.

    python3 docs/experience-transformation/eval-v3/grade.py runs/previous runs/new [...]

Reuses the v2 checks (defining coverage with failure stage, red flags, sky timing,
early starts, transport contradictions, travel burden) on v2 + v3-new requirements,
and adds the v3 measures from the recorded day rows:
- impossible legs: a stop-to-stop leg shorter than |T(bed,a) - T(bed,b)| - 10 min,
  where T(bed, x) is read from a day's first leg (bed -> x) or last leg (x -> bed);
- far days: days with a stop more than 60 min from the bed (repeated far trips);
- journey consistency: a hire car on an operator, rail or trek trip, or a trek
  with no forwarded-luggage mention.
"""
import importlib.util
import json
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('v2grade', HERE.parent / 'eval-v2' / 'grade.py')
v2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v2)
for r in json.loads((HERE / 'requirements-new.json').read_text()):
    v2.REQ[r['scenario']] = r

LEG = re.compile(r'(?:≈|at least )?(\d+)\s*hr(?:\s*(\d+)\s*min)?[^,]*?,\s*\w+ to (.+)|(?:≈|at least )?(\d+)\s*min[^,]*?,\s*\w+ to (.+)')
HIRE = re.compile(r'\b(?:rental|hire)[ -]car\b|\bcar hire\b|\brent a car\b', re.I)
NO_SELF_DRIVE = {'tokyo-kyoto-transit', 'tanzania-safari', 'point-to-point-trek', 'kumano-kodo'}


def leg_of(text):
    m = LEG.search(text)
    if not m:
        return None
    measured = not text.lstrip().startswith(('≈', 'at least'))
    if m.group(1):
        return int(m.group(1)) * 60 + int(m.group(2) or 0), m.group(3).strip(), measured
    return int(m.group(4)), m.group(5).strip(), measured


def v3_measures(row):
    plan = row.get('plan', [])
    bed = {}
    days = []
    for d in plan:
        legs = [leg_of(t) for t in d.get('travel', [])]
        legs = [l for l in legs if l]
        stops = d.get('stops', [])
        days.append((stops, legs))
        # A certificate needs measured legs on a day that starts and ends at the same bed (not a moving day).
        if stops and len(legs) >= 2 and legs[-1][1] not in stops:
            first, last = legs[0], legs[-1]
            same_bed = abs(first[0] - last[0]) <= max(30, 0.5 * max(first[0], last[0])) or len(stops) > 1
            if first[2] and first[1].startswith(stops[0][:25]) and same_bed:
                bed[stops[0]] = min(bed.get(stops[0], 10**6), first[0])
            if last[2] and same_bed:
                bed[stops[-1]] = min(bed.get(stops[-1], 10**6), last[0])
    impossible = []
    far_days = 0
    for stops, legs in days:
        if any(bed.get(s, 0) > 60 for s in stops):
            far_days += 1
        for minutes, dest, _measured in legs:
            target = next((s for s in stops if dest.startswith(s[:25])), None)
            if not target:
                continue
            i = stops.index(target)
            if i == 0:
                continue
            a, b = stops[i - 1], target
            if a in bed and b in bed and minutes < abs(bed[a] - bed[b]) - 10:
                impossible.append(f'{a} -> {b}: {minutes} min, bound {abs(bed[a] - bed[b])}')
    text = '\n'.join([row.get('overview', ''), row.get('days', ''), row.get('bookings', '')])
    consistency = []
    if row['scenario'] in NO_SELF_DRIVE and HIRE.search(row.get('bookings', '') + row.get('overview', '')):
        consistency.append('hire car on a no-self-drive trip')
    if row['scenario'] in ('point-to-point-trek', 'kumano-kodo') and not re.search(r'luggage|bags (?:ahead|forward)|send your bags', text, re.I):
        consistency.append('trek with no forwarded luggage')
    return {'impossible_legs': impossible, 'far_days': far_days, 'consistency': consistency}


def main():
    dirs = [Path(a) for a in sys.argv[1:]]
    report = {}
    for d in dirs:
        rows = [json.loads(l) for l in (d / 'scenarios.ndjson').read_text().splitlines() if l.strip()]
        grades = []
        for r in rows:
            g = v2.grade_run(r)
            g.update(v3_measures(r))
            g['red_flags_n'] = len(g['red_flags'])
            g['hard_n'] = len(g['red_flags']) + len(g['sky_violations']) + int(g['early_violation']) + int(g['transport_contradiction']) + len(g['impossible_legs']) + len(g['consistency'])
            grades.append(g)
        report[d.name] = grades
    (HERE / 'grades.json').write_text(json.dumps(report, indent=1, ensure_ascii=False))
    scenarios = sorted({g['scenario'] for gs in report.values() for g in gs})
    cols = ['defining', 'impossible', 'far_days', 'hard', 'maxTravel', 'totalTravel', 'bases']
    print(f"{'scenario':22}" + ''.join(f' | {n:^62}' for n in report))
    print(f"{'':22}" + ''.join(' | ' + '  '.join(f'{c:>8}' for c in cols) for _ in report))
    for s in scenarios:
        line = f'{s:22}'
        for n, gs in report.items():
            rs = [g for g in gs if g['scenario'] == s]
            if not rs:
                line += f" | {'—':^62}"
                continue
            def ms(f):
                vals = [f(g) for g in rs if f(g) is not None]
                return f'{statistics.mean(vals):.1f}±{statistics.pstdev(vals):.1f}' if vals else '—'
            line += ' | ' + '  '.join(f'{v:>8}' for v in [ms(lambda g: g['defining_present']) + f"/{rs[0]['defining_total']}", ms(lambda g: len(g['impossible_legs'])), ms(lambda g: g['far_days']), ms(lambda g: g['hard_n']), ms(lambda g: g['max_day_travel']), ms(lambda g: g['total_travel']), ms(lambda g: g['bases'])])
        print(line)


if __name__ == '__main__':
    main()
