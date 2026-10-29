"""OpenCut's in-memory Earshot adapter. Runs only inside the opaque WASM worker."""
import json
import math
import copy
import sys
import types
import numpy as np
from earshot.forge import bank, dsp, fx, knobs

# Browser-only acceleration of upstream's seven optional numba loops. The host
# supplies numerical kernels, never browser APIs. Reference parity is tested.
if '_earshot_kernels' in globals():
    def _kernel(name, *args):
        # PyBuffer may describe strided/subarray views. Own contiguous arrays make
        # logical shapes and data lengths identical for every upstream call.
        owned = [np.array(a, dtype=np.float64, order='C', copy=True) if isinstance(a, np.ndarray) else a for a in args]
        return np.asarray(getattr(_earshot_kernels, name)(*owned).to_py(), dtype=np.float64)
    dsp._svf = lambda *args: _kernel('svf', *args)
    dsp._osc = lambda *args: _kernel('osc', *args)
    fx._allpass = lambda *args: _kernel('allpass', *args)
    fx._follow = lambda *args: _kernel('follow', *args)
    fx._rise = lambda *args: _kernel('rise', *args)
    fx._release = lambda *args: _kernel('release', *args)
    def _fdn(*args):
        return _kernel('fdn', *args).reshape((args[-1], args[2].shape[1]))
    fx._fdn = _fdn


def render_clip(spec):
    entry = bank.get(spec['presetId'])
    seed = int(spec['seed'])
    duration = float(spec['duration'])
    np.random.seed(seed)
    entry.setdefault('params', {}).update(spec.get('parameters') or {})
    source = spec.get('sourceCode')
    if source:
        # A fresh module, in the recipe package, supports the upstream relative imports.
        name = 'earshot.forge.recipes._opencut_custom'
        module = types.ModuleType(name)
        module.__package__ = 'earshot.forge.recipes'
        module.__dict__.update(np=np, dsp=dsp, source_spec=types.MappingProxyType(copy.deepcopy(spec)))
        sys.modules[name] = module
        exec(compile(source, '<earshot-clip>', 'exec'), module.__dict__)
        render = getattr(module, 'render', None)
        if not callable(render):
            raise ValueError('Sound code must define render(params, r).')
        params = dict(entry.get('params') or {})
        params['duration'] = duration
        params['seed'] = seed
        if spec.get('pitch') is not None:
            params['pitch_hz'] = knobs.hz(spec['pitch'])
        if spec.get('apex') is not None:
            params['apex'] = spec['apex']
        y = np.asarray(render(params, dsp.rng(seed)), dtype=np.float32)
        # Custom recipes own structure; OpenCut owns the exact clip length.
    else:
        y, _ = bank.render(entry, seed=seed, dur=duration, apex=spec.get('apex'),
                           pitch=spec.get('pitch'), checks=False, sr=48000)
    if y.ndim == 1:
        y = y[:, None]
    # Match the browser transport: Math.round uses upward rounding at positive ties.
    n = math.floor(duration * 48000 + 0.5)
    if y.ndim != 2 or y.shape[1] not in (1, 2) or not len(y) or len(y) > 48000 * 60:
        raise ValueError('Sound code must return mono or stereo PCM, at most 60 seconds.')
    if not np.isfinite(y).all():
        raise ValueError('Sound code produced non-finite samples.')
    y = np.array(y[:n], dtype=np.float32, copy=True)
    if len(y) < n:
        y = np.pad(y, ((0, n - len(y)), (0, 0)))
    peak = float(np.abs(y).max())
    if peak > 1:
        y *= (10 ** (-1 / 20)) / peak
    echo = spec.get('echo')
    if echo and float(echo['mix']) > 0:
        delay = max(1, math.floor(float(echo['delay']) * 48000 + 0.5))
        dry = y.copy()
        for repeat in range(1, min(64, n // delay + 1)):
            offset = delay * repeat
            gain = float(echo['mix']) * float(echo['feedback']) ** (repeat - 1)
            if gain < 1e-5:
                break
            y[offset:] += dry[:-offset] * gain
        peak = float(np.abs(y).max())
        if peak > 1:
            y /= peak
    # Every trim and custom recipe receives short click-free edges.
    edge = min(240, n // 8)
    if edge:
        y[:edge] *= np.linspace(0, 1, edge, dtype=np.float32)[:, None]
        y[-edge:] *= np.linspace(1, 0, edge, dtype=np.float32)[:, None]
    return np.ascontiguousarray(y.T, dtype=np.float32)
