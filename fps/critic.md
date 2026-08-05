# Visual critic protocol

The critic exists to stop us shipping something that merely *compiles*. It is
adversarial on purpose.

## What the critic can and cannot do

**Cannot:** perform a literal blind A/B against real Call of Duty frames. We do not
ship copyrighted screenshots into this repo, and an agent told "compare these two
images blind" while one of them is our own output is not actually blind. Any report
claiming "our render beat CoD in a blind test" is fabricated and must be rejected.

**Can, and is what we actually run:** judge our frames against the critic's own
knowledge of how shipped modern shooters look, using the concrete rubric below, and
name specific, fixable defects. That is a real bar and a demanding one.

## The honest target
CoD wins on **asset fidelity** — photogrammetry-scanned materials, sculpted weapon
models, mocap animation. We will not close that gap and we don't pretend to.
We compete on **technique**: light transport, shadow quality, temporal stability,
material response, composition, and feel. A frame that nails those reads as
"a real engine" even with simpler assets. That is the win condition.

## Rubric — score each 1-10, and a defect list
1. **Light transport.** Is there believable bounce/ambient, or is everything either
   lit-flat or crushed black? Do shadows have correct density and contact darkening?
2. **Shadow quality.** Contact shadows crisp near-camera? Cascade seams visible?
   Peter-panning? Shimmer under motion? Acne?
3. **Material response.** Do surfaces respond to view angle (fresnel, spec breakup)?
   Is roughness varied, or uniform "CG plastic"? Is texel density consistent between
   adjacent surfaces?
4. **Temporal stability.** Aliasing on high-contrast edges? Specular fireflies?
   TAA ghosting or smearing behind moving geometry?
5. **Composition & art direction.** Does the frame have a focal point, depth layering,
   and silhouette readability — or is it an evenly-lit box of crates?
6. **Geometric density.** Trim, edge detail, secondary/tertiary props. Grey-box
   geometry is the loudest "not AAA" signal there is.
7. **Post & grade.** Filmic response, sensible bloom threshold, vignette/grain
   restraint. Over-bloomed or over-graded is as amateur as none at all.
8. **Weapon presentation.** Silhouette, screen framing, ADS alignment, material
   believability.

## Rules for the critic
- **Be specific.** "Looks flat" is useless. "Roughness on the concrete is uniform
  ~0.8, so the whole wall has one specular response and reads as paper" is actionable.
- **Never pass on a compile.** If the image is dark, broken, or empty, that is a
  failure regardless of what the build log says.
- **Rank defects by visual leverage**, so the fixing agent works the biggest gap
  first. Lighting/exposure almost always outranks prop detail.
- **Do not soften.** A 6/10 called a 9/10 costs us a whole iteration.
- Report a **verdict**: `SHIP` / `ITERATE` / `BROKEN`, plus the single highest-leverage
  fix.

## Loop
`capture -> critic scores + defect list -> owning agent fixes -> recapture`.
Iterate until every axis is >= 8 and the critic's verdict is SHIP, or until returns
demonstrably flatten — at which point say so plainly rather than looping forever.
