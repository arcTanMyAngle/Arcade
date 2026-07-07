//! race.rs — the Race Director (Milestone 1 of the Combat Grand Prix pivot).
//!
//! Wraps the driving toy in an actual *race*: a start countdown that freezes the
//! grid, checkpoint-validated laps, a live position/standing readout, and a
//! finish sequence with final standings.
//!
//! ## Anti-cheat checkpoint model
//! The loop is divided into [`NUM_CHECKPOINTS`] ordered sectors. A kart must
//! collect them **strictly in sequence** (`next_cp` ratchets forward by exactly
//! one). A lap is credited only when sector 0 (the finish line) is collected in
//! order. This makes the two classic Bézier-loop exploits impossible:
//!   * **Reversing across the line** — sector 0 won't match `next_cp`, no lap.
//!   * **Skipping/cutting a sector** — the skipped sector stays required; the
//!     ratchet never advances past a gap, so the lap can't close.
//!
//! ## Allocation policy
//! One `Vec<RaceProgress>` is allocated at construction and reused for the whole
//! session (cleared/overwritten in place on reset). The per-tick [`update`] is
//! heap-free, matching the rest of the engine. Standings are sorted into a
//! caller-owned buffer ([`standings_into`]).
//!
//! [`update`]: RaceDirector::update
//! [`standings_into`]: RaceDirector::standings_into

use crate::physics::KartState;
use crate::track_3d::TrackSpline;

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

/// Laps required to finish the race.
pub const TOTAL_LAPS: u8 = 3;

/// Ordered anti-cheat sectors around the loop. Higher = finer gating (harder to
/// shortcut) at a negligible per-tick cost. 24 ≈ one gate every ~15° of loop.
pub const NUM_CHECKPOINTS: u16 = 24;

/// Length of the pre-race countdown ("3..2..1") before the grid is released.
const COUNTDOWN_SECS: f32 = 3.5;
/// How long the "GO!" banner flashes after the grid is released.
pub const GO_FLASH_SECS: f32 = 0.8;

/// Rank-key sentinel base for finished karts: keeps them sorted above every
/// still-racing kart (whose key is `lap + progress` ≤ `TOTAL_LAPS + 1`).
const FINISHED_KEY_BASE: f32 = 10_000.0;

// ----------------------------------------------------------------------------
// Phases
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    /// Grid is frozen; the "3..2..1" timer is running.
    Countdown,
    /// The race is live.
    Racing,
    /// The player has crossed the line for the final lap; show the board.
    Finished,
}

// ----------------------------------------------------------------------------
// Per-kart race progress (parallel array — keeps KartState lean & Copy)
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct RaceProgress {
    /// The next sector that must be collected (the ratchet head).
    pub next_cp: u16,
    /// Last sector the kart was seen in (diagnostics / HUD minimap later).
    pub last_sector: u16,
    /// Finish-line crossings counted in order. 0 on the grid; the first crossing
    /// starts lap 1; the kart is done once this exceeds [`TOTAL_LAPS`].
    pub lap: u8,
    pub finished: bool,
    /// 1-based finishing place, assigned the instant the kart finishes (0 = N/A).
    pub finish_order: u8,
    /// Race-clock time at the moment of finishing.
    pub finish_time: f32,
    /// Continuous, lap-major progress used for live ordering. Higher = further
    /// ahead. For finished karts this is bumped above every racing kart's key.
    pub rank_key: f32,
}

impl RaceProgress {
    /// Fresh progress for a kart spawning in `spawn_sector`. The next required
    /// gate is the one immediately ahead, so the first finish-line crossing
    /// legitimately starts lap 1.
    fn starting(spawn_sector: u16) -> Self {
        Self {
            next_cp: (spawn_sector + 1) % NUM_CHECKPOINTS,
            last_sector: spawn_sector,
            lap: 0,
            finished: false,
            finish_order: 0,
            finish_time: 0.0,
            rank_key: 0.0,
        }
    }

    /// Feed normalized loop progress `pn ∈ [0,1)`. Advances the ratchet by at
    /// most one gate and returns `true` iff the finish line was crossed *in
    /// order* (i.e. a lap boundary). Pure and cheap — the unit tests drive it
    /// directly without a full sim.
    fn register(&mut self, pn: f32) -> bool {
        let sector = ((pn * NUM_CHECKPOINTS as f32) as u16).min(NUM_CHECKPOINTS - 1);
        self.last_sector = sector;
        if sector == self.next_cp {
            let crossed_line = self.next_cp == 0;
            self.next_cp = (self.next_cp + 1) % NUM_CHECKPOINTS;
            return crossed_line;
        }
        false
    }
}

