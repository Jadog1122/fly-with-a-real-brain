"""Figures for the kids' manual.  The brain pictures are the real data, not drawings."""
import sys, json
import numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, Circle, FancyBboxPatch
from pathlib import Path
sys.path.insert(0, 'bake')
from common import load_neurons, RAW

OUT = Path('manual/figs'); OUT.mkdir(parents=True, exist_ok=True)
neu = load_neurons()
X, Y = neu.x.to_numpy(), neu.y.to_numpy()
fly = neu.flywire_id.to_numpy()
f2i = {int(f): i for i, f in enumerate(fly)}
MN9 = [720575940660219265, 720575940618238523]

# ---------------------------------------------------------------- 1. the map
fig, ax = plt.subplots(figsize=(9, 4.9))
fig.patch.set_facecolor('white')
ax.scatter(X, Y, s=.45, c='#3f7fb5', alpha=.55, linewidths=0, rasterized=True)
# real scale: the whole picture is 815 micrometres across (see bake/01_prepare.py)
UNITS_PER_UM = 100 / 814.8
bar = 500 * UNITS_PER_UM
x0, y0 = -48, -31
ax.plot([x0, x0 + bar], [y0, y0], color='#25313f', lw=3.2, solid_capstyle='butt')
ax.text(x0 + bar / 2, y0 - 1.6, 'half a millimetre — the real size',
        ha='center', va='top', fontsize=11.5, color='#25313f')
ax.set_aspect('equal'); ax.axis('off')
ax.set_title('Every brain cell in one fruit fly:  138,639 of them',
             fontsize=15.5, color='#25313f', pad=10, fontweight='bold')
ax.set_ylim(-40, 30)
fig.tight_layout()
fig.savefig(OUT / 'fig1_map.png', dpi=200, facecolor='white')
plt.close(fig)

# ------------------------------------------------------- 2. the sugar cascade
d = np.load(RAW / 'sugar-grns.npz')
si, seeds = d['i'], set(int(x) for x in d['seed'])
active = np.unique(si)
mn9 = [f2i[m] for m in MN9 if m in f2i]
seedl = sorted(seeds)
other = [i for i in active if i not in seeds and i not in mn9]

fig, ax = plt.subplots(figsize=(9, 4.6))
fig.patch.set_facecolor('#0b1018'); ax.set_facecolor('#0b1018')
ax.scatter(X, Y, s=.22, c='#2b4260', alpha=.55, linewidths=0, rasterized=True)
ax.scatter(X[other], Y[other], s=9, c='#6fd0ff', alpha=.95, linewidths=0)
ax.scatter(X[seedl], Y[seedl], s=30, c='#ffc24d', linewidths=0)
ax.scatter(X[mn9], Y[mn9], s=300, c='#ff4166', marker='*',
           edgecolors='white', linewidths=.8, zorder=5)
ax.annotate('the cells that push\nthe tongue out', xy=(X[mn9[0]], Y[mn9[0]]),
            xytext=(X[mn9[0]] + 14, Y[mn9[0]] - 13), color='#ff8fa5', fontsize=11,
            arrowprops=dict(arrowstyle='->', color='#ff8fa5', lw=1.3))
ax.annotate('the sugar-tasting cells\n(we switched these on)',
            xy=(np.mean(X[seedl]), np.mean(Y[seedl]) + 2),
            xytext=(np.mean(X[seedl]) - 44, np.mean(Y[seedl]) - 14),
            color='#ffc24d', fontsize=11, ha='center',
            arrowprops=dict(arrowstyle='->', color='#ffc24d', lw=1.3))
ax.set_aspect('equal'); ax.axis('off')
ax.set_title('One taste of sugar, half a second later', fontsize=15,
             color='white', pad=8, fontweight='bold')
fig.tight_layout()
fig.savefig(OUT / 'fig2_cascade.png', dpi=200, facecolor='#0b1018')
plt.close(fig)
print(f'[fig2] {len(active)} cells shouted, {len(seeds)} were switched on by us')

