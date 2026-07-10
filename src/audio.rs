//! audio.rs — Milestone 7: 100% procedural audio.
//!
//! The game shipped silent through M6. This module gives it a voice without a
//! single asset file: every sound is **synthesized as raw PCM in-memory at load
//! time**, wrapped in a tiny WAV container, and handed to macroquad's mixer.
//!
//! ## Why it's split the way it is
//! * [`mod synth`] is **pure** — DSP helpers, the per-sound synth functions, the
//!   engine/drift loop generators, and a canonical 16-bit WAV encoder. It depends
//!   on nothing but `std`, so the whole thing is unit-testable with **no audio
//!   device** (the M7 DoD's headless requirement).
//! * [`AudioBank`] is the **device side**: it decodes those WAV buffers into
//!   `macroquad::audio::Sound`s and drives playback. It touches `get_context()`,
//!   so it is only ever constructed from inside `#[macroquad::main]` (never in a
//!   test).
//! * [`Sfx`] + [`SfxQueue`] are the wire format between the two: the simulation
//!   records *which* sounds happened into a fixed-size, zero-allocation queue
//!   (exactly mirroring how it emits particles), and `main` drains it each frame.
//!
//! ## Two macroquad 0.4.14 constraints that shaped the design
//! 1. The `audio` feature is **off by default** — `Cargo.toml` enables it, else
//!    every call here is a silent no-op stub.
//! 2. `PlaySoundParams` exposes only `{ looped, volume }` — **no pitch/rate
//!    control**. So "engine pitch tracks speed" is done by pre-baking
//!    [`N_ENGINE_BANDS`](synth::N_ENGINE_BANDS) looped tones across a Hz range and
//!    **crossfading their volumes** with road speed. Volume is the only knob.

use macroquad::audio::{load_sound_from_bytes, play_sound, set_sound_volume, PlaySoundParams, Sound};

// ----------------------------------------------------------------------------
// Mixer tunables (device side)
// ----------------------------------------------------------------------------

/// Master gain everything is scaled by (the M7 DoD's "~0.7" default). Adjustable
/// at runtime via [`AudioBank::adjust_master`] (bound to `[` / `]` in `main`).
pub const MASTER_VOLUME: f32 = 0.7;

const ENGINE_GAIN: f32 = 0.5; // headroom for the always-on engine bed
const DRIFT_GAIN: f32 = 0.6; // the drift screech voice
const ENGINE_IDLE_FLOOR: f32 = 0.14; // lowest band always hums a little while racing

// ----------------------------------------------------------------------------
// Sound identifiers + the zero-alloc event queue
// ----------------------------------------------------------------------------

/// Every one-shot sound effect. Per-class cannons get their own timbre
/// (`Fire*`), which is why this enum — not `ChassisClass` — is the wire type:
/// it keeps `audio` decoupled from `combat` (callers map their class → `Sfx`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sfx {
    MenuMove,
    MenuConfirm,
    MenuBack,
    CountdownBeep,
    CountdownGo,
    LapChime,
    FinishJingle,
    Boost,
    Pickup,
    Spinout,
    Bump,
    Explosion,
    FireMortar,
    FireLaser,
    FireDart,
    FireMine,
}

impl Sfx {
    /// All variants, in stable index order. [`AudioBank`] loads its sound table
    /// in this order, so `ALL[i].index() == i`.
    pub const ALL: [Sfx; 16] = [
        Sfx::MenuMove,
        Sfx::MenuConfirm,
        Sfx::MenuBack,
        Sfx::CountdownBeep,
        Sfx::CountdownGo,
        Sfx::LapChime,
        Sfx::FinishJingle,
        Sfx::Boost,
        Sfx::Pickup,
        Sfx::Spinout,
        Sfx::Bump,
        Sfx::Explosion,
        Sfx::FireMortar,
        Sfx::FireLaser,
        Sfx::FireDart,
        Sfx::FireMine,
    ];

    /// Stable index into [`AudioBank::sfx`].
    #[inline]
    pub fn index(self) -> usize {
        self as usize
    }