// ----------------------------------------------------------------------------
// The director
// ----------------------------------------------------------------------------

pub struct RaceDirector {
    pub phase: Phase,
    /// Countdown-remaining counts *up* to [`COUNTDOWN_SECS`] in `Countdown`,
    /// then is reset and used as the race elapsed time in `Racing`/`Finished`.
    pub clock: f32,
    pub progress: Vec<RaceProgress>,
    finishers: u8,
    seg_count: f32,
}

impl RaceDirector {
    /// Build a director for an existing grid (reads each kart's `track_u`).
    pub fn new(track: &TrackSpline, karts: &[KartState]) -> Self {
        let mut d = Self {
            phase: Phase::Countdown,
            clock: 0.0,
            progress: vec![RaceProgress::starting(0); karts.len()],
            finishers: 0,
            seg_count: track.segment_count() as f32,
        };
        d.reset(track, karts);
        d
    }

    /// Re-arm the countdown and recompute every kart's starting sector. Call
    /// after respawning the grid (the `R` key).
    pub fn reset(&mut self, track: &TrackSpline, karts: &[KartState]) {
        self.phase = Phase::Countdown;
        self.clock = 0.0;
        self.finishers = 0;
        self.seg_count = track.segment_count() as f32;
        for (i, k) in karts.iter().enumerate() {
            let pn = self.progress_norm(k);
            let sector = ((pn * NUM_CHECKPOINTS as f32) as u16).min(NUM_CHECKPOINTS - 1);
            self.progress[i] = RaceProgress::starting(sector);
            self.progress[i].rank_key = pn; // lap 0
        }
    }

    /// Normalized position around the loop, `[0,1)`, in spline-parameter space.
    /// Parameter space is monotonic along the travel direction, which is all the
    /// ordering needs — and it's free (no arc-length lookup per kart per tick).
    #[inline]
    fn progress_norm(&self, k: &KartState) -> f32 {
        (k.track_u.rem_euclid(self.seg_count)) / self.seg_count
    }

    /// During the countdown and after the race, gameplay inputs are frozen.
    #[inline]
    pub fn inputs_locked(&self) -> bool {
        self.phase != Phase::Racing
    }

    /// Advance the director one fixed step. Heap-free.
    pub fn update(&mut self, karts: &[KartState], dt: f32) {
        match self.phase {
            Phase::Countdown => {
                self.clock += dt;
                if self.clock >= COUNTDOWN_SECS {
                    self.phase = Phase::Racing;
                    self.clock = 0.0; // becomes the race elapsed timer
                }
            }
            Phase::Racing => {
                self.clock += dt;
                for (i, k) in karts.iter().enumerate() {
                    let p = &mut self.progress[i];
                    if p.finished {
                        continue;
                    }
                    let pn = (k.track_u.rem_euclid(self.seg_count)) / self.seg_count;
                    if p.register(pn) {
                        p.lap += 1;
                        if p.lap > TOTAL_LAPS {
                            p.finished = true;
                            self.finishers += 1;
                            p.finish_order = self.finishers;
                            p.finish_time = self.clock;
                            // Park finished karts above all racers, ordered by place.
                            p.rank_key = FINISHED_KEY_BASE - p.finish_order as f32;
                        }
                    }
                    if !p.finished {
                        p.rank_key = p.lap as f32 + pn;
                    }
                }
                // The board pops the moment the human player is done.
                if self.progress[0].finished {
                    self.phase = Phase::Finished;
                }
            }
            Phase::Finished => {}
        }
    }

    // -- HUD queries --------------------------------------------------------

    /// Lap to display for a kart, 1-based and clamped to the race length.
    #[inline]
    pub fn display_lap(&self, kart: usize) -> u8 {
        self.progress[kart].lap.clamp(1, TOTAL_LAPS)
    }

    /// Live 1-based position of `kart`: one plus the number of karts strictly
    /// ahead by rank key.
    pub fn place_of(&self, kart: usize) -> u8 {
        let mine = self.progress[kart].rank_key;
        1 + self.progress.iter().filter(|p| p.rank_key > mine).count() as u8
    }

    /// Live 1-based position of the player (kart 0).
    #[inline]
    pub fn player_position(&self) -> u8 {
        self.place_of(0)
    }

    /// Fill `out` with every kart's live 1-based position (parallel to karts).
    /// Heap-free — the combat AI reads this each tick to play to standing.
    pub fn places_into(&self, out: &mut [u8]) {
        let n = self.progress.len().min(out.len());
        for i in 0..n {
            out[i] = self.place_of(i);
        }
    }

