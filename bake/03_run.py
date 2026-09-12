"""Run every selected experiment, one subprocess each.  Safe to interrupt and rerun:
completed .npz files are skipped."""
import json, subprocess, sys, time
from pathlib import Path
from common import CACHE, RAW, ROOT, T_RUN_S

exps = json.load(open(CACHE / 'experiments_todo.json'))
only = sys.argv[1:] or None
py = str(ROOT / '.venv' / 'bin' / 'python')
build = str(CACHE / 'b2_build')
tmp = CACHE / '_exp.json'

todo = [e for e in exps if (not only or e['exp_id'] in only or e['label'] in only)]
done = [e for e in todo if (RAW / f'{e["exp_id"]}.npz').exists()]
todo = [e for e in todo if e not in done]
print(f'[run] {len(exps)} experiments, {len(done)} already done, {len(todo)} to go, '
      f't_run={T_RUN_S}s each')

t0, fails = time.time(), []
for n, e in enumerate(todo, 1):
    json.dump(e, open(tmp, 'w'))
    el = time.time() - t0
    eta = el / max(n - 1, 1) * (len(todo) - n + 1) if n > 1 else 0
    print(f'[{n:3d}/{len(todo)}] eta {eta/60:4.1f}m', flush=True)
    r = subprocess.run([py, str(Path(__file__).parent / '_sim_worker.py'),
                        str(tmp), str(RAW / f'{e["exp_id"]}.npz'), build],
                       cwd=str(Path(__file__).parent), capture_output=True, text=True)
    if r.returncode:
        fails.append(e['exp_id'])
        print(f'  !! {e["exp_id"]} failed:\n{r.stderr[-1200:]}', flush=True)
    else:
        print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else '  (no output)', flush=True)

print(f'[run] finished in {(time.time()-t0)/60:.1f} min; {len(fails)} failures {fails}')
