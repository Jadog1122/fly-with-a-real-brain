"""Stage-1 sanity plot: raster of the smoke-test cascade."""
import numpy as np, pandas as pd, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
d = np.load(ROOT / 'data' / 'cache' / 'smoke_spikes.npz')
ti, tt, seed = d['i'], d['t'] * 1000, set(d['seed'].tolist())
comp = pd.read_csv(ROOT / 'upstream' / 'data' / '2025_Completeness_783.csv', index_col=0)
i2f = {i: int(f) for i, f in enumerate(comp.index)}
MN9 = {720575940660219265: 'MN9_left', 720575940618238523: 'MN9_right'}
mn9_idx = {i for i, f in i2f.items() if f in MN9}

# order neurons by first spike so the cascade reads top-to-bottom
first = {}
for n, t in zip(ti, tt):
    if n not in first or t < first[n]:
        first[n] = t
order = sorted(first, key=lambda n: first[n])
row = {n: r for r, n in enumerate(order)}
y = np.array([row[n] for n in ti])

fig, ax = plt.subplots(figsize=(11, 7))
for mask, c, s, lab in [
    (~np.isin(ti, list(seed)) & ~np.isin(ti, list(mn9_idx)), '#4da3ff', 2.5, 'downstream'),
    (np.isin(ti, list(seed)), '#ffb020', 4, 'sugar GRNs (stimulated)'),
    (np.isin(ti, list(mn9_idx)), '#ff3b6b', 26, 'MN9 proboscis motor neurons')]:
    ax.scatter(tt[mask], y[mask], s=s, c=c, label=lab, marker='|' if s < 20 else '*', linewidths=1)

ax.set_xlabel('time (ms)'); ax.set_ylabel('neuron (ordered by first spike)')
ax.set_title(f'Sugar GRN activation @200 Hz - {len(ti)} spikes from {len(order)} neurons '
             f'of 138,639\nFlyWire 783 connectome, Brian2 LIF (Shiu et al. model)')
ax.legend(loc='lower right', framealpha=.9); ax.set_facecolor('#0d1117')
fig.patch.set_facecolor('#161b22')
for sp in ax.spines.values(): sp.set_color('#444')
ax.tick_params(colors='#aaa'); ax.xaxis.label.set_color('#ddd')
ax.yaxis.label.set_color('#ddd'); ax.title.set_color('#fff')
fig.tight_layout()
out = ROOT / 'data' / 'cache' / 'smoke_raster.png'
fig.savefig(out, dpi=130)
print('saved', out)
