"""Builds the blind pairs for the ten-scenario review, and unblinds the verdicts.

    python3 docs/experience-transformation/eval/blind.py build    # writes blind/pairs.json + blind/key.json
    python3 docs/experience-transformation/eval/blind.py unblind  # reads blind/verdicts.json + key.json

Each scenario's two plans (before/after) are labelled A and B at random (fixed
seed, recorded in key.json), with interface chrome stripped so neither version's
wording of buttons or menus gives it away. The judge receives pairs.json only.
"""
import json
import random
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
BLIND = HERE / 'blind'
CHROME = [
    r'Use Ctrl \+ scroll to zoom the map', r'Take it with you', r'\bMore\b\n', r'Edit this day\s*▸?', r'Map, hours & weather\s*▸?', r'Hours & weather\s*▸?',
    r'Directions for the day\s*↗?', r'⋯', r'▸', r'Ask Sidequest', r'Fixture planning data[^\n]*',
]


def load(directory: Path) -> dict:
    return {json.loads(l)['scenario']: json.loads(l) for l in (directory / 'scenarios.ndjson').read_text().splitlines() if l.strip()}


def clean(text: str) -> str:
    for pattern in CHROME:
        text = re.sub(pattern, '', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def plan_text(row: dict) -> str:
    parts = [
        f"TRIP SUMMARY\n{clean(row.get('band', ''))}",
        f"OVERVIEW\n{clean(row.get('overview', ''))[:5000]}",
        f"DAYS\n{clean(row.get('days', ''))[:22000]}",
        f"BOOKINGS\n{clean(row.get('bookings', ''))[:4000]}",
    ]
    advisor = row.get('advisor')
    if advisor:
        parts.insert(0, f"DESTINATION RECOMMENDATIONS SHOWN (the traveller then planned the first)\n{clean(advisor.get('shortlist', ''))[:3500]}")
    return '\n\n'.join(parts)


def build() -> None:
    before, after = load(HERE / 'before'), load(HERE / 'after')
    rng = random.Random(20261112)
    pairs, key = [], {}
    for scenario in sorted(before.keys() & after.keys()):
        first_is_after = rng.random() < 0.5
        a, b = (after[scenario], before[scenario]) if first_is_after else (before[scenario], after[scenario])
        key[scenario] = {'A': 'after' if first_is_after else 'before', 'B': 'before' if first_is_after else 'after'}
        pairs.append({
            'scenario': scenario,
            'title': before[scenario]['title'],
            'request': before[scenario]['request'],
            'dates': before[scenario]['dates'],
            'party': before[scenario].get('party'),
            'A': plan_text(a),
            'B': plan_text(b),
        })
    BLIND.mkdir(exist_ok=True)
    (BLIND / 'pairs.json').write_text(json.dumps(pairs, indent=1, ensure_ascii=False))
    (BLIND / 'key.json').write_text(json.dumps(key, indent=1))
    print(f'{len(pairs)} pairs written; key kept separately.')


def unblind() -> None:
    key = json.loads((BLIND / 'key.json').read_text())
    verdicts = json.loads((BLIND / 'verdicts.json').read_text())
    tally = {'after': 0, 'before': 0, 'tie': 0}
    for v in verdicts:
        k = key[v['scenario']]
        winner = 'tie' if v['preferred'] == 'tie' else k[v['preferred']]
        tally[winner] += 1
        scores = {k[label]: v['scores'][label] for label in ('A', 'B')}
        print(f"{v['scenario']:24} preferred={winner:6}  before={scores['before']}  after={scores['after']}")
    print(tally)


if __name__ == '__main__':
    {'build': build, 'unblind': unblind}[sys.argv[1] if len(sys.argv) > 1 else 'build']()