    /// Per-sound playback gain (before master), so a machine-gun laser doesn't
    /// drown a menu blip. Pure mixing taste.
    fn gain(self) -> f32 {
        match self {
            Sfx::MenuMove => 0.45,
            Sfx::MenuConfirm | Sfx::MenuBack => 0.6,
            Sfx::CountdownBeep => 0.8,
            Sfx::CountdownGo => 1.0,
            Sfx::LapChime => 0.8,
            Sfx::FinishJingle => 0.95,
            Sfx::Boost => 0.85,
            Sfx::Pickup => 0.7,
            Sfx::Spinout => 0.85,
            Sfx::Bump => 0.7,
            Sfx::Explosion => 1.0,
            Sfx::FireMortar => 0.9,
            Sfx::FireLaser => 0.5,
            Sfx::FireDart => 0.65,
            Sfx::FireMine => 0.7,
        }
    }
}

/// Fixed-capacity ring of pending one-shots, filled during a frame's simulation
/// and drained by `main`. A plain array + length means **`push` never touches the
/// heap** (it drops on overflow, which can't happen at this event rate) — the same
/// zero-allocation discipline as the particle pool. Mirrors the `&mut
/// ParticleSystem` sink threaded through the sim.
pub const SFX_QUEUE_CAP: usize = 64;

pub struct SfxQueue {
    buf: [Sfx; SFX_QUEUE_CAP],
    len: usize,
}

impl SfxQueue {
    pub fn new() -> Self {
        Self { buf: [Sfx::MenuMove; SFX_QUEUE_CAP], len: 0 }
    }

    /// Drop all queued events (called once per frame, at the top of `Game::update`).
    #[inline]
    pub fn clear(&mut self) {
        self.len = 0;
    }

    /// Queue a one-shot. Silently drops if the (generous) capacity is exceeded —
    /// never allocates, never panics.
    #[inline]
    pub fn push(&mut self, sfx: Sfx) {
        if self.len < SFX_QUEUE_CAP {
            self.buf[self.len] = sfx;
            self.len += 1;
        }
    }