    /// Countdown banner text. Empty once the race is live.
    pub fn countdown_label(&self) -> &'static str {
        if self.phase != Phase::Countdown {
            return "";
        }
        let remaining = COUNTDOWN_SECS - self.clock;
        if remaining > 2.5 {
            "3"
        } else if remaining > 1.5 {
            "2"
        } else {
            "1"
        }
    }

    /// True for the brief "GO!" flash right after the grid releases.
    #[inline]
    pub fn show_go_flash(&self) -> bool {
        self.phase == Phase::Racing && self.clock < GO_FLASH_SECS
    }

    /// Fill `out` with kart indices ordered best→worst (place 1 first). Uses an
    /// insertion sort over the caller's buffer — no allocation, ideal for the
    /// tiny grid sizes this game runs.
    pub fn standings_into(&self, out: &mut [u8]) {
        let n = self.progress.len().min(out.len());
        for (i, slot) in out.iter_mut().enumerate().take(n) {
            *slot = i as u8;
        }
        for i in 1..n {
            let mut j = i;
            while j > 0
                && self.progress[out[j] as usize].rank_key
                    > self.progress[out[j - 1] as usize].rank_key
            {
                out.swap(j, j - 1);
                j -= 1;
            }
        }
    }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Center of sector `s` in normalized loop space.
    fn sector_pn(s: u16) -> f32 {
        (s as f32 + 0.5) / NUM_CHECKPOINTS as f32
    }

    #[test]
    fn sequential_lap_counts_once_per_loop() {
        // Spawn behind the line (last sector) → first gate required is sector 0.
        let mut p = RaceProgress::starting(NUM_CHECKPOINTS - 1);
        assert_eq!(p.next_cp, 0);

        let mut laps = 0u8;
        for _ in 0..3 {
            for s in 0..NUM_CHECKPOINTS {
                if p.register(sector_pn(s)) {
                    laps += 1;
                }
            }
        }
        // Three clean loops → exactly three finish-line crossings.
        assert_eq!(laps, 3);
    }

    #[test]
    fn skipping_a_sector_does_not_advance_the_ratchet() {
        let mut p = RaceProgress::starting(NUM_CHECKPOINTS - 1); // next_cp == 0
        assert!(p.register(sector_pn(0))); // collect the line, lap boundary
        assert!(!p.register(sector_pn(1)));
        assert!(!p.register(sector_pn(2)));
        let head = p.next_cp; // == 3
        // Jump far ahead, cutting the loop — gate must not advance.
        assert!(!p.register(sector_pn(12)));
        assert_eq!(p.next_cp, head, "ratchet advanced across a skipped sector");
    }

    #[test]
    fn reversing_across_the_line_grants_no_lap() {
        let mut p = RaceProgress::starting(NUM_CHECKPOINTS - 1);
        assert!(p.register(sector_pn(0))); // legit first crossing
        assert!(!p.register(sector_pn(1))); // now mid-lap, next_cp == 2
        // Reverse back over the finish line: sector 0 != next_cp(2) → no credit.
        assert!(!p.register(sector_pn(0)));
        assert_ne!(p.next_cp, 1, "a fake lap was credited on reverse-cross");
    }

    #[test]
    fn standings_order_leader_first() {
        let track = TrackSpline::demo_circuit();
        let karts: Vec<KartState> = (0..4).map(|i| KartState::spawn(&track, i)).collect();
        let mut d = RaceDirector::new(&track, &karts);
        // Hand-set progress: kart 2 leads, kart 0 last.
        d.progress[0].rank_key = 0.5;
        d.progress[1].rank_key = 1.5;
        d.progress[2].rank_key = 2.9;
        d.progress[3].rank_key = 1.0;
        let mut order = [0u8; 4];
        d.standings_into(&mut order);
        assert_eq!(order, [2, 1, 3, 0]);
        // Player (kart 0) is dead last of four.
        assert_eq!(d.player_position(), 4);
    }

    #[test]
    fn countdown_then_release() {
        let track = TrackSpline::demo_circuit();
        let karts: Vec<KartState> = (0..2).map(|i| KartState::spawn(&track, i)).collect();
        let mut d = RaceDirector::new(&track, &karts);
        assert!(d.inputs_locked());
        assert_eq!(d.phase, Phase::Countdown);
        for _ in 0..(COUNTDOWN_SECS / (1.0 / 60.0)) as i32 + 2 {
            d.update(&karts, 1.0 / 60.0);
        }
        assert_eq!(d.phase, Phase::Racing);
        assert!(!d.inputs_locked());
    }
}
