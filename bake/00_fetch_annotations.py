"""Fetch FlyWire 783 public neuron annotations (coordinates + cell types).

Source: github.com/flyconnectome/flywire_annotations, supplemental file 1 of
Schlegel et al. 2024 "Whole-brain annotation and multi-connectome cell typing
of Drosophila" (CC-BY-4.0).  No FlyWire API token required.
"""
import subprocess, shutil, sys, tempfile
from pathlib import Path
from common import PATH_ANN, CACHE

REPO = 'https://github.com/flyconnectome/flywire_annotations.git'
FILE = 'supplemental_files/Supplemental_file1_neuron_annotations.tsv'

if PATH_ANN.exists() and PATH_ANN.stat().st_size > 10_000_000:
    print(f'[annotations] cached: {PATH_ANN} ({PATH_ANN.stat().st_size/1e6:.1f} MB)')
    sys.exit(0)

with tempfile.TemporaryDirectory() as tmp:
    dst = Path(tmp) / 'fw'
    print(f'[annotations] cloning {REPO} (~36 MB) ...')
    r = subprocess.run(['git', 'clone', '--depth', '1', '--filter=blob:none',
                        '--sparse', REPO, str(dst)],
                       env={'GIT_LFS_SKIP_SMUDGE': '1', 'PATH': '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'},
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'[annotations] clone failed: {r.stderr[-500:]}')
    subprocess.run(['git', '-C', str(dst), 'sparse-checkout', 'set', 'supplemental_files'], check=True)
    src = dst / FILE
    if not src.exists():
        sys.exit(f'[annotations] {FILE} not found in repo')
    shutil.copy(src, PATH_ANN)

print(f'[annotations] saved {PATH_ANN} ({PATH_ANN.stat().st_size/1e6:.1f} MB)')