    /// The events queued this frame, in order.
    #[inline]
    pub fn as_slice(&self) -> &[Sfx] {
        &self.buf[..self.len]
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Default for SfxQueue {
    fn default() -> Self {
        Self::new()
    }
}

// ----------------------------------------------------------------------------
// The device-side mixer
// ----------------------------------------------------------------------------

/// Owns every loaded `Sound` and the master volume. Built once at startup by
/// [`AudioBank::load`]; all methods are render-side and called from `main`.
pub struct AudioBank {
    sfx: Vec<Sound>,    // indexed by Sfx::index()
    engine: Vec<Sound>, // N_ENGINE_BANDS looped voices, crossfaded by speed
    drift: Sound,       // looped screech, volume-gated by player drift
    master: f32,
}

impl AudioBank {
    /// Synthesize every buffer, encode it to an in-memory WAV, and decode it into
    /// a playable `Sound`. Starts the engine bands and the drift voice as looping
    /// voices at volume 0 (they're always "playing"; we only modulate volume).
    ///
    /// Async + GPU/audio-context-bound — call **only** from inside
    /// `#[macroquad::main]`. Never invoked by the headless tests.
    pub async fn load() -> AudioBank {
        async fn decode(pcm: &[f32]) -> Sound {
            let wav = synth::encode_wav_mono16(pcm, synth::SAMPLE_RATE);
            load_sound_from_bytes(&wav)
                .await
                .expect("synthesized WAV must decode")
        }

        let mut sfx = Vec::with_capacity(Sfx::ALL.len());
        for &s in &Sfx::ALL {
            sfx.push(decode(&synth::synth_sfx(s)).await);
        }

        let mut engine = Vec::with_capacity(synth::N_ENGINE_BANDS);
        for i in 0..synth::N_ENGINE_BANDS {
            let snd = decode(&synth::synth_engine_band(i)).await;
            play_sound(&snd, PlaySoundParams { looped: true, volume: 0.0 });
            engine.push(snd);
        }

        let drift = decode(&synth::synth_drift_loop()).await;
        play_sound(&drift, PlaySoundParams { looped: true, volume: 0.0 });

        AudioBank { sfx, engine, drift, master: MASTER_VOLUME }
    }

    /// Fire a one-shot now.
    pub fn play(&self, sfx: Sfx) {
        play_sound(
            &self.sfx[sfx.index()],
            PlaySoundParams { looped: false, volume: self.master * sfx.gain() },
        );
    }

    /// Drain a frame's queued one-shots.
    pub fn play_all(&self, queue: &SfxQueue) {
        for &s in queue.as_slice() {
            self.play(s);
        }
    }

    /// Update the engine bed: crossfade the two bands bracketing the current
    /// speed so the pitch rises and falls continuously (equal-power, so the total
    /// loudness stays flat across the blend). Silent when not actively racing.
    pub fn update_engine(&self, speed_ratio: f32, racing: bool) {
        if !racing {
            for s in &self.engine {
                set_sound_volume(s, 0.0);
            }
            return;
        }
        let last = synth::N_ENGINE_BANDS - 1;
        // speed_ratio spans 0..1.4 (see KartState::speed_ratio); map it across the
        // bands and split the fractional position between the two neighbors.
        let p = (speed_ratio / 1.4).clamp(0.0, 1.0) * last as f32;
        let lo = (p.floor() as usize).min(last);
        let frac = p - lo as f32;
        let gain = self.master * ENGINE_GAIN;
        for (b, s) in self.engine.iter().enumerate() {
            let mut v = if b == lo {
                (frac * std::f32::consts::FRAC_PI_2).cos()
            } else if b == lo + 1 {
                (frac * std::f32::consts::FRAC_PI_2).sin()
            } else {
                0.0
            };
            if b == 0 {
                v = v.max(ENGINE_IDLE_FLOOR); // always a faint idle hum
            }
            set_sound_volume(s, v * gain);
        }
    }

    /// Gate the looping drift screech on/off (volume only).
    pub fn update_drift(&self, active: bool) {
        set_sound_volume(&self.drift, if active { self.master * DRIFT_GAIN } else { 0.0 });
    }

    /// Current master volume (0..1).
    #[inline]
    pub fn master(&self) -> f32 {
        self.master
    }

    /// Nudge master volume, clamped to 0..1 (the `[` / `]` keys in `main`).
    pub fn adjust_master(&mut self, delta: f32) {
        self.master = (self.master + delta).clamp(0.0, 1.0);
    }

    /// Set master volume outright, clamped to 0..1. `main` mirrors the M11
    /// `Settings.master_volume` here each frame so the Settings screen (and the
    /// `[` / `]` keys, which now drive that setting) take effect immediately.
    pub fn set_master(&mut self, v: f32) {
        self.master = v.clamp(0.0, 1.0);
    }
}

// ----------------------------------------------------------------------------
// Pure synthesis (no device, fully testable)
// ----------------------------------------------------------------------------

/// All the offline DSP: oscillators, envelopes, the per-sound recipes, the
/// engine/drift loop generators, and the WAV encoder. Deterministic (seeded
/// noise) and device-free, so the M7 headless tests drive it directly.
pub mod synth {
    use super::Sfx;
    use std::f32::consts::{PI, TAU};

    /// One sample rate for everything. 44.1 kHz keeps the laser/explosion highs
    /// crisp; buffers are tiny (the longest is ~1 s) so memory is a non-issue.
    pub const SAMPLE_RATE: u32 = 44_100;
    const SR: f32 = SAMPLE_RATE as f32;

    /// Number of pre-baked engine loops crossfaded by speed (see module docs for
    /// why we can't just pitch-shift one). 8 bands over the Hz range below give a
    /// smooth-enough sweep.
    pub const N_ENGINE_BANDS: usize = 8;
    const ENGINE_HZ_MIN: f32 = 60.0;
    const ENGINE_HZ_MAX: f32 = 320.0;

    // -- tiny DSP toolkit ---------------------------------------------------

    /// Samples needed for `secs` seconds (≥ 1).
    #[inline]
    pub fn n_samples(secs: f32) -> usize {
        ((SR * secs).round() as usize).max(1)
    }

    /// Deterministic xorshift32 noise in [-1, 1). Seeded → reproducible tests.
    struct Rng(u32);

    impl Rng {
        fn new(seed: u32) -> Self {
            Rng(seed | 1)
        }
        #[inline]
        fn next(&mut self) -> f32 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.0 = x;
            (x as f32 / u32::MAX as f32) * 2.0 - 1.0
        }
    }

    /// A phase-accumulated additive tone that sweeps linearly from `f0` to `f1`
    /// over `dur`. `harm[k]` is the amplitude of the (k+1)-th harmonic. Phase
    /// accumulation (not `sin(2πft)`) keeps the sweep artifact-free.
    fn swept(f0: f32, f1: f32, dur: f32, harm: &[f32]) -> Vec<f32> {
        let n = n_samples(dur);
        let mut buf = vec![0.0f32; n];
        let mut phase = 0.0f32;
        for (i, out) in buf.iter_mut().enumerate() {
            let frac = if n > 1 { i as f32 / (n - 1) as f32 } else { 0.0 };
            let f = f0 + (f1 - f0) * frac;
            phase += TAU * f / SR;
            let mut s = 0.0;
            for (k, &a) in harm.iter().enumerate() {
                s += a * (phase * (k as f32 + 1.0)).sin();
            }
            *out = s;
        }
        buf
    }

    /// `dur` seconds of deterministic white noise.
    fn noise(dur: f32, seed: u32) -> Vec<f32> {
        let mut r = Rng::new(seed);
        (0..n_samples(dur)).map(|_| r.next()).collect()
    }

    /// In-place one-pole low-pass (gentle noise shaping).
    fn low_pass(buf: &mut [f32], cutoff_hz: f32) {
        let dt = 1.0 / SR;
        let rc = 1.0 / (TAU * cutoff_hz.max(1.0));
        let a = dt / (rc + dt);
        let mut y = 0.0;
        for x in buf.iter_mut() {
            y += a * (*x - y);
            *x = y;
        }
    }

    /// Linear attack to 1.0 over `attack` s, then exponential decay with time
    /// constant `decay` s — a percussive AD envelope, applied in place.
    fn apply_env(buf: &mut [f32], attack: f32, decay: f32) {
        for (i, x) in buf.iter_mut().enumerate() {
            let t = i as f32 / SR;
            let a = if attack <= 0.0 { 1.0 } else { (t / attack).clamp(0.0, 1.0) };
            let past = (t - attack).max(0.0);
            *x *= a * (-past / decay).exp();
        }
    }

    /// Add `src * gain` into `dst` starting at sample `off` (bounds-checked).
    fn mix_at(dst: &mut [f32], src: &[f32], off: usize, gain: f32) {
        for (i, &s) in src.iter().enumerate() {
            if let Some(d) = dst.get_mut(off + i) {
                *d += s * gain;
            }
        }
    }

    /// Scale so the largest magnitude equals `peak` (no-op on silence).
    fn normalize(buf: &mut [f32], peak: f32) {
        let m = buf.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        if m > 1e-6 {
            let g = peak / m;
            for x in buf.iter_mut() {
                *x *= g;
            }
        }
    }

    /// Final pass for one-shots: normalize, then a 1 ms fade-in / 5 ms fade-out
    /// so the buffer starts and ends at zero (no edge clicks), then hard-clamp to
    /// the valid PCM range.
    fn finish(mut buf: Vec<f32>, peak: f32) -> Vec<f32> {
        normalize(&mut buf, peak);
        let n = buf.len();
        let fi = n_samples(0.001).min(n);
        let fo = n_samples(0.005).min(n);
        for i in 0..fi {
            buf[i] *= i as f32 / fi as f32;
        }
        for i in 0..fo {
            buf[n - 1 - i] *= i as f32 / fo as f32;
        }
        for x in buf.iter_mut() {
            *x = x.clamp(-1.0, 1.0);
        }
        buf
    }

    /// A simple bell/pluck partial stack at `freq`, used for chimes and the
    /// finish jingle.
    fn bell(freq: f32, dur: f32) -> Vec<f32> {
        let mut b = swept(freq, freq, dur, &[1.0, 0.5, 0.25, 0.12]);
        apply_env(&mut b, 0.002, dur * 0.45);
        b
    }

    // -- per-sound recipes --------------------------------------------------

    /// Design duration of each one-shot (seconds). Single source of truth: the
    /// recipes below size their buffers from this, and the tests assert the
    /// resulting PCM length matches `n_samples(sfx_secs(s))`.
    pub fn sfx_secs(s: Sfx) -> f32 {
        match s {
            Sfx::MenuMove => 0.05,
            Sfx::MenuConfirm => 0.13,
            Sfx::MenuBack => 0.13,
            Sfx::CountdownBeep => 0.18,
            Sfx::CountdownGo => 0.35,
            Sfx::LapChime => 0.55,
            Sfx::FinishJingle => 0.95,
            Sfx::Boost => 0.5,
            Sfx::Pickup => 0.3,
            Sfx::Spinout => 0.6,
            Sfx::Bump => 0.12,
            Sfx::Explosion => 0.5,
            Sfx::FireMortar => 0.35,
            Sfx::FireLaser => 0.18,
            Sfx::FireDart => 0.18,
            Sfx::FireMine => 0.2,
        }
    }

    /// Synthesize a one-shot to PCM in [-1, 1].
    pub fn synth_sfx(s: Sfx) -> Vec<f32> {
        let dur = sfx_secs(s);
        match s {
            Sfx::MenuMove => {
                let mut b = swept(620.0, 700.0, dur, &[1.0, 0.2]);
                apply_env(&mut b, 0.003, 0.03);
                finish(b, 0.7)
            }
            Sfx::MenuConfirm => {
                let mut b = swept(520.0, 900.0, dur, &[1.0, 0.3, 0.12]);
                apply_env(&mut b, 0.005, 0.09);
                finish(b, 0.85)
            }
            Sfx::MenuBack => {
                let mut b = swept(640.0, 300.0, dur, &[1.0, 0.25]);
                apply_env(&mut b, 0.005, 0.08);
                finish(b, 0.75)
            }
            Sfx::CountdownBeep => {
                // 1st + 3rd harmonic → a clean, squarish beep.
                let mut b = swept(700.0, 700.0, dur, &[1.0, 0.0, 0.25]);
                apply_env(&mut b, 0.005, 0.12);
                finish(b, 0.9)
            }
            Sfx::CountdownGo => {
                let mut b = swept(1000.0, 1150.0, dur, &[1.0, 0.4, 0.2]);
                apply_env(&mut b, 0.005, 0.18);
                finish(b, 1.0)
            }
            Sfx::LapChime => {
                let mut b = vec![0.0f32; n_samples(dur)];
                mix_at(&mut b, &bell(987.77, 0.45), 0, 1.0); // B5
                mix_at(&mut b, &bell(1318.51, 0.45), n_samples(0.1), 0.9); // E6
                finish(b, 0.85)
            }
            Sfx::FinishJingle => {
                // C5 – E5 – G5 – C6 arpeggio.
                let notes = [523.25, 659.25, 783.99, 1046.50];
                let mut b = vec![0.0f32; n_samples(dur)];
                for (k, &f) in notes.iter().enumerate() {
                    mix_at(&mut b, &bell(f, 0.4), n_samples(0.16 * k as f32), 0.9);
                }
                finish(b, 0.95)
            }
            Sfx::Boost => {
                // Lowpassed noise that swells, plus a rising tone — a turbo whoosh.
                let mut b = noise(dur, 0x9E37_79B9);
                low_pass(&mut b, 1800.0);
                let n = b.len();
                for (i, x) in b.iter_mut().enumerate() {
                    let u = i as f32 / (n - 1).max(1) as f32;
                    *x *= (u * PI).sin(); // 0 → 1 → 0 swell
                }
                let mut tone = swept(180.0, 700.0, dur, &[1.0, 0.5, 0.25]);
                apply_env(&mut tone, 0.05, 0.3);
                mix_at(&mut b, &tone, 0, 0.8);
                finish(b, 0.9)
            }
            Sfx::Pickup => {
                // Three ascending blips.
                let notes = [880.0, 1174.66, 1567.98];
                let mut b = vec![0.0f32; n_samples(dur)];
                for (k, &f) in notes.iter().enumerate() {
                    let mut blip = swept(f, f, 0.1, &[1.0, 0.3]);
                    apply_env(&mut blip, 0.004, 0.06);
                    mix_at(&mut b, &blip, n_samples(0.07 * k as f32), 0.9);
                }
                finish(b, 0.85)
            }
            Sfx::Spinout => {
                // A dizzy, vibrato'd tone falling 600 → 150 Hz.
                let n = n_samples(dur);
                let mut b = vec![0.0f32; n];
                let mut phase = 0.0f32;
                for (i, out) in b.iter_mut().enumerate() {
                    let u = i as f32 / (n - 1).max(1) as f32;
                    let base = 600.0 * (1.0 - u) + 150.0 * u;
                    let vib = 1.0 + 0.15 * (TAU * 9.0 * (i as f32 / SR)).sin();
                    phase += TAU * base * vib / SR;
                    *out = phase.sin() + 0.3 * (2.0 * phase).sin();
                }
                apply_env(&mut b, 0.01, 0.4);
                finish(b, 0.8)
            }
            Sfx::Bump => {
                let mut b = swept(140.0, 80.0, dur, &[1.0, 0.4]);
                let mut nz = noise(dur, 0x0123_4567);
                low_pass(&mut nz, 900.0);
                mix_at(&mut b, &nz, 0, 0.4);
                apply_env(&mut b, 0.001, 0.05);
                finish(b, 0.9)
            }
            Sfx::Explosion => {
                let mut b = noise(dur, 0xCAFE_BABE);
                low_pass(&mut b, 1200.0);
                apply_env(&mut b, 0.001, 0.18);
                let mut body = swept(90.0, 45.0, dur, &[1.0, 0.5]);
                apply_env(&mut body, 0.002, 0.25);
                mix_at(&mut b, &body, 0, 0.7);
                finish(b, 1.0)
            }
            Sfx::FireMortar => {
                let mut b = swept(110.0, 50.0, dur, &[1.0, 0.5, 0.2]);
                apply_env(&mut b, 0.003, 0.18);
                let mut nz = noise(dur, 0xABCD_0001);
                low_pass(&mut nz, 700.0);
                apply_env(&mut nz, 0.001, 0.08);
                mix_at(&mut b, &nz, 0, 0.35);
                finish(b, 0.95)
            }
            Sfx::FireLaser => {
                let mut b = swept(1500.0, 400.0, dur, &[1.0, 0.5, 0.25]);
                apply_env(&mut b, 0.002, 0.07);
                let mut nz = noise(dur, 0x5151_AAAA);
                low_pass(&mut nz, 3000.0);
                apply_env(&mut nz, 0.001, 0.03);
                mix_at(&mut b, &nz, 0, 0.15);
                finish(b, 0.8)
            }
            Sfx::FireDart => {
                let mut b = swept(820.0, 560.0, dur, &[1.0, 0.4, 0.15]);
                apply_env(&mut b, 0.003, 0.09);
                finish(b, 0.8)
            }
            Sfx::FireMine => {
                let mut b = swept(300.0, 170.0, dur, &[1.0, 0.5]);
                apply_env(&mut b, 0.003, 0.1);
                let mut nz = noise(dur, 0x9090_3333);
                low_pass(&mut nz, 1500.0);
                apply_env(&mut nz, 0.001, 0.04);
                mix_at(&mut b, &nz, 0, 0.3);
                finish(b, 0.85)
            }
        }
    }

    /// Target fundamental of engine band `i` (geometric spacing — pitch should
    /// feel proportional, not linear, across the range).
    pub fn engine_band_freq(i: usize) -> f32 {
        let t = i as f32 / (N_ENGINE_BANDS - 1) as f32;
        ENGINE_HZ_MIN * (ENGINE_HZ_MAX / ENGINE_HZ_MIN).powf(t)
    }

    /// One looping engine tone. The buffer holds an **exact integer number of
    /// fundamental cycles** (the length is chosen, then the frequency back-solved
    /// to fit), so it wraps seamlessly — and since every harmonic is an integer
    /// multiple, they all wrap too. No click at the loop point.
    pub fn synth_engine_band(i: usize) -> Vec<f32> {
        let f = engine_band_freq(i);
        let cycles = ((SR * 0.3) * f / SR).round().max(2.0); // ~0.3 s of tone
        let len = (cycles * SR / f).round() as usize;
        let f_eff = cycles * SR / len as f32; // exact integer cycles in `len`
        let harm = [1.0, 0.6, 0.4, 0.25, 0.15, 0.1]; // saw-ish engine buzz
        let mut b = vec![0.0f32; len];
        for (n, out) in b.iter_mut().enumerate() {
            let ph = TAU * f_eff * (n as f32 / SR);
            let mut s = 0.0;
            for (k, &a) in harm.iter().enumerate() {
                s += a * (ph * (k as f32 + 1.0)).sin();
            }
            *out = s;
        }
        normalize(&mut b, 0.85);
        b
    }

    /// The looping drift screech: two detuned saws (the tonal carrier) plus a
    /// band-limited noise hiss. The carrier alone wouldn't need help, but the
    /// noise would click at the seam, so the buffer is generated with a short
    /// tail overhang that is **overlap-added** back onto the head — yielding a
    /// genuinely seamless loop for arbitrary (noisy) content.
    pub fn synth_drift_loop() -> Vec<f32> {
        let dur = 0.4;
        let n = n_samples(dur);
        let w = n_samples(0.012); // 12 ms crossfade overhang
        let total = n + w;

        let mut b = vec![0.0f32; total];
        let (mut ph1, mut ph2) = (0.0f32, 0.0f32);
        for out in b.iter_mut() {
            ph1 += TAU * 330.0 / SR;
            ph2 += TAU * 347.0 / SR; // slight detune → beating screech
            let saw1 = 2.0 * (ph1 / TAU).rem_euclid(1.0) - 1.0;
            let saw2 = 2.0 * (ph2 / TAU).rem_euclid(1.0) - 1.0;
            *out = 0.5 * saw1 + 0.5 * saw2;
        }

        // Band-limited hiss: crude high-pass (signal minus its low-pass), then
        // tamed at the top.
        let mut nz = noise(total as f32 / SR, 0x00D2_1F77);
        let mut lp = nz.clone();
        low_pass(&mut lp, 1200.0);
        for (h, l) in nz.iter_mut().zip(lp.iter()) {
            *h -= *l;
        }
        low_pass(&mut nz, 4000.0);
        mix_at(&mut b, &nz, 0, 0.5);

        // Overlap-add the w-sample overhang onto the head: head[i] fades in while
        // the (continuous) overhang fades out, so head[0] == overhang[0] (which
        // followed sample n-1 in the source) → the wrap is continuous.
        for i in 0..w {
            let t = i as f32 / w as f32;
            b[i] = b[i] * t + b[n + i] * (1.0 - t);
        }
        b.truncate(n);
        normalize(&mut b, 0.7);
        b
    }

    // -- WAV container ------------------------------------------------------

    /// Wrap mono f32 PCM into a canonical 16-bit PCM WAV (what audrey/hound, the
    /// decoder behind `load_sound_from_bytes`, expects). 44-byte header + i16-LE
    /// samples; values are clamped to [-1, 1] before quantizing.
    pub fn encode_wav_mono16(pcm: &[f32], sample_rate: u32) -> Vec<u8> {
        let data_len = (pcm.len() * 2) as u32;
        let byte_rate = sample_rate * 2; // mono, 2 bytes/sample
        let mut v = Vec::with_capacity(44 + pcm.len() * 2);
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&1u16.to_le_bytes()); // mono
        v.extend_from_slice(&sample_rate.to_le_bytes());
        v.extend_from_slice(&byte_rate.to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes()); // block align
        v.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        for &s in pcm {
            let q = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            v.extend_from_slice(&q.to_le_bytes());
        }
        v
    }
}

