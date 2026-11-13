"""Deterministic grading for evaluation v2 (PROTOCOL.md §A). No model involved.

    python3 docs/experience-transformation/eval-v2/grade.py runs/old runs/new [...]

Each directory holds scenarios.ndjson rows written by e2e/staging/scenarios.spec.ts
(one row per run). The requirements come from requirements.json, applied exactly
as written (frozen before results). Writes grades.json and prints a per-scenario
table with the spread across runs.
"""
import json
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).parent
REQ = {r['scenario']: r for r in json.loads((HERE / 'requirements.json').read_text())}
REST_SCENARIOS = {'family-wellness-march', 'multigenerational'}
NO_SELF_DRIVE = {'tokyo-kyoto-transit', 'tanzania-safari'}

TIME_STOP = re.compile(r'(?m)^(\d{2}):(\d{2})\n[^\n]*\n\d+\n([^\n]+)(?:\n([^\n]*))?')
MIN = re.compile(r'(?:≈)?(\d+)\s*hr(?:\s*(\d+)\s*min)?|(?:≈)?(\d+)\s*min')
SKY = {'sunset': re.compile(r'\bsunset\b', re.I), 'sunrise': re.compile(r'\bsunrise\b|\bdawn\b', re.I), 'stars': re.compile(r'stargaz|star gaz|night sky|dark sky|milky way', re.I)}


def minutes_of(text):
    m = MIN.search(text)
    if not m:
        return 0
    if m.group(1):
        return int(m.group(1)) * 60 + int(m.group(2) or 0)
    return int(m.group(3))


def hm(value):
    if not value:
        return None
    h, m = value.split(':')
    return int(h) * 60 + int(m)


def contains(text, terms):
    low = text.lower()
    return any(t.lower() in low for t in terms)


def grade_run(row):
    req = REQ[row['scenario']]
    plan = row.get('plan', [])
    plan_text = '\n'.join(' | '.join(d.get('stops', []) + d.get('meals', []) + d.get('travel', [])) for d in plan)
    all_text = '\n'.join([row.get('overview', ''), row.get('days', ''), row.get('bookings', '')])
    board_names = ' | '.join(b['name'] for b in row.get('board', []))

    defining = {}
    for d in req['defining']:
        present = contains(plan_text, d['anyOf'])
        stage = None if present else ('selection' if contains(board_names, d['anyOf']) else ('discovery' if row.get('board') else 'unknown'))
        defining[d['id']] = {'present': present, 'stage': stage}

    flags = []
    for f in req['redFlags']:
        if f['anyOf']:
            if contains(all_text, f['anyOf']):
                flags.append(f['id'])
        else:
            # An empty list means "the matching defining experience is absent" (requirements author's note).
            key = f['id'].replace('skip-', '').replace('no-', '')
            match = next((d for d in req['defining'] if key in d['id'] or d['id'] in key), None)
            if match and not defining[match['id']]['present']:
                flags.append(f['id'])

    # Time-of-day: stops whose name or description names the sky.
    sunset, sunrise = hm(req.get('sunsetLocal')), hm(req.get('sunriseLocal'))
    if sunset is not None and sunset < 6 * 60:
        sunset += 24 * 60
    sky_violations = []
    starts = []
    for m in TIME_STOP.finditer(row.get('days', '')):
        start = int(m.group(1)) * 60 + int(m.group(2))
        name, desc = m.group(3), m.group(4) or ''
        starts.append(start)
        words = f'{name} {desc}'
        if sunset is not None and SKY['sunset'].search(words) and abs(start - sunset) > 60 and not SKY['stars'].search(words):
            sky_violations.append(f'sunset stop "{name}" at {m.group(1)}:{m.group(2)}')
        if sunrise is not None and SKY['sunrise'].search(words) and abs(start - sunrise) > 60:
            sky_violations.append(f'sunrise stop "{name}" at {m.group(1)}:{m.group(2)}')
        if sunset is not None and SKY['stars'].search(words) and start < sunset + 45:
            sky_violations.append(f'stargazing "{name}" at {m.group(1)}:{m.group(2)}')

    # Early starts: first stop of a day before 06:30 on a rest scenario.
    early = []
    for day_text in re.split(r'(?m)^DAY \d+', row.get('days', ''))[1:]:
        first = TIME_STOP.search(day_text)
        if first:
            start = int(first.group(1)) * 60 + int(first.group(2))
            if start < 6 * 60 + 30:
                early.append(f'{first.group(1)}:{first.group(2)}')
    early_violation = row['scenario'] in REST_SCENARIOS and len(early) > 0

    transport_contradiction = row['scenario'] in NO_SELF_DRIVE and bool(re.search(r'\b(?:rental|hire)[ -]car\b|\bcar hire\b|\brent a car\b', row.get('bookings', '') + row.get('overview', ''), re.I))

    travel_by_day = [sum(minutes_of(t) for t in d.get('travel', [])) for d in plan]
    limit = req.get('maxDailyTravelMinutes')
    bases = re.search(r'\bBASES?\s*\n\s*(\d+)', row.get('band', ''))
    interior = plan[1:-1] if len(plan) > 2 else []
    return {
        'scenario': row['scenario'],
        'run': row.get('run'),
        'build': row.get('build'),
        'defining_present': sum(1 for v in defining.values() if v['present']),
        'defining_total': len(defining),
        'defining': defining,
        'red_flags': flags,
        'sky_violations': sky_violations,
        'early_starts': early if row['scenario'] in REST_SCENARIOS else [],
        'early_violation': early_violation,
        'transport_contradiction': transport_contradiction,
        'max_day_travel': max(travel_by_day) if travel_by_day else 0,
        'total_travel': sum(travel_by_day),
        'days_over_limit': sum(1 for m in travel_by_day if limit and m > limit),
        'bases': int(bases.group(1)) if bases else None,
        'stops': sum(len(d.get('stops', [])) for d in plan),
        'empty_ordinary_days': sum(1 for d in interior if not d.get('stops')),
        'one_stop_days': sum(1 for d in interior if len(d.get('stops', [])) == 1),
        'board_size': len(row.get('board', [])),
        'contract_gap': 'what this plan still lacks' in row.get('overview', '').lower(),
    }


