"""Blind pairs for evaluation v3 (PROTOCOL.md): previous run i vs new run i, seed 20261115,
v1 chrome stripping, the unchanged v2 rubric. Unblinds every blind/verdicts-*.json.

    python3 docs/experience-transformation/eval-v3/blind.py build
    python3 docs/experience-transformation/eval-v3/blind.py unblind
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
    prev, new = rows('previous'), rows('new')
    rng = random.Random(20261115)
    pairs, key = [], {}
    for k in sorted(prev.keys() & new.keys()):
        scenario, run = k
        new_first = rng.random() < 0.5
        a, b = (new[k], prev[k]) if new_first else (prev[k], new[k])
        pid = f'{scenario}#{run}'
        key[pid] = {'A': 'new' if new_first else 'previous', 'B': 'previous' if new_first else 'new'}
        pairs.append({'id': pid, 'scenario': scenario, 'title': prev[k]['title'], 'request': prev[k]['request'], 'dates': prev[k]['dates'], 'party': prev[k].get('party'), 'A': v1.plan_text(a), 'B': v1.plan_text(b)})
    BLIND.mkdir(exist_ok=True)
    (BLIND / 'key.json').write_text(json.dumps(key, indent=1))
    for run in ('1', '2', '3'):
        (BLIND / f'pairs-run{run}.json').write_text(json.dumps([p for p in pairs if p['id'].endswith('#' + run)], indent=1, ensure_ascii=False))
    print(f'{len(pairs)} pairs in three run files; key kept separately.')


def unblind():
    key = json.loads((BLIND / 'key.json').read_text())
    table, by_pair = {}, {}
    for path in sorted(BLIND.glob('verdicts-*.json')):
        for v in json.loads(path.read_text()):
            k = key[v['id']]
            winner = 'tie' if v['preferred'] == 'tie' else k[v['preferred']]
            table.setdefault(v['id'].split('#')[0], []).append({'winner': winner, **{k[l]: v['scores'][l]['total'] for l in 'AB'}})
            by_pair.setdefault(v['id'], []).append(winner)
    totals = {'new': 0, 'previous': 0, 'tie': 0}
    summary = {}
    for s, e in sorted(table.items()):
        wins = {w: sum(1 for x in e if x['winner'] == w) for w in totals}
        for w in totals:
            totals[w] += wins[w]
        summary[s] = {**wins, 'previous_mean': round(statistics.mean(x['previous'] for x in e), 1), 'previous_sd': round(statistics.pstdev([x['previous'] for x in e]), 1), 'new_mean': round(statistics.mean(x['new'] for x in e), 1), 'new_sd': round(statistics.pstdev([x['new'] for x in e]), 1)}
        t = summary[s]
        print(f"{s:22} new {t['new']} prev {t['previous']} tie {t['tie']}   prev {t['previous_mean']}±{t['previous_sd']}  new {t['new_mean']}±{t['new_sd']}")
    unanimous = sum(1 for w in by_pair.values() if len(set(w)) == 1)
    print(totals, f'unanimous {unanimous}/{len(by_pair)}')
    (BLIND / 'unblinded.json').write_text(json.dumps({'summary': summary, 'totals': totals, 'unanimous': unanimous, 'pairs': len(by_pair)}, indent=1))


if __name__ == '__main__':
    {'build': build, 'unblind': unblind}[sys.argv[1] if len(sys.argv) > 1 else 'build']()