// ----------------------------------------------------------------------------
// Tests — pure synth only, no audio device (the M7 headless DoD)
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::synth::*;
    use super::*;

    /// Every one-shot must be non-empty, finite, in range, and exactly the
    /// designed length.
    #[test]
    fn one_shots_are_valid_pcm() {
        for &s in &Sfx::ALL {
            let pcm = synth_sfx(s);
            assert_eq!(pcm.len(), n_samples(sfx_secs(s)), "{s:?} wrong length");
            assert!(!pcm.is_empty(), "{s:?} empty");
            assert!(pcm.iter().all(|x| x.is_finite()), "{s:?} has non-finite samples");
            assert!(
                pcm.iter().all(|&x| (-1.0..=1.0).contains(&x)),
                "{s:?} sample out of [-1, 1]"
            );
            // Actually makes noise (not all silence).
            assert!(pcm.iter().any(|&x| x.abs() > 0.05), "{s:?} is effectively silent");
        }
    }

    /// Engine bands + drift loop: valid PCM, ascending pitch, and clickless loops.
    #[test]
    fn loops_are_valid_and_seamless() {
        let mut buffers: Vec<Vec<f32>> = (0..N_ENGINE_BANDS).map(synth_engine_band).collect();
        buffers.push(synth_drift_loop());

        for (i, b) in buffers.iter().enumerate() {
            assert!(b.len() > 100, "loop {i} too short");
            assert!(b.iter().all(|x| x.is_finite()), "loop {i} non-finite");
            assert!(b.iter().all(|&x| (-1.0..=1.0).contains(&x)), "loop {i} out of range");

            // Seamlessness: the wrap discontinuity must be no larger than the
            // biggest step *inside* the buffer (so it can't click).
            let max_internal = b
                .windows(2)
                .map(|w| (w[1] - w[0]).abs())
                .fold(0.0f32, f32::max);
            let wrap = (b[0] - b[b.len() - 1]).abs();
            assert!(
                wrap <= max_internal * 1.5 + 1e-4,
                "loop {i} clicks: wrap {wrap} vs max internal {max_internal}"
            );
        }

        // Engine pitch rises monotonically across the bands.
        for i in 1..N_ENGINE_BANDS {
            assert!(
                engine_band_freq(i) > engine_band_freq(i - 1),
                "engine band {i} not higher pitched"
            );
        }
        assert!(engine_band_freq(0) >= 60.0);
        assert!(engine_band_freq(N_ENGINE_BANDS - 1) <= 320.0 + 1e-3);
    }

    /// The WAV header must declare a data length matching the sample count, with
    /// valid RIFF/WAVE/fmt/data magic — i.e. a real decoder will accept it.
    #[test]
    fn wav_header_is_well_formed() {
        let pcm = synth_sfx(Sfx::CountdownGo);
        let wav = encode_wav_mono16(&pcm, SAMPLE_RATE);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        assert_eq!(data_len, pcm.len() * 2, "declared data length must match PCM");
        assert_eq!(wav.len(), 44 + pcm.len() * 2, "total WAV size");
        let riff_len = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]) as usize;
        assert_eq!(riff_len, 36 + pcm.len() * 2, "RIFF chunk size");
    }

    /// The event queue is a fixed array: pushes past capacity neither grow nor
    /// panic (the zero-allocation invariant).
    #[test]
    fn sfx_queue_is_bounded_and_zero_alloc() {
        let mut q = SfxQueue::new();
        assert!(q.is_empty());
        for _ in 0..(SFX_QUEUE_CAP * 3) {
            q.push(Sfx::Bump);
        }
        assert_eq!(q.len(), SFX_QUEUE_CAP, "queue must cap at capacity");
        assert_eq!(q.as_slice().len(), SFX_QUEUE_CAP);
        q.clear();
        assert!(q.is_empty());
        q.push(Sfx::Pickup);
        assert_eq!(q.as_slice(), &[Sfx::Pickup]);
    }
}
