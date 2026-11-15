"""Deterministic grading for the final live pass. No model involved.

    python3 docs/final-completion/eval/grade.py docs/final-completion/eval/live

The eval-v3 checks unchanged (defining coverage, red flags, sky timing, early
starts, transport contradictions, impossible legs, journey consistency, travel
burden, walking-pace "measured" rides), plus:

- the unseen destinations' requirements (requirements-unseen.json, written
  before any run);
- for the imported itinerary: how many stated stays were honoured;
- per-row readiness word, lodging names shown, and PDF status for both formats.

Name matching can be fooled by a namesake placed in the wrong spot (eval-v3
caveat), so coverage is a lower-trust number than the hard-failure counts;
the screens and PDFs are the check on it.
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
V3 = HERE.parent.parent / 'experience-transformation' / 'eval-v3'
spec = importlib.util.spec_from_file_location('v3grade', V3 / 'grade.py')
v3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v3)
for name in ('requirements-unseen.json', 'requirements-beta.json'):
    for r in json.loads((HERE / name).read_text()):
        v3.v2.REQ[r['scenario']] = r
v3.NO_SELF_DRIVE.update({'oaxaca-food-culture', 'torres-w-trek', 'advisor-history-rail'})


def grade_row(r):
    if r.get('scenario') == 'imported-itinerary':
        stated = r.get('stated', [])
        return {
            'scenario': 'imported-itinerary',
            'stated_stays': len(stated),
            'honoured': sum(1 for s in stated if s.get('outcome') == 'honoured'),
            'conflicts': len(r.get('conflicts', [])),
            'changes': [(c.get('class'), c.get('kind'), c.get('accepted')) for c in r.get('changes', [])],
            'bases': r.get('bases', []),
            'seconds': r.get('seconds'),
        }
    g = v3.v2.grade_run(r)
    g.update(v3.v3_measures(r))
    g['hard_n'] = len(g['red_flags']) + len(g['sky_violations']) + int(g['early_violation']) + int(g['transport_contradiction']) + len(g['impossible_legs']) + len(g['consistency'])
    g['lodging_names'] = (r.get('lodging') or {}).get('names', [])
    g['pdf'] = {k: v.get('status') for k, v in (r.get('pdf') or {}).items()}
    g['seconds'] = r.get('seconds')
    return g


def main():
    d = Path(sys.argv[1])
    rows = [json.loads(l) for l in (d / 'scenarios.ndjson').read_text().splitlines() if l.strip()]
    grades = [grade_row(r) for r in rows]
    (d / 'grades.json').write_text(json.dumps(grades, indent=1, ensure_ascii=False))
    print(f"{'scenario':24} {'defining':>9} {'hard':>5} {'impossible':>10} {'slowRide':>8} {'maxDay':>7} {'total':>6} {'bases':>5} {'lodging':>7} {'pdf':>12} {'secs':>5}")
    for g in grades:
        if g['scenario'] == 'imported-itinerary':
            print(f"{'imported-itinerary':24} stated stays honoured {g['honoured']}/{g['stated_stays']}, conflicts {g['conflicts']}, changes {g['changes']}, secs {g['seconds']}")
            continue
        pdf = ','.join(f"{k[0]}{v}" for k, v in g['pdf'].items()) or '—'
        print(f"{g['scenario']:24} {str(g['defining_present']) + '/' + str(g['defining_total']):>9} {g['hard_n']:>5} {len(g['impossible_legs']):>10} {len(g['slow_measured_rides']):>8} {str(g['max_day_travel']):>7} {str(g['total_travel']):>6} {str(g['bases']):>5} {len(g['lodging_names']):>7} {pdf:>12} {str(g['seconds']):>5}")


if __name__ == '__main__':
    main()
