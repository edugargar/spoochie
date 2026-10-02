# Synthesised dubstep track for the promo: 140 BPM, 34 bars. Every sound is generated
# here, so there is nothing to license.
import numpy as np
from scipy.signal import butter, lfilter, sosfilt
from scipy.io import wavfile

SR = 44100
BPM = 140
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 34
N = int(SR * BAR * BARS) + SR * 2
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(7)

def at(t): return int(t * SR)
def add(sig, t, gain=1.0, pan=0.0):
    i = at(t); j = min(N, i + len(sig)); s = sig[: j - i] * gain
    L[i:j] += s * (1 - max(0, pan)); R[i:j] += s * (1 + min(0, pan))
def env(n, a=0.002, d=0.2, curve=4.0):
    t = np.arange(n) / SR
    e = np.exp(-t / d * curve / 4)
    ai = int(a * SR)
    if ai: e[:ai] *= np.linspace(0, 1, ai)
    return e
def hp(x, f): return sosfilt(butter(2, f, "hp", fs=SR, output="sos"), x)
def lp(x, f): return sosfilt(butter(2, f, "lp", fs=SR, output="sos"), x)
def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], "bp", fs=SR, output="sos"), x)

def kick(big=1.0):
    n = int(0.45 * SR); t = np.arange(n) / SR
    f = 45 + 140 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    k = np.sin(ph) * np.exp(-t * 6.5)
    click = hp(rng.standard_normal(n) * np.exp(-t * 300), 2000) * 0.4
    return np.tanh((k + click) * 1.6 * big)
def snare(big=1.0):
    n = int(0.35 * SR); t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 22)
    noise = bp(rng.standard_normal(n), 1200, 9000) * np.exp(-t * 11)
    return np.tanh((body * .8 + noise * 1.4) * big)
def hat(open_=False):
    n = int((0.25 if open_ else 0.05) * SR); t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7000) * np.exp(-t * (12 if open_ else 90))
def clap():
    n = int(0.3 * SR); t = np.arange(n) / SR
    e = np.zeros(n)
    for o in (0, .011, .022): e += np.exp(-np.maximum(t - o, 0) * 60) * (t >= o)
    e += np.exp(-t * 14) * .5
    return bp(rng.standard_normal(n), 900, 5000) * e

