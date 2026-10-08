"""Plot saved linear-HDR measurements (requires numpy and matplotlib)."""
import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('artifacts', type=Path)
args = parser.parse_args()
root = args.artifacts
output = root / 'figures'
output.mkdir(exist_ok=True)
inputs = {}


def luminance(path):
    payload = path.read_bytes()
    inputs[str(path.relative_to(root))] = hashlib.sha256(payload).hexdigest()
    rgba = np.frombuffer(payload, dtype='<f2').reshape(64, 64, 4).astype(np.float32)
    return rgba[..., :3] @ np.array([0.2126, 0.7152, 0.0722])


def panel(axis, data, title, maximum=1):
    image = axis.imshow(data, cmap='magma', vmin=0, vmax=maximum, interpolation='nearest')
    axis.set_title(title, fontsize=10)
    axis.set_axis_off()
    return image


for path in ['forward', 'deferred']:
    figure, axes = plt.subplots(4, 3, figsize=(9, 11), constrained_layout=True)
    for index, kind in enumerate(['directional', 'point', 'spot', 'rect']):
        prefix = root / 'dawn-world-rigid' / f'{path}-{kind}'
        matched = luminance(Path(f'{prefix}-match-replay.rgba16float'))
        excluded = luminance(Path(f'{prefix}-nonmatch-replay.rgba16float'))
        delta = matched - excluded
        maximum = max(float(matched.max()), 0.1)
        panel(axes[index, 0], matched, f'{kind}: match', maximum)
        panel(axes[index, 1], excluded, f'{kind}: nonmatch', maximum)
        image = panel(axes[index, 2], delta, f'HDR difference: ROI mean {delta[25:39, 25:39].mean():.6f}', maximum)
        figure.colorbar(image, ax=axes[index, :], shrink=0.75, label='linear luminance')
    figure.suptitle(f'{path.capitalize()}: saved native HDR replay\nAnalytical rigid receiver; revision and acceptance in report', fontsize=12)
    figure.savefig(output / f'{path}-all-lights-hdr.png', dpi=160)
    plt.close(figure)

for path in ['forward', 'deferred']:
    names = ['group-before', 'group-after', 'material-replacement', 'recovered']
    titles = ['All receivers lit', 'Role fill isolated', 'Mask + material changed', 'Device recovered']
    figure, axes = plt.subplots(1, 4, figsize=(12, 3.6), constrained_layout=True)
    for axis, name, title in zip(axes, names, titles):
        data = luminance(root / 'dawn-lifecycle' / f'{path}-{name}.rgba16float')
        panel(axis, data, title)
        axis.text(0.5, -0.05, f'left={data[32, 24]:.6f}; right={data[32, 40]:.6f}', transform=axis.transAxes, ha='center', fontsize=8)
    figure.suptitle(f'{path.capitalize()}: two analytical proxy receivers (role left, environment right)\nSaved lifecycle measurement; revision and acceptance in report', fontsize=11)
    figure.savefig(output / f'{path}-group-and-recovery-hdr.png', dpi=160)
    plt.close(figure)

(output / 'inputs.json').write_text(json.dumps({'qualification': 'plots of saved receipts only; refer to report for revision and acceptance', 'sourceSha256': inputs}, indent=2))
print(output)
