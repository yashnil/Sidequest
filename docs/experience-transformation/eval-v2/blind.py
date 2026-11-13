"""Blind pairs for evaluation v2 (PROTOCOL.md §B), and unblinding of several judges.

    python3 docs/experience-transformation/eval-v2/blind.py build
    python3 docs/experience-transformation/eval-v2/blind.py unblind   # reads blind/verdicts-*.json

Pairs old run i with new run i for each scenario; A/B randomised with a fixed seed
(recorded in blind/key.json, which judges never see). Interface chrome and photo
credits are stripped with the v1 rules so neither build's wording gives it away.
"""
import importlib.util
import json
import random
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).parent
BLIND = HERE / 'blind'
spec = importlib.util.spec_from_file_location('v1blind', HERE.parent / 'eval' / 'blind.py')
v1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v1)


def rows(build):
    out = {}
    for line in (HERE / 'runs' / build / 'scenarios.ndjson').read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[(r['scenario'], str(r.get('run')))] = r
    return out


def build():
    old, new = rows('old'), rows('new')
    rng = random.Random(20261113)
    pairs, key = [], {}
    for k in sorted(old.keys() & new.keys()):
        scenario, run = k
        new_first = rng.random() < 0.5
        a, b = (new[k], old[k]) if new_first else (old[k], new[k])
        pid = f'{scenario}#{run}'
        key[pid] = {'A': 'new' if new_first else 'old', 'B': 'old' if new_first else 'new'}
        pairs.append({'id': pid, 'scenario': scenario, 'title': old[k]['title'], 'request': old[k]['request'], 'dates': old[k]['dates'], 'party': old[k].get('party'), 'A': v1.plan_text(a), 'B': v1.plan_text(b)})
    BLIND.mkdir(exist_ok=True)
    (BLIND / 'pairs.json').write_text(json.dumps(pairs, indent=1, ensure_ascii=False))
    (BLIND / 'key.json').write_text(json.dumps(key, indent=1))
    print(f'{len(pairs)} pairs; key kept separately.')


def unblind():
    key = json.loads((BLIND / 'key.json').read_text())
    judges = sorted(BLIND.glob('verdicts-*.json'))
    table = {}
    for path in judges:
        for v in json.loads(path.read_text()):
            k = key[v['id']]
            winner = 'tie' if v['preferred'] == 'tie' else k[v['preferred']]
            totals = {k[label]: v['scores'][label]['total'] for label in ('A', 'B')}
            table.setdefault(v['id'].split('#')[0], []).append({'judge': path.stem, 'run': v['id'].split('#')[1], 'winner': winner, **totals})
    summary = {}
    for scenario, entries in sorted(table.items()):
        wins = {w: sum(1 for e in entries if e['winner'] == w) for w in ('new', 'old', 'tie')}
        summary[scenario] = {
            'verdicts': len(entries),
            **wins,
            'old_mean': round(statistics.mean(e['old'] for e in entries), 1),
            'new_mean': round(statistics.mean(e['new'] for e in entries), 1),
            'old_sd': round(statistics.pstdev([e['old'] for e in entries]), 1),
            'new_sd': round(statistics.pstdev([e['new'] for e in entries]), 1),
        }
        s = summary[scenario]
        print(f"{scenario:24} new {s['new']:>2}  old {s['old']:>2}  tie {s['tie']:>2}   old {s['old_mean']:>5} ±{s['old_sd']:<4} new {s['new_mean']:>5} ±{s['new_sd']}")
    # Agreement: share of pairs where all judges picked the same winner.
    by_pair = {}
    for path in judges:
        for v in json.loads(path.read_text()):
            by_pair.setdefault(v['id'], []).append('tie' if v['preferred'] == 'tie' else key[v['id']][v['preferred']])
    unanimous = sum(1 for w in by_pair.values() if len(set(w)) == 1)
    totals = {w: sum(s[w] for s in summary.values()) for w in ('new', 'old', 'tie')}
    print(f'totals {totals}; unanimous on {unanimous}/{len(by_pair)} pairs across {len(judges)} judges')
    (BLIND / 'unblinded.json').write_text(json.dumps({'summary': summary, 'totals': totals, 'unanimous': unanimous, 'pairs': len(by_pair), 'detail': table}, indent=1))


if __name__ == '__main__':
    {'build': build, 'unblind': unblind}[sys.argv[1] if len(sys.argv) > 1 else 'build']()
