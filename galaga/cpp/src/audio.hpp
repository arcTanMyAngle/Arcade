// audio.hpp — tiny procedural sound manager (no asset files).
// Each cue is a short tone synthesized into a raylib Wave at load time, so every
// event is audibly distinct without shipping any .wav files. Swap in real samples
// later by replacing the makeBeep() calls in Sfx::load().
#pragma once
#include "raylib.h"
#include <cmath>
#include <cstdlib>

namespace gg {

enum class SfxId { Fire, Kill, BossHit, PlayerDeath, TractorBeam, Capture, COUNT };

enum class Wf { Sine, Square, Noise, SweepDown, SweepUp, Warble };

// Synthesize a short mono 16-bit tone into a Sound. Caller owns the returned Sound
// (unload via UnloadSound). Uses a quick exponential decay so beeps don't click.
inline Sound makeBeep(float freq, float dur, Wf shape, float vol = 0.35f) {
    const int rate = 22050;
    Wave w{};
    w.frameCount = (unsigned)(rate * dur);
    w.sampleRate = rate;
    w.sampleSize = 16;
    w.channels   = 1;
    short* data  = (short*)malloc((size_t)w.frameCount * sizeof(short));
    w.data       = data;

    for (unsigned i = 0; i < w.frameCount; ++i) {
        float t   = (float)i / rate;
        float p   = (float)i / w.frameCount;          // 0..1 progress
        float env = expf(-3.0f * p);                  // decay envelope
        float ph  = 2.0f * PI * freq * t;
        float s   = 0.0f;
        switch (shape) {
            case Wf::Sine:      s = sinf(ph); break;
            case Wf::Square:    s = sinf(ph) >= 0 ? 1.0f : -1.0f; break;
            case Wf::Noise:     s = ((float)rand() / RAND_MAX) * 2.0f - 1.0f; break;
            case Wf::SweepDown: s = sinf(2.0f * PI * (freq * (1.0f - 0.6f * p)) * t); break;
            case Wf::SweepUp:   s = sinf(2.0f * PI * (freq * (0.6f + 0.9f * p)) * t); break;
            case Wf::Warble:    s = sinf(ph + 4.0f * sinf(2.0f * PI * 18.0f * t)); break;
        }
        float v = s * env * vol;
        if (v >  1.0f) v =  1.0f;
        if (v < -1.0f) v = -1.0f;
        data[i] = (short)(v * 32767.0f);
    }

    Sound snd = LoadSoundFromWave(w);
    UnloadWave(w);
    return snd;
}

struct Sfx {
    Sound snd[(int)SfxId::COUNT]{};
    bool  ready = false;

    // Call after InitAudioDevice() has succeeded.
    void load() {
        snd[(int)SfxId::Fire]        = makeBeep(880.0f, 0.10f, Wf::Square);
        snd[(int)SfxId::Kill]        = makeBeep(200.0f, 0.30f, Wf::Noise, 0.45f);
        snd[(int)SfxId::BossHit]     = makeBeep(440.0f, 0.12f, Wf::Square);
        snd[(int)SfxId::PlayerDeath] = makeBeep(330.0f, 0.55f, Wf::SweepDown, 0.5f);
        snd[(int)SfxId::TractorBeam] = makeBeep(260.0f, 0.60f, Wf::Warble, 0.4f);
        snd[(int)SfxId::Capture]     = makeBeep(520.0f, 0.45f, Wf::SweepUp, 0.45f);
        ready = true;
    }

    void unload() {
        if (!ready) return;
        for (int i = 0; i < (int)SfxId::COUNT; ++i) UnloadSound(snd[i]);
        ready = false;
    }

    void play(SfxId id) const {
        if (ready) PlaySound(snd[(int)id]);
    }
};

} // namespace gg