def saw(f, n, detune=0.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for d in (-detune, 0, detune):
        out += 2 * ((t * f * (1 + d)) % 1) - 1
    return out / 3

def wobble(f, dur, rate_beats, depth=1.0, growl=False):
    """A saw through a low-pass whose cutoff swings with an LFO locked to the tempo."""
    n = int(dur * SR); t = np.arange(n) / SR
    x = saw(f, n, 0.006) + 0.6 * np.sin(2 * np.pi * f / 2 * t)  # plus a sub an octave down
    if growl: x = np.tanh(x * 3 + 0.5 * np.sin(2 * np.pi * f * 3.01 * t))
    lfo = 0.5 - 0.5 * np.cos(2 * np.pi * t / (rate_beats * BEAT))
    cut = 90 + (2600 * depth) * lfo ** 1.6
    y = np.zeros(n); blk = 128; zi = np.zeros(2)
    for i in range(0, n, blk):
        b, a = butter(2, min(cut[i], SR / 2 - 100), "lp", fs=SR)
        zi_scaled = zi
        seg, zi = lfilter(b, a, x[i:i + blk], zi=zi_scaled)
        y[i:i + blk] = seg
    sub = np.sin(2 * np.pi * f / 2 * t) * 0.7
    e = np.minimum(1, t / 0.005) * np.minimum(1, (dur - t) / 0.01)
    return np.tanh((y * 1.8 + sub) * 1.3) * e

def pad(freqs, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    x = sum(saw(f, n, 0.01) for f in freqs) / len(freqs)
    e = np.minimum(1, t / 1.2) * np.minimum(1, (dur - t) / 1.0)
    return lp(x, 1400) * e
def riser(dur):
    n = int(dur * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n)
    out = np.zeros(n); blk = 2048
    for i in range(0, n, blk):
        f = 300 + 9000 * (i / n) ** 2
        out[i:i + blk] = bp(x[i:i + blk], f * .7, min(f * 1.4, 20000))
    sweep = np.sin(2 * np.pi * np.cumsum(200 + 1800 * (t / dur) ** 2) / SR) * 0.25
    return (out * (t / dur) ** 1.5 + sweep * (t / dur)) * 0.8
def impact():
    n = int(2.5 * SR); t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * np.cumsum(30 + 90 * np.exp(-t * 6)) / SR) * np.exp(-t * 1.6)
    noise = lp(rng.standard_normal(n), 3000) * np.exp(-t * 3)
    return np.tanh((boom * 1.5 + noise * .5) * 1.5)
def pluck(f, dur=0.25):
    n = int(dur * SR); t = np.arange(n) / SR
    return lp(saw(f, n, 0.004), 2500) * np.exp(-t * 9)

def note(m): return 440 * 2 ** ((m - 69) / 12)
F1 = note(29)   # F1, the key of the bass
CHORDS = [[note(m) for m in c] for c in ([53, 56, 60], [49, 53, 56], [56, 60, 63], [51, 55, 58])]  # Fm Db Ab Eb
def bar(b): return b * BAR

# 0-8: intro and build
for b in range(0, 8):
    add(pad(CHORDS[b % 4], BAR + .3), bar(b), .35)
    for s in range(16):
        if b >= 2: add(hat(), bar(b) + s * BEAT / 4, .10 if s % 2 else .16, pan=.3 if s % 4 == 2 else -.2)
    for i, m in enumerate([65, 68, 72, 68, 75, 72, 68, 65]):
        if b >= 1: add(pluck(note(m)), bar(b) + i * BEAT / 2, .22, pan=(-.4 if i % 2 else .4))
for b in range(4, 8):
    for beat in range(4): add(kick(.8), bar(b) + beat * BEAT, .8)
# snare roll that speeds up into the drop
roll = []
for b, div in ((6, 2), (7, 4)):
    for s in range(4 * div): roll.append(bar(b) + s * BEAT / div)
for s in range(8): roll.append(bar(7) + 2 * BEAT + s * BEAT / 8)  # 32nds over the last half bar... trimmed below
for i, t in enumerate(sorted(set(roll))):
    if t < bar(8) - BEAT * .5: add(snare(.7), t, .25 + .5 * i / len(roll))
add(riser(BAR * 2), bar(6), .7)

def drop(b0, bars, heavy):
    rates = [1, 1, .5, .5, 1 / 3, 1 / 3, .25, 2] if not heavy else [.5, .25, 1 / 3, .5, .25, .125, 1 / 3, 2]
    roots = [0, 0, -4, -4, 3, 3, -2, 0]
    add(impact(), bar(b0), .9)
    for k in range(bars):
        t0 = bar(b0 + k)
        add(kick(1.2), t0, 1.0); add(kick(1.0), t0 + 2.5 * BEAT, .7)
        add(snare(1.3), t0 + 2 * BEAT, .9); add(clap(), t0 + 2 * BEAT, .45)
        for s in range(16): add(hat(s % 4 == 2), t0 + s * BEAT / 4, .08 if s % 2 else .13, pan=.25)
        for half in range(2):
            r = rates[(k * 2 + half) % len(rates)]
            f = F1 * 2 ** (roots[k % len(roots)] / 12)
            add(wobble(f, BAR / 2, r, depth=1.15 if heavy else 1.0, growl=heavy and half == 1), t0 + half * BAR / 2, .55)
drop(8, 8, False)

# 16-20: break
for b in range(16, 20):
    add(pad(CHORDS[b % 4], BAR + .3), bar(b), .45)
    for i, m in enumerate([72, 75, 77, 80, 77, 75, 72, 70]):
        add(pluck(note(m), .35), bar(b) + i * BEAT / 2, .26, pan=(-.5 if i % 2 else .5))
    add(kick(.6), bar(b), .5)
# 20-24: build 2
for b in range(20, 24):
    add(pad(CHORDS[b % 4], BAR + .3), bar(b), .35)
    for beat in range(4): add(kick(.9), bar(b) + beat * BEAT, .85)
    div = 2 if b < 22 else (4 if b == 22 else 8)
    for s in range(4 * div):
        t = bar(b) + s * BEAT / div
        if t < bar(24) - BEAT * .5: add(snare(.7), t, .25 + .5 * (b - 20) / 4)
add(riser(BAR * 4), bar(20), .75)
drop(24, 8, True)
# 32-34: the end hit
add(impact(), bar(32), 1.0)
add(pad(CHORDS[0], BAR * 2), bar(32), .45)
add(kick(1.3), bar(32), 1.0)

mix = np.stack([L, R], 1)
mix = hp(mix.T, 25).T
mix = np.tanh(mix * 0.9)
mix /= np.max(np.abs(mix)) * 1.02
end = at(bar(BARS) + 1.5)
mix = mix[:end]
fade = int(1.2 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
wavfile.write("music.wav", SR, (mix * 32767).astype(np.int16))
print("bars", BARS, "seconds", round(end / SR, 2), "drop1", round(bar(8), 3), "break", round(bar(16), 3), "drop2", round(bar(24), 3), "end", round(bar(32), 3))