def summarise(grades):
    out = {}
    for g in grades:
        out.setdefault(g['scenario'], []).append(g)
    table = {}
    for scenario, runs in sorted(out.items()):
        def spread(key):
            values = [r[key] for r in runs if r[key] is not None]
            return {'mean': round(statistics.mean(values), 2) if values else None, 'min': min(values) if values else None, 'max': max(values) if values else None}
        table[scenario] = {
            'runs': len(runs),
            'defining_share': spread('defining_present'),
            'defining_total': runs[0]['defining_total'],
            'red_flags': spread('red_flags_n'),
            'hard_violations': spread('hard_n'),
            'max_day_travel': spread('max_day_travel'),
            'days_over_limit': spread('days_over_limit'),
            'bases': spread('bases'),
            'missing_by_stage': {stage: sum(1 for r in runs for v in r['defining'].values() if v['stage'] == stage) for stage in ('discovery', 'selection', 'unknown')},
            'per_defining': {k: sum(1 for r in runs if r['defining'][k]['present']) for k in runs[0]['defining']},
        }
    return table


def main():
    dirs = [Path(a) for a in sys.argv[1:]] or [HERE / 'runs' / 'old', HERE / 'runs' / 'new']
    report = {}
    for d in dirs:
        rows = [json.loads(l) for l in (d / 'scenarios.ndjson').read_text().splitlines() if l.strip()]
        grades = [grade_run(r) for r in rows]
        for g in grades:
            g['red_flags_n'] = len(g['red_flags'])
            g['hard_n'] = len(g['red_flags']) + len(g['sky_violations']) + int(g['early_violation']) + int(g['transport_contradiction'])
        report[d.name] = {'grades': grades, 'summary': summarise(grades)}
    (HERE / 'grades.json').write_text(json.dumps(report, indent=1, ensure_ascii=False))
    names = list(report)
    scenarios = sorted({s for r in report.values() for s in r['summary']})
    print(f"{'scenario':24}" + ''.join(f" | {n:>34}" for n in names))
    print(f"{'':24}" + ''.join(f" | {'defining  flags+hard  maxTravel  bases':>34}" for _ in names))
    for s in scenarios:
        cells = []
        for n in names:
            t = report[n]['summary'].get(s)
            if not t:
                cells.append(f" | {'—':>34}")
                continue
            dm, dmn, dmx = t['defining_share']['mean'], t['defining_share']['min'], t['defining_share']['max']
            cells.append(f" | {dm:>4}/{t['defining_total']} [{dmn}-{dmx}]  {t['hard_violations']['mean']:>4} [{t['hard_violations']['min']}-{t['hard_violations']['max']}]  {t['max_day_travel']['mean']:>6}  {t['bases']['mean']}")
        print(f'{s:24}' + ''.join(cells))


if __name__ == '__main__':
    main()
