"""Unblind the supplementary judges: old runs vs the post-fix new build (2e9ed45 / 9595734)."""
import json, glob, statistics
from pathlib import Path
D = Path(__file__).parent
key = json.loads((D / 'key.json').read_text())
table = {}
for f in sorted(D.glob('verdicts-*.json')):
    for v in json.loads(f.read_text()):
        k = key[v['id']]
        w = 'tie' if v['preferred'] == 'tie' else k[v['preferred']]
        table.setdefault(v['id'].split('#')[0], []).append({'winner': w, **{k[l]: v['scores'][l]['total'] for l in 'AB'}})
tot = {'new': 0, 'old': 0, 'tie': 0}
for s, e in sorted(table.items()):
    wins = {w: sum(1 for x in e if x['winner'] == w) for w in ('new', 'old', 'tie')}
    for w in tot: tot[w] += wins[w]
    print(f"{s:20} new {wins['new']} old {wins['old']} tie {wins['tie']}  old {statistics.mean(x['old'] for x in e):.1f}±{statistics.pstdev([x['old'] for x in e]):.1f}  new {statistics.mean(x['new'] for x in e):.1f}±{statistics.pstdev([x['new'] for x in e]):.1f}")
print(tot)