# ------------------------------------------------------- 3. how cells talk
fig, ax = plt.subplots(figsize=(9, 3.2))
fig.patch.set_facecolor('white'); ax.set_facecolor('white')
ax.set_aspect('equal')                     # or the cells come out as ellipses
pos = {'a': (1.0, 2.15), 'b': (1.0, 1.25), 'c': (1.0, .35), 'd': (5.6, 1.25)}
for k in 'abc':
    ax.add_patch(Circle(pos[k], .32, fc='#ffd166', ec='#c9902a', lw=2.2, zorder=3))
    ax.text(*pos[k], '!', ha='center', va='center', fontsize=18, fontweight='bold',
            color='#8a5f10', zorder=4)
ax.add_patch(Circle(pos['d'], .40, fc='#ff5c7e', ec='#c22e4e', lw=2.6, zorder=3))
ax.text(*pos['d'], '!', ha='center', va='center', fontsize=23, fontweight='bold',
        color='white', zorder=4)
for k in 'abc':
    ax.add_patch(FancyArrowPatch(pos[k], pos['d'], shrinkA=13, shrinkB=16,
                                 arrowstyle='-|>', mutation_scale=26,
                                 color='#8fa8c0', lw=2.6, zorder=2))
ax.text(1.0, 2.80, '3 cells shout...', ha='center', fontsize=13.5, color='#25313f')
ax.text(5.6, 2.05, '...so this one\nshouts too', ha='center', va='bottom',
        fontsize=13.5, color='#25313f')
ax.text(3.3, -.45, 'That is the whole rule. Nothing else.',
        ha='center', fontsize=13, color='#667a8d', style='italic')
ax.set_xlim(.2, 6.6); ax.set_ylim(-.75, 3.2); ax.axis('off')
fig.tight_layout()
fig.savefig(OUT / 'fig3_talk.png', dpi=200, facecolor='white')
plt.close(fig)

# ---------------------------------------------------------- 4. the timeline
first = np.full(len(fly), np.inf, np.float32)
np.minimum.at(first, si, d['t'])
t_mn9 = float(np.min([first[i] for i in mn9])) * 1000
fig, ax = plt.subplots(figsize=(9, 3.0))
fig.patch.set_facecolor('white')
ax.hlines(0, 0, 60, color='#ccd7e2', lw=6, zorder=1)
# both numbers are read out of the simulation
ax.plot(0, 0, 'o', ms=19, color='#ffc24d', zorder=3, markeredgecolor='white', mew=2.5)
ax.text(0, .40, 'we switch on the\n23 sugar-tasting cells', ha='left', va='bottom',
        fontsize=12, color='#25313f')
ax.text(0, -.40, '0 ms', ha='left', va='top', fontsize=12, color='#7b8ea1', fontweight='bold')

tm = round(t_mn9)
ax.plot(tm, 0, 'o', ms=19, color='#ff4166', zorder=3, markeredgecolor='white', mew=2.5)
ax.text(tm, .40, 'the tongue cells shout', ha='center', va='bottom',
        fontsize=12, color='#25313f')
ax.text(tm, -.40, f'{tm} ms', ha='center', va='top', fontsize=12,
        color='#7b8ea1', fontweight='bold')

ax.annotate('', xy=(59, 0), xytext=(tm + 4, 0),
            arrowprops=dict(arrowstyle='-|>', color='#ff9db1', lw=3.5))
ax.text(59, .40, 'and keep shouting:\n47 times in half a second',
        ha='right', va='bottom', fontsize=11.5, color='#c2415c')
ax.text(30, -1.35, 'One blink of your eye takes about 100 ms. This is four times faster.',
        ha='center', fontsize=12.5, color='#667a8d', style='italic')
ax.set_xlim(-4, 64); ax.set_ylim(-1.8, 1.5); ax.axis('off')
fig.tight_layout()
fig.savefig(OUT / 'fig4_timeline.png', dpi=200, facecolor='white')
plt.close(fig)
print(f'[fig4] MN9 first fires at {t_mn9:.1f} ms')
print('figures written to', OUT)
