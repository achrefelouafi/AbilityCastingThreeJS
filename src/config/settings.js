/**
 * settings.js — the single source of truth for every tweakable value in the sandbox.
 *
 * Nothing in the renderer owns state that lives here: shaders, particle systems,
 * lights and post processing all *read* these objects every frame. That is what
 * makes the real-time editor work without rebuilding anything — mutating a field
 * is immediately visible on screen, including on a prison that is already
 * standing, and including while the clock is paused (`P`), which is when the
 * shapes are actually worth tuning.
 *
 * The one rule that keeps that promise: a system may only ever *sample* these
 * values. It must never copy one into a record at spawn time and read it back
 * later — see `CorruptedShardAbility`, whose cast captures nothing but a seed
 * and a handful of timestamps, and resolves every metre, radian and second
 * against this file each frame.
 *
 * Conventions
 *  - Colours are stored as `#rrggbb` strings so lil-gui can bind them directly.
 *    Use `utils/color.js#getColor()` to read them as a cached THREE.Color.
 *  - `global` holds multipliers that scale everything at once (1 = neutral).
 *  - The per-ability blocks (`flux`, `voidslash`, `glacial`, `drone`, …) hold absolute values.
 *
 * Every ability block is keyed by its id in `ELEMENTS`, and the shared systems
 * that need to know about "the ability the player is currently holding" — the
 * aim controller, the cooldown, the HUD — look it up as `settings[element]`.
 * The four fields they rely on being present are `range`, `minRange`, `speed`
 * and `cooldown`; everything else in a block is that ability's own business.
 * A **far cast** (`CastShape.ZONE`, declared in `ELEMENT_META`) adds a fifth:
 * `zoneRadius`, the footprint the circle indicator measures out.
 */

/**
 * The cast animations shipped alongside the rig, in `public/models/<id>.fbx`.
 *
 * Every ability block carries a `castAnim` naming one of these, so each spell
 * can throw the body differently; `CharacterController` loads all of them once
 * at boot and keeps only their clips, and the editor turns this array straight
 * into the per-ability dropdown.
 */
export const CAST_ANIMATIONS = ['cast1', 'cast2', 'cast3'];

export const settings = {
  /* ------------------------------------------------------------------ */
  /* Global multipliers                                                  */
  /* ------------------------------------------------------------------ */
  global: {
    timeScale: 1.0, // slow-mo / fast forward for the whole simulation
    speed: 1.0, // eruption travel speed multiplier
    lifetime: 1.0, // ability lifetime multiplier
    glow: 1.0, // emissive multiplier fed into bloom
    shaderIntensity: 1.0, // master strength of every procedural shader effect
    noiseStrength: 1.0,
    noiseFrequency: 1.0,
    noiseSpeed: 1.0,
    turbulence: 1.0,
    randomness: 1.0, // per-instance / per-particle jitter multiplier
    particleCount: 1.0,
    particleLifetime: 1.0,
    particleSpeed: 1.0,
    particleSize: 1.0,
    emissionRate: 1.0,
    lightIntensity: 1.0,
    lightRadius: 1.0,
    distortion: 1.0,
    fresnel: 1.0,
    opacity: 1.0,
    animationSpeed: 1.0, // character animation playback rate
    cameraShake: 1.0,
    explosionIntensity: 1.0
  },

  /* ------------------------------------------------------------------ */
  /* The aim indicator — the ground arrow drawn while the cast is armed  */
  /* ------------------------------------------------------------------ */
  /**
   * A League-style skillshot indicator: one ground quad with a signed-distance
   * arrow in its fragment shader, so every dimension below is in *metres* and
   * nothing is a texture. The quad is rebuilt from these numbers each frame,
   * which is why dragging `range` while aiming stretches the arrow live.
   */
  aim: {
    /* --- silhouette (metres) --- */
    shaftWidth: 0.42, // half-width of the shaft
    headLength: 2.6, // length of the arrowhead
    headWidth: 1.35, // half-width at the base of the head
    round: 0.12, // corner rounding of the whole silhouette
    startOffset: 0.9, // gap between the caster and the tail of the arrow

    /* --- rendering --- */
    edge: 0.09, // outline thickness, metres
    edgeGlow: 2.6, // how hard the outline blooms
    softness: 0.06, // feather on the outer edge
    fill: 0.3, // opacity of the interior wash
    fillFalloff: 1.1, // how fast the wash fades from the axis to the edge
    opacity: 1.0,

    /* --- energy running up the shaft --- */
    stripes: 0.55, // chevrons per metre
    stripeSharp: 0.62, // 0 = soft gradient, 1 = hard bars
    stripeDepth: 0.55, // how much they modulate the fill
    scrollSpeed: 2.4, // metres/second they travel toward the tip
    pulse: 0.28, // brightness breathing
    pulseSpeed: 2.2,

    /* --- frost break-up --- */
    noise: 0.45, // how much noise eats into the fill
    noiseScale: 1.6, // features per metre
    noiseSpeed: 0.35,
    crystals: 0.55, // voronoi frost plates over the interior
    crystalScale: 2.4,

    /* --- furniture --- */
    baseRing: 0.62, // radius of the ring at the caster's feet, metres
    baseRingWidth: 0.06,
    tipGlyph: 0.9, // strength of the crystal rosette at the impact point
    tipGlyphSize: 1.15, // radius of that rosette, metres
    tipSpin: 0.45, // revolutions/second
    rangeArc: 0.55, // brightness of the max-range cap
    reveal: 0.055, // seconds for the arrow to sweep out when armed

    /* --- colour --- */
    colorCore: '#ecfbff',
    colorEdge: '#3fb4ff',
    colorInvalid: '#ff6a5c', // shown when the target is inside `minRange`

    height: 0.035 // hover distance above the floor, metres
  },

  /* ------------------------------------------------------------------ */
  /* The far-cast indicator — the circle drawn at the target point       */
  /* ------------------------------------------------------------------ */
  /**
   * The other half of the targeting vocabulary. Where `aim` draws an arrow
   * along a line, this draws the **footprint**: a disc dropped at the cursor
   * with a deliberately thick boundary, because the one thing a ground-targeted
   * AoE has to answer before you click is *how much space is this going to
   * take*. The band is the answer, and the ability's own field is built to land
   * exactly on it.
   *
   * Two meshes, both parametric:
   *  - the **footprint**, a quad whose fragment shader is a signed-distance
   *    ring evaluated in metres from the target;
   *  - the **reach ring**, a ribbon strip bent into a circle at the caster's
   *    feet at `range` — a far cast needs to show where its arm ends.
   *
   * Shared by every far cast, so a new one inherits the whole indicator and
   * only brings its own `zoneRadius`.
   */
  zone: {
    /* --- the boundary (metres) --- */
    boundary: 0.34, // thickness of the band that *is* the footprint edge
    // Held under 2: the band is already the widest mark on the circle, and
    // pushing the gain past this clips it to flat white and throws away the
    // hue that says which ability you are holding.
    boundaryGlow: 1.8, // how hard it blooms
    boundaryBias: 0.35, // <0.5 grows the band inward, >0.5 outward
    liner: 0.05, // thin bright liner riding the inside of the band
    softness: 0.05, // feather on both lips

    /* --- the interior --- */
    fill: 0.22, // opacity of the wash inside the circle
    fillFalloff: 1.5, // >1 keeps the middle clear and crowds it to the rim
    rings: 2.0, // concentric contour rings across the radius
    ringWidth: 0.05,
    ringSpeed: 0.35, // how fast they travel outward, radii/second
    crawl: 0.75, // filaments crawling over the interior
    crawlScale: 1.3, // filaments per metre
    crawlSpeed: 0.45,
    noise: 0.4, // break-up eating into the wash
    noiseScale: 1.2,

    /* --- furniture --- */
    ticks: 24, // marks stepping around the boundary
    tickLength: 0.42, // how far they reach in, metres
    tickWidth: 0.2, // duty cycle, 0..1
    tickSpin: 0.06, // revolutions/second
    sweep: 0.55, // radar sweep brightness
    sweepSpeed: 0.4, // revolutions/second
    core: 0.85, // the mark at the exact target point
    coreSize: 0.4, // its radius, metres
    crosshair: 0.5, // four arms pointing out of the core
    crosshairLength: 1.1,
    pulse: 0.22, // brightness breathing
    pulseSpeed: 2.0,

    /* --- the reach ring at the caster --- */
    reach: 0.7, // brightness of the max-range circle, 0 hides it
    reachWidth: 0.05, // its half-width, metres
    reachDashes: 64, // dashes around it (0 = solid)
    reachDashGap: 0.42, // fraction of each dash that is gap
    reachSpin: 0.03, // revolutions/second the dashes creep
    reachLead: 0.9, // how much brighter the arc nearest the cursor is
    reachSegments: 192, // tessellation of that circle

    /* --- rendering --- */
    opacity: 1.0,
    reveal: 0.07, // seconds the circle takes to snap out when armed
    snap: 1.18, // how far past its radius it overshoots on the way out
    height: 0.035, // hover distance above the floor, metres

    /* --- colour --- */
    colorCore: '#eaf7ff',
    colorEdge: '#7c6bff',
    colorInvalid: '#ff6a5c' // shown when the target is inside `minRange`
  },

  /* ------------------------------------------------------------------ */
  /* Character                                                           */
  /* ------------------------------------------------------------------ */
  character: {
    /* --- blending the cast clip over the idle --- */
    // The idle loops forever; a cast clip is a one-shot laid over the top of it,
    // so these are the two edges of that overlap. In fast, out soft: the throw
    // has to land on the frame you clicked, the recovery does not.
    castBlendIn: 0.12, // seconds to cross-fade from the idle into the cast
    castBlendOut: 0.3, // seconds to fall back to the idle once it finishes

    /* --- how the body sells the cast --- */
    turnToAim: true, // face the arrow while aiming
    turnRate: 0.0002, // fraction of the heading gap left after 1s (lower = snappier)
    castLean: 0.34, // radians the torso pitches forward on release
    castRecoil: 0.16, // metres the body is shoved back
    castSettle: 2.6 // seconds⁻¹ the lunge decays at
  },

  /* ------------------------------------------------------------------ */
  /* Target dummies — what the abilities are aimed at                    */
  /* ------------------------------------------------------------------ */
  /**
   * The practice targets: rigged bodies standing in a ring, one-shot by any
   * cast that reaches them, thrown by a ragdoll rather than an animation.
   *
   * See `combat/DummyField.js` for how a hit is derived (no ability knows these
   * exist — the volume is read off the cast line every frame) and
   * `combat/Ragdoll.js` for the fall itself.
   */
  dummies: {
    enabled: true,
    /** How many are standing at any moment. */
    count: 6,
    /** Metres from the caster they stand inside, and no nearer than. */
    radius: 13.0,
    minRadius: 5.0,
    /** Metres between two of them, so they never share a patch of floor. */
    separation: 2.4,
    /** Normalised height, metres — the same treatment the player's rig gets.
     *  Read once, when the model is loaded. */
    height: 1.78,
    /** The cylinder a cast has to touch to count as a hit, metres. */
    bodyRadius: 0.42,

    /** Whether they turn to watch the caster, and how fast (lower = snappier). */
    watch: true,
    turnRate: 0.02,

    /** Seconds a corpse lies there, then the seconds it takes to burn away. */
    corpseTime: 4.5,
    dissolveTime: 1.3,
    /** Seconds before a burnt-away body stands back up somewhere else. */
    respawnDelay: 2.0,

    /**
     * What lands the hit.
     *
     * A line cast sweeps a capsule of `radius` from the caster to its front; a
     * far cast is a disc of `zoneRadius × zoneScale` at the target point, armed
     * the frame the front gets there. One touch is a kill — these are targets,
     * not enemies, and the numbers below are about how the body *flies*.
     */
    hit: {
      enabled: true,
      radius: 1.5, // half-width of a line cast's kill capsule, metres
      zoneScale: 1.0, // the far cast's own footprint, × its circle
      impulse: 6.0, // metres/second the body leaves at, along the blow
      lift: 3.4, // metres/second it is thrown upward
      spin: 1.4 // extra impulse per body-height above the hips — the torque
    },

    /**
     * The look. The export carries no textures at all, so this is authored
     * rather than imported: a cold near-black body with a bright rim, which is
     * the one combination that stays legible at fifteen metres against a floor
     * this dark, and the ember burn that takes the corpse away.
     */
    look: {
      color: '#1b2029',
      roughness: 0.78,
      metalness: 0.15,
      /** The rim that draws the silhouette. */
      rimColor: '#6fd2ff',
      rimPower: 2.6,
      rimEmissive: 1.5,
      /** The burn edge as they dissolve, and how wide that band is. */
      edgeColor: '#8fe6ff',
      edgeEmissive: 6.0,
      edgeWidth: 0.12,
      /** Features per metre in the dissolve noise. */
      dissolveDetail: 9.0
    },

    /**
     * The ragdoll — see `combat/Ragdoll.js` for what these actually drive.
     *
     * It is a particle per joint, the bone lengths as distance constraints and
     * a few braces across the pelvis and chest, solved by relaxation. `gravity`
     * is deliberately heavier than earth: a body that falls at 9.8 on a screen
     * this size reads as slow motion, and every game does the same thing.
     */
    ragdoll: {
      gravity: -19.0,
      /** Fraction of the velocity the air takes per second. */
      damping: 0.06,
      /** Relaxation passes per substep. More = stiffer. */
      iterations: 7,
      /** How hard the braces pull compared to the bones themselves. */
      brace: 0.45,
      /** Metres a joint stands off the floor, and how it lands on it. */
      radius: 0.075,
      friction: 0.75,
      bounce: 0.06,
      /** Below this much movement per second, the body is asleep and free. */
      sleep: 0.03
    }
  },

  /* ------------------------------------------------------------------ */
  /* The cut                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * What happens to a body when the blow that felled it came with an edge on
   * it — see `combat/Dummy.js#_cut` and `combat/Ragdoll.js#collideRagdolls`.
   *
   * Nothing in the sandbox slices by default: a cast has to *ask* for it by
   * passing `slice = true` to `Dummy#kill`, and nothing in the current set does
   * — the machinery stays for the next one that wants it. Everything here is about the
   * two halves — where the plane sits, how hard they are driven apart, what
   * each of them does with the blow, and how they behave once they are lying on
   * each other.
   */
  slice: {
    enabled: true,
    /**
     * Where the plane sits, as a fraction of the body's own height.
     *
     * 0.60 is the waist on this export — between the hip joint and the base of
     * the spine. Below it and the plane goes through the pelvis, which leaves
     * the top half with a slab of hip hanging off it; much above and the legs
     * walk away with the ribcage.
     */
    height: 0.6,
    /** Degrees it is tilted off horizontal, tipping away along the blow. */
    tilt: 16,
    /** Metres the upper half is lifted clear on the frame the body parts. */
    separation: 0.09,
    /**
     * m/s the halves are driven *apart* along the blow, on top of whatever each
     * already took of it.
     *
     * The top half gets it the way the lance went and the legs get it the other
     * way, so the two travel in opposite directions instead of following each
     * other into the same heap — the difference between reading the cut and
     * reading a body that fell over in two bits. Added evenly rather than
     * weighted up the body (`Ragdoll#shove`), so neither half is spun by it:
     * the fold is the blow's doing, this only separates them.
     */
    split: 1.8,
    /**
     * What each half does with the blow, as multipliers on `impulse` / `lift` /
     * `spin`. The top of a body cut in half leaves with most of what the lance
     * had; the bottom is a pair of legs that fold.
     *
     * Well under 1 rather than over it, which reads backwards until you see
     * why: `spin` is applied per *body height*, and half a body is half as
     * tall, so the same number throws its head twice as hard.
     */
    upper: { impulse: 0.78, lift: 0.72, spin: 0.55 },
    lower: { impulse: 0.22, lift: 0.1, spin: 0.2 },

    /**
     * The two halves as solid things — see `collideRagdolls`.
     *
     * `radius` is the base; every joint scales it by its own size (a pelvis is
     * a chunk, a wrist is not). `maxPush` is what keeps it from exploding: it
     * caps how far one frame may separate a pair, so an overlap that starts
     * deep opens over several frames instead of firing the halves apart.
     */
    collide: {
      enabled: true,
      /** Metres, before each joint's own size multiplier. */
      radius: 0.09,
      /** How much of the closing speed comes back, and how much slide is lost. */
      bounce: 0.2,
      friction: 0.45,
      /** Metres a single frame may push one pair apart. */
      maxPush: 0.05
    },

    /** What the cut opens, and how much it glows in its own right. */
    interiorColor: '#2a1a14',
    interiorEmissive: 0.35,
    /** The hot line the edge leaves, and how wide that band is (× height). */
    edgeColor: '#b9ff72',
    edgeEmissive: 4.0,
    edgeWidth: 0.014
  },

  /* ================================================================== */
  /* FLUX — Shimmering Flux of Chaos                                     */
  /* ================================================================== */
  /**
   * A crimson tear thrown down the aimed line. Reference for the look: the
   * six-panel VFX breakdown sheet — conical mesh trail, fluid blood splatter,
   * chaotic energy ribbons, glinting sparkles, distortion wave, lingering
   * crimson motes — and this block is grouped in exactly those six sections so
   * that a panel of the sheet and a folder of the editor are the same thing.
   *
   * There is no seventh section, and that is a decision rather than an
   * omission: no impact shell, no scorch decal, no screen flash. The sheet says
   * what this effect is made of, and anything else added at the strike would be
   * the reflex that makes every ability look like every other one.
   *
   * Two units are in play, and mixing them up is the only way to get lost here:
   *
   *  - anything about the **cast** is in metres, because it is laid out against
   *    the aim indicator — `range`, `coneLength`, `coneRadius`, `ribbonSpan`;
   *  - anything about the **cone's surface** is in its own parameter space,
   *    where `u` runs 0 → 1 from the head to the mouth and `v` goes once
   *    around. `coneRings`, `coneRibs`, `coneSpiralTurns` and `coneHead` are
   *    counts and fractions in that space, not metres, which is what lets a
   *    two-metre funnel and a ten-metre one carry the same mesh.
   *
   * The palette is the load-bearing decision and it is worth stating plainly:
   * the **energy is crimson going rose** and the **matter is dark**. Blood
   * that glows is not blood — it is more light — so the one non-additive layer
   * in here is kept nearly black in shadow and earns its brightness from a wet
   * highlight instead. Swapping that round gives a red firework with pink
   * confetti in it, which is exactly what the sheet is not.
   */
  flux: {
    /* --- the cast --- */
    range: 28.0, // maximum cast distance, metres
    minRange: 3.5, // closer than this and the cast is refused
    speed: 24.0, // how fast the flux flies, metres/second
    burstTime: 0.8, // seconds it takes to tear itself apart on impact
    fadeTime: 1.1, // seconds what is left of it takes to go out
    cooldown: 1.4,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight path (materials/FluxSpine.js) --- */
    // Not a straight line. The whole ability is placed against p(s), a pure
    // function of metres travelled, so the weave below is *the shape of the
    // corridor* — the funnel bends along it, the ribbons wind about it and the
    // motes are left lying on it. Two sines rather than noise, because the JS
    // and GLSL halves of that function have to agree to the last digit.
    weave: 0.7, // amplitude of the wander, metres
    weaveWaves: 0.5, // radians per metre — the long swing
    weaveWaves2: 1.15, // ... and the short one riding on it
    weaveRise: 0.7, // the vertical wander, × the lateral one
    launchHeight: 1.35, // where it leaves the caster's hand, metres
    flightHeight: 1.9, // its cruise height
    riseDistance: 4.5, // metres it takes to settle onto that height
    trailSpan: 11.0, // metres of trail the emitters seed along

    /* --- 1 · the conical mesh trail --- */
    // The funnel trails: its nose is the front of the whole ability and it
    // flares open behind, where the trails take over and leave through it.
    coneLength: 5.6, // metres of path the funnel reaches back over
    coneRadius: 1.7, // radius at the trailing mouth, metres
    coneTip: 0.12, // radius at the leading nose, x the mouth's
    coneFlare: 0.7, // 1 is a straight-sided cone, <1 a trumpet, >1 a horn
    coneRings: 13.0, // rings across it (integers — the mesh wraps)
    coneRibs: 15.0, // ribs around it
    coneSpiralArms: 2.0, // helices wound down it
    coneSpiralTurns: 1.4, // turns each makes over the length
    coneSpiralSpin: 0.45, // turns/second they roll
    coneFlow: 1.4, // rings/second travelling toward the head
    coneWire: 1.0, // ring and rib width, pixels
    coneSpiralWire: 1.3, // helix width, pixels
    coneMesh: 0.5, // how strongly the rings and ribs read
    coneSpiral: 0.62, // ... and the helices, which carry the panel
    coneFill: 0.4, // the translucent membrane between the lines
    coneFresnel: 0.85, // the silhouette term that makes it a volume
    coneFresnelPower: 2.6,
    coneErode: 0.35, // how hard the noise eats through the surface
    coneErodeScale: 1.7,
    coneErodeSpeed: 1.1,
    coneWobble: 0.15, // how far the surface is pushed off a clean cone
    coneWobbleScale: 1.6,
    coneWobbleSpeed: 1.0,
    coneHead: 0.03, // how far back the white nose tip reaches
    coneNoseFade: 0.12, // how much of the leading point is capped — see the shader
    coneTailFade: 0.96, // where along the funnel the mouth starts dissolving
    conePulse: 1.0, // charge running up it toward the head
    conePulseFreq: 2.0,
    conePulseSpeed: 1.2,
    coneBurstFlare: 0.9, // how far the mouth blows open on the strike
    coneIntensity: 1.5,
    coneOpacity: 0.85,
    coneSoftFade: 0.4, // metres of soft fade where it meets geometry
    colorConeCore: '#ffbccd',
    colorCone: '#ff2d55',
    colorConeTail: '#4a0c22',

    /* --- 2 · the fluid blood splatter --- */
    // Half mesh, half particles. The ligaments are drawn as strands that
    // stretch (`bloodNeck` — the trailing end is thrown slower than the leading
    // one) and bead (`bloodBeads`) until they pinch off; the droplets are what
    // they pinch off *into*, so both halves are thrown with the same numbers
    // and read as one substance.
    ligaments: 14.0, // strands in flight (capped at 16)
    bloodRate: 3.2, // throws per second, per strand
    bloodLife: 0.7, // seconds one ligament lasts
    bloodThrow: 3.6, // how hard the fluid is thrown, metres/second
    bloodBack: 1.15, // how much of that is backwards along the path
    bloodForward: 0.9, // ... and forwards instead, on the strike
    bloodBurstThrow: 1.6, // extra throw on the strike, × the above
    bloodSpread: 1.0, // how far off the axis
    bloodCarry: 0.32, // fraction of the head's own speed the fluid keeps
    bloodRootSpread: 5.0, // metres back along the trail a strand may tear from
    bloodGravity: 7.5,
    bloodNeck: 0.72, // how much slower the trailing end is — the stretch
    bloodCurl: 1.9, // how far a strand bows as it flies
    bloodWidth: 0.2, // half-width at the fat end, metres
    bloodTaper: 1.5, // how fast it thins toward the tail
    bloodBeads: 0.7, // the capillary beading along it
    bloodBeadFreq: 2.2, // beads over the strand
    bloodNeckDepth: 0.65, // how far it thins before it breaks
    bloodGloss: 28.0, // tightness of the wet highlight
    bloodSheen: 0.9, // its strength
    bloodRim: 0.55, // light coming through where the strand is thin
    bloodOpacity: 1.0,
    bloodSoftFade: 0.25,
    colorBloodDeep: '#26010a', // in its own shadow
    colorBlood: '#6e0512', // lit
    colorBloodSheen: '#ffb9bf', // the wet highlight — the colour of the light
    colorBloodRim: '#c01526', // lit through, where it has necked

    /* --- 2 · ... and the droplets it breaks into --- */
    dropRate: 90.0, // droplets/second
    dropRadius: 0.14, // how far off the strand they are born, metres
    dropSize: 0.12, // metres across
    dropLifetime: 1.1,
    dropGravity: 9.5,
    dropStretch: 0.5, // how far a fast bead elongates
    dropOpacity: 1.0,
    dropGlow: 1.0, // matter, not light — leave this at 1
    burstDrops: 160.0, // thrown by the strike
    colorDropA: '#d8455a',
    colorDropB: '#8e0a19',
    colorDropC: '#5e0611',
    colorDropD: '#1e0206',

    /* --- 3 · the chaotic energy ribbons --- */
    ribbons: 9.0, // strands (capped at 12)
    ribbonSpan: 13.0, // metres of path they reach back over
    ribbonLead: 0.0, // ... and where they start: negative, so they leave the
    //                     cone's apex rather than its mouth
    ribbonRadius: 0.95, // the coil under the chaos, metres
    ribbonCoil: 0.7, // turns each makes over the span
    ribbonSpin: 0.3, // turns/second the tangle rolls
    ribbonSwell: 0.55, // how fast they splay out behind the head
    ribbonChaos: 1.7, // how far the noise throws them off, metres
    ribbonChaosScale: 1.05,
    ribbonChaosSpeed: 0.45,
    // The composite has two kinds of trail behind the cone and needs both: the
    // straight ones hold the line of the shot, the rest tangle around them.
    ribbonStraight: 0.16, // fraction of strands that run straight
    ribbonStraightRadius: 0.22, // their orbit radius, × the tangle's
    ribbonStraightChaos: 0.12, // their wander, × the tangle's
    ribbonStraightWidth: 0.6, // their width, × the tangle's
    ribbonWidth: 0.3, // half-width at the head, metres
    ribbonWidthTip: 0.16, // that width at the tail, as a multiple
    ribbonTwist: 0.9, // how much the strip rolls about its own tangent
    ribbonTwistTurns: 2.0, // turns of that over the span
    ribbonTwistSpeed: 0.35, // turns/second on top
    ribbonTwistFace: 0.15, // the floor under the width when it is edge-on
    ribbonSharp: 2.0, // falloff across the ribbon
    ribbonCore: 40.0, // the hard thread down the middle of it
    ribbonPulse: 1.1, // charge running up it
    ribbonPulseFreq: 2.0,
    ribbonPulseSpeed: 1.2,
    ribbonFlicker: 0.35, // it is chaos — let it stutter
    ribbonFlickerScale: 6.0,
    ribbonFlickerSpeed: 2.4,
    ribbonTailFade: 0.82, // where it dissolves into the wake
    ribbonIntensity: 1.05,
    ribbonOpacity: 0.72,
    ribbonSoftFade: 0.35,
    colorRibbonCore: '#ffa9c0',
    colorRibbon: '#ff2447', // half the strands run crimson ...
    colorRibbonAlt: '#ff3d6e', // ... and half a deeper rose. This split is the layer.
    colorRibbonTail: '#54061e',

    /* --- 4 · the glinting sparkles --- */
    glintRate: 300.0, // sparkles/second
    glintRadius: 2.2, // how far off the trail they are born, metres
    glintSize: 0.17, // metres across
    glintLifetime: 1.5,
    glintSpeed: 1.2,
    glintRise: 0.15,
    glintDrift: 0.5, // how hard they are left behind
    glintSpin: 1.2, // radians/second the star turns
    glintTurbulence: 0.35,
    glintGlow: 2.6,
    castGlints: 40.0, // thrown as the flux opens in the hand
    burstGlints: 220.0, // ... and by the strike
    colorGlintA: '#ffffff',
    colorGlintB: '#ffd0d8',
    colorGlintC: '#ff3a5c',
    colorGlintD: '#5e0c22',

    /* --- 5 · the distortion wave (LAYER.DISTORTION) --- */
    warpSize: 3.6, // the proxy's reach around the head, metres
    warpLens: 0.75, // the bulb that displaces along the heading
    warpLensPower: 1.7, // how tightly it is packed into the middle
    warpChurn: 0.5, // how hard the lens boils
    warpScale: 1.6,
    warpSpeed: 1.3,
    warpWave: 0.65, // the ring packets shed off the head
    warpWaveRate: 1.5, // waves/second
    warpWaveWidth: 0.15, // depth of one packet, × the proxy's radius
    warpRipples: 9.0, // bands inside it
    warpBurst: 1.5, // the wave the strike fires
    warpBurstLife: 0.7, // seconds it lasts
    warpBurstSpeed: 16.0, // metres/second it crosses
    warpBurstSize: 1.6, // how far the proxy grows for it, × its size
    warpBurstWidth: 0.2,
    warpStrength: 1.0,

    /* --- 6 · the lingering crimson motes --- */
    // The layer that is still on screen when everything else has gone. Long
    // lived, heavily dragged and curl driven, so they stop where the flux left
    // them and then drift rather than flying anywhere.
    moteRate: 260.0, // motes/second
    moteRadius: 1.6, // how far off the trail they are born, metres
    moteSize: 0.16, // metres across - small, many and faint: the haze
    moteLifetime: 3.0,
    moteSpeed: 0.8,
    moteRise: 0.22,
    moteDrift: 0.7, // how hard they are left behind rather than carried
    moteTurbulence: 0.75,
    moteOpacity: 0.1,
    moteGlow: 1.0,
    castMotes: 25.0,
    burstMotes: 140.0,
    colorMoteA: '#ff7f92',
    colorMoteB: '#e01e3c',
    colorMoteC: '#6d0c1f',
    colorMoteD: '#2a0510',

    /* --- the strike, in the camera --- */
    // Everything the strike does that is not one of the six layers lives here,
    // and it is deliberately only two things: a shove and a rumble.
    impactShake: 0.3,
    shakeDuration: 0.45,
    rumble: 0.028, // while it flies
    burnShake: 0.045, // while it comes apart

    /* --- the light it carries --- */
    lightColor: '#ff3a54',
    lightIntensity: 36.0,
    lightRadius: 11.0,
    lightFlicker: 0.4, // it is unstable — the light stutters
    lightFlickerSpeed: 7.0
  },

  /* ------------------------------------------------------------------ */
  /* Linear Void Slash — the six-layer obsidian lance                    */
  /* ------------------------------------------------------------------ */
  /**
   * A line cast built to a six-panel breakdown sheet: shadow core beam,
   * particle debris, shadow ribbon trails, energy sparks, distortion wave,
   * lingering shadow motes. Six layers, and the ability draws six layers.
   *
   * It flies *point first*. The composite's obsidian lance is the compact,
   * pointed shape and everything streams away from it in one direction; the
   * debris fans wider the further back it is, the ribbons taper away from it,
   * the motes are the furthest back of all. So the lance is the nose and the
   * rest is the wake. See `abilities/VoidSlashAbility.js`.
   *
   * Every layer is placed in its vertex stage as a pure function of the clock
   * and how far the head has flown, so every slider here re-flies a cast that
   * is already in the air.
   */
  voidslash: {
    /* --- the cast --- */
    range: 30.0, // maximum cast distance, metres
    minRange: 4.0, // closer than this and the cast is refused
    speed: 30.0, // how fast the lance flies, metres/second
    burstTime: 0.55, // seconds the lance takes to come apart on impact
    fadeTime: 2.4, // seconds what is left of it takes to go out. Long: the
    //                 motes have to be the last thing on screen
    cooldown: 1.2,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight path (materials/VoidSpine.js) --- */
    // Almost straight: the composite is one clean diagonal, and every curve
    // you read in it belongs to the ribbons winding about this line.
    drift: 0.2, // amplitude of the lazy wander, metres
    driftWaves: 0.18, // radians per metre
    driftRise: 0.4, // the vertical wander, x the lateral one
    launchHeight: 1.3, // where it leaves the caster's hand, metres
    flightHeight: 1.7, // its cruise height
    riseDistance: 5.0, // metres it takes to settle onto that height

    /* --- 1 · the shadow core beam: the lance --- */
    // A pointed envelope shingled with flakes of black glass, one instanced
    // draw, solid, depth-written - the one layer with a silhouette, which is
    // what makes the front of the shot read as a point. Measured off the
    // sheet: the lance is about a third of the visible streak, and its rear
    // radius about a tenth of its length.
    lanceRows: 14.0, // rows of scales from the point to the rear (capped at 24)
    lanceAround: 8.0, // scales around each row (capped at 12)
    lanceLength: 4.5, // metres, point to rear
    lanceLead: 0.0, // metres the point runs ahead of the front
    lanceRadius: 0.5, // envelope radius at the rear, metres
    lanceFlare: 1.35, // >1 concave and needle-like, 1 straight-sided
    lanceScale: 0.17, // half-width of a rear scale, metres. A scale is
    //                    `lanceLong` times longer than wide, so at 14 rows
    //                    over 4.5 m each one overlaps the next two - shingles,
    //                    not tiles
    lanceTipScale: 0.35, // how much smaller the point's scales are, x
    lanceLong: 2.4, // a scale's long axis, x its width
    lanceTilt: 0.12, // radians a scale leans off the tangent - the envelope's
    //                   own slope
    lanceJitter: 0.35, // placement jitter, so the shingles are not milled
    lanceFrayStart: 0.55, // where along the length the scales start lifting
    //                       off. Ahead of it the lance is one surface; behind
    //                       it the scales lift, stand off and come away
    lanceLift: 0.55, // radians the rearmost scales lift
    lanceFraySpread: 0.35, // metres they stand off the envelope
    lanceFlutter: 0.12, // the lifted scales shiver
    lanceFlutterSpeed: 3.0,
    lanceVein: 1.2, // the lit crack of void light down each scale
    lanceVeinWidth: 0.16, // ... as a fraction of the scale's width
    lanceVeinFlow: 3.0, // pulses per lance length ...
    lanceVeinSpeed: 2.2, // ... running to the point, per second
    lanceTipGlow: 1.4, // the point is lit from inside
    lanceTipPow: 3.5, // how tightly that light pools at the point
    lanceBurstSpeed: 9.0, // metres/second the scales are blown off at
    lanceBurstSpin: 2.5, // turns/second they tumble
    lanceBurstDrag: 2.2,
    lanceBurstHeat: 1.0, // they flash white-violet as they go
    lanceIntensity: 1.1,
    lanceRolloff: 0.5, // compresses the body under the bloom threshold: the
    //                    glass is matter and the light in it is what blooms
    lanceOpacity: 1.0,
    lanceSoftFade: 0.2,
    colorLanceGlow: '#8a46ff', // the violet the light leaks as
    colorLanceHot: '#efe4ff', // the white-violet at the point

    /* --- how the black glass is lit (the lance and the debris) --- */
    // Flat posterised facets off a camera-relative key, a violet rim on the
    // silhouette, one tight glass highlight, and a screen-space hairline along
    // every facet edge. The body colours are dark by design: the read is the
    // rim and the edges against black.
    obsidianBands: 3.0, // facet steps
    obsidianPosterize: 0.85,
    obsidianScreenKey: 0.85, // key: scene sun -> camera-relative. A flake is
    //                          thin; under the sun alone both faces land on
    //                          one band and it draws as a paper cut-out
    obsidianAmbient: 0.15,
    obsidianRim: 0.9, // the violet on the silhouette
    obsidianRimPower: 2.6,
    obsidianEdge: 0.7, // the hairline along every facet boundary
    obsidianEdgeWidth: 1.2, // ... in pixels
    obsidianSpecular: 0.5, // the glass highlight
    obsidianGloss: 40.0,
    colorObsidianDeep: '#07040f', // the facet turned away from the key
    colorObsidian: '#180d2e',
    colorObsidianLit: '#3b2566', // ... and the one facing it
    colorObsidianEdge: '#a16bff', // the rim and the hairline

    /* --- 1 · ... and the beam down its axis --- */
    // A white-violet filament on the axis with a few tight satellites winding
    // about it, pinched to nothing at the point, thinning away behind the
    // lance. Additive: this is the light the lance is built around.
    beamStrands: 4.0, // the axis plus satellites (capped at 8)
    beamSpan: 12.0, // metres of path it reaches back over
    beamLead: 0.0, // ... and how far past the front its point sits
    beamRadius: 0.16, // how far off the axis a satellite winds, metres
    beamCoil: 3.5, // turns a satellite makes over the span
    beamSpin: 1.2, // turns/second they roll
    beamWidth: 0.26, // half-width of the filament at its fattest, metres
    beamSatellite: 0.35, // a satellite's width, x that
    beamBow: 0.5, // how sharply it is pinched at the point
    beamTailThin: 0.35, // how thin it is at the tail, x the head
    beamWander: 0.05,
    beamWanderScale: 3.0,
    beamWanderSpeed: 1.5,
    beamSoft: 1.6, // falloff across the strip
    beamCore: 14.0, // the hard thread down the middle
    beamCoreWeight: 0.8,
    beamFiber: 0.45, // how hard the body breaks into travelling fibres
    beamFiberScale: 6.0,
    beamFiberSpeed: 2.5,
    beamPulse: 1.0, // charge running up it to the point
    beamPulseFreq: 2.2,
    beamPulseSpeed: 2.0,
    beamHeadGlow: 1.2, // the point runs hotter
    beamFlare: 2.0, // how far the point blows open on the strike
    beamIntensity: 2.4,
    beamOpacity: 0.9,
    beamSoftFade: 0.3,
    colorBeamCore: '#f4ecff',
    colorBeam: '#9b5cff',
    colorBeamTail: '#3a1680',

    /* --- 2 · the particle debris --- */
    // The same flakes, loosed off the rear of the lance. Each keeps most of
    // the head's speed as a slip back down the spine and flies out on its own
    // drag curve, so the field falls back and opens out - the wake, and the
    // widest part of the silhouette. Measured: a chip is about a fortieth of
    // the streak, and the cloud spreads to about two metres either side.
    debrisCount: 70.0, // chips (capped at 220)
    debrisSlivers: 0.5, // long slivers alongside them, x the above
    debrisLife: 1.5, // seconds one flake lasts, and its respawn period
    debrisLead: -3.0, // metres ahead of the front they come off: negative,
    //                   they come off the lance's frayed rear
    debrisRadius: 0.5, // how far off the axis they are born, metres
    debrisThrow: 2.6, // launch speed, metres/second
    debrisForward: 0.25, // how much of that is along the heading ...
    debrisSpread: 0.9, // ... and how much is radial
    debrisCarry: 0.7, // fraction of the head's own speed they keep. What
    //                   they do not keep is the length of the wake
    debrisDrag: 1.2,
    debrisGravity: 1.0,
    debrisSize: 0.12, // metres, before the per-flake roll
    debrisSizeVariance: 0.6, // squared, so most are small and a few are large
    debrisLong: 1.6, // how long the longest sliver is, x its width
    debrisSpin: 0.7, // tumble, turns/second
    debrisGrowIn: 0.08, // fraction of life spent snapping to size
    debrisShrinkOut: 0.6, // ... and where the shrink starts. No burst: this
    //                       is a trail, and a trail does not detonate
    debrisHot: 0.3, // fraction still carrying the void's light inside
    debrisHotGlow: 1.2,
    debrisHotPulse: 2.5, // ... breathing, per second
    debrisFlash: 0.9, // white-violet the instant a flake comes away
    debrisFlashLife: 0.14,
    debrisIntensity: 1.1,
    debrisRolloff: 0.5,
    debrisSoftFade: 0.2,
    colorDebrisGlow: '#8f4dff',
    colorDebrisFlash: '#ece0ff',

    /* --- 3 · the shadow ribbon trails --- */
    // Broad silks wound about the wake, opening wider toward the tail and
    // pinched to a point at both ends. Drawn premultiplied-over: the body
    // *darkens* what is behind it and only the hem and the pulses add light.
    // Measured: a ribbon is about a thirtieth of the streak across, and the
    // weave reaches a metre and a half off the axis at its widest.
    ribbons: 4.0, // strands (capped at 8)
    ribbonSpan: 14.0, // metres of path they reach back over
    ribbonLead: -1.5, // where they start: inside the lance, so they leave its
    //                   frayed rear rather than its point
    ribbonRadius: 1.4, // how far off the axis a ribbon bows at the tail, metres
    ribbonHeadRadius: 0.2, // ... x that, where it leaves the lance
    ribbonFlatten: 0.8, // the vertical half of the bow, x the lateral
    ribbonCoil: 1.3, // turns one ribbon makes over the span
    ribbonSpin: 0.2, // turns/second the weave rolls
    ribbonBow: 0.45, // how sharply they converge at the ends
    ribbonWander: 0.25,
    ribbonWanderScale: 1.8,
    ribbonWanderSpeed: 0.6,
    ribbonWidth: 0.36, // half-width at its broadest, metres
    ribbonWidthBow: 0.5,
    ribbonTwist: 0.85, // how far the silk rolls about its own tangent
    ribbonTwistTurns: 1.2,
    ribbonTwistSpeed: 0.2,
    ribbonTwistFace: 0.15, // the floor under the width when it is edge-on
    ribbonSoft: 1.2, // falloff across the strip
    ribbonFiber: 0.7, // how hard the body breaks into fibres
    ribbonFiberScale: 4.0,
    ribbonFiberSpeed: 1.2,
    ribbonHem: 0.12, // width of the lit line inside each border
    ribbonHemGlow: 1.6,
    ribbonHeadGlow: 0.8, // the end nearest the lance runs hotter
    ribbonPulse: 0.5, // charge running up it
    ribbonPulseFreq: 1.4,
    ribbonPulseSpeed: 1.2,
    ribbonInner: 0.8, // how much violet shows through the shadow
    ribbonOpacity: 0.75,
    ribbonSoftFade: 0.4,
    colorRibbonShadow: '#12071f', // the dark of the silk
    colorRibbon: '#3b1a7a', // ... and its violet
    colorRibbonHem: '#a56dff', // the light along its edge

    /* --- 4 · the energy sparks --- */
    // Four-rayed points of light: a trail shed off the lance, a shell thrown
    // on the strike, and one large glare pinned to the point.
    sparkCount: 90.0, // in the trail (capped at 200)
    sparkLife: 0.7,
    sparkLead: -0.6, // metres ahead of the front they are shed: off the lance
    sparkRadius: 0.5,
    sparkThrow: 2.8,
    sparkCarry: 0.8,
    sparkDrag: 1.5,
    sparkGravity: 0.6,
    sparkSize: 0.09, // half-size of a spark, metres
    sparkSizeVariance: 0.6,
    sparkRayLength: 0.7, // reach of the rays, x the spark
    sparkLongRays: 0.25, // fraction with rays three times as long - the
    //                      hairlines on the sheet
    sparkCoreTight: 9.0, // how tight the hot centre is
    sparkRays: 0.9, // brightness of the rays
    sparkRaySharp: 14.0, // how thin they are
    sparkTwinkle: 0.7,
    sparkTwinkleSpeed: 6.0,
    sparkIntensity: 2.2,
    sparkSoftFade: 0.15,
    glareSize: 0.9, // the point of light at the tip, half-size in metres
    glareRays: 1.4, // its rays' reach, x that
    glareIntensity: 2.6,
    glareFlare: 2.5, // how far it blows open on the strike
    sparkBurst: 70.0, // thrown on the strike (capped at 200)
    sparkBurstLife: 0.8,
    sparkBurstThrow: 12.0, // metres/second
    sparkBurstDrag: 2.5,
    sparkBurstSize: 0.12,
    colorSparkCore: '#ffffff',
    colorSpark: '#c9a6ff',

    /* --- 6 · the lingering shadow motes --- */
    // Soft puffs of violet smoke laid down where the lance passed and left
    // there - they keep almost none of its speed - swelling and thinning from
    // their edges in, with a few bright motes drifting up through them. The
    // layer still on screen when everything else has gone.
    moteCount: 90.0, // puffs and motes together (capped at 260)
    moteBright: 0.3, // fraction that are bright motes instead of puffs
    moteLife: 2.6, // seconds one lasts
    moteLead: -4.5, // metres ahead of the front it is laid down: behind the lance
    moteRadius: 1.2, // how far off the axis, metres
    moteCarry: 0.06, // fraction of the head's speed it keeps: it lingers
    moteRise: 0.35, // metres/second it climbs
    moteDrift: 0.6, // metres/second it spreads outward, dragged to a stop
    moteDrag: 1.5,
    moteSize: 0.55, // half-size of a puff at birth, metres
    moteGrow: 1.2, // ... and how much it swells over its life, x
    moteSizeVariance: 0.5,
    moteSpin: 0.08, // turns/second a puff turns
    moteErode: 0.5, // how much of a puff the noise eats
    moteNoiseScale: 1.8,
    moteNoiseSpeed: 0.35,
    moteInnerGlow: 0.8, // lit from inside while young
    moteOpacity: 0.6,
    moteBrightSize: 0.07, // half-size of a bright mote, metres
    moteBrightIntensity: 2.0,
    moteTwinkleSpeed: 3.0,
    moteSoftFade: 0.6,
    colorMoteShadow: '#0d0618',
    colorMote: '#33176a',
    colorMoteGlow: '#7d45e6',
    colorMoteBright: '#d9c4ff',

    /* --- the strike, in the camera --- */
    // Everything the strike does that is not one of the six layers, and it is
    // deliberately only two things: a shove and a rumble.
    impactShake: 0.3,
    shakeDuration: 0.4,
    rumble: 0.02, // while it flies
    burnShake: 0.03, // while it comes apart

    /* --- the two lights it carries --- */
    // One at the point and one standing back in the wake, so the floor is lit
    // along the length of the streak rather than under one spot of it.
    lightColor: '#8f52ff', // the point
    lightIntensity: 30.0,
    lightRadius: 10.0,
    lightFlicker: 0.3, // void light stutters
    lightFlickerSpeed: 10.0,
    wakeLightColor: '#5a2ccc', // the wake
    wakeLightIntensity: 18.0,
    wakeLightRadius: 12.0,
    wakeLightBack: 5.0, // metres behind the point it stands
    wakeBreath: 0.3,
    wakeBreathSpeed: 2.5
  },

  /* ------------------------------------------------------------------ */
  /* Glacial Shard Storm — the fourth line cast                          */
  /* ------------------------------------------------------------------ */
  /**
   * Built to a five-panel breakdown sheet: subsurface ice mesh, fluid frost
   * vapour, ordered frost lattice, glinting ice shards, refractive distortion.
   * It flies crystal first. See `abilities/GlacialShardStormAbility.js`.
   */
  glacial: {
    /* --- the cast --- */
    range: 30.0, // maximum cast distance, metres
    minRange: 4.0, // closer than this and the cast is refused
    speed: 26.0, // how fast the crystal flies, metres/second
    growTime: 0.18, // seconds the crystal takes to grow out of the hand
    burstTime: 0.6, // seconds the crystal takes to come apart on impact
    fadeTime: 2.6, // seconds what is left of it takes to go out. Long: the
    //                 vapour has to be the last thing on screen
    cooldown: 1.2,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight path (materials/GlacialSpine.js) --- */
    // Almost straight: the composite is one clean diagonal, and every curve
    // you read in it belongs to the vapour coiling about this line.
    drift: 0.15, // amplitude of the lazy wander, metres
    driftWaves: 0.16, // radians per metre
    driftRise: 0.35, // the vertical wander, x the lateral one
    launchHeight: 1.3, // where it leaves the caster's hand, metres
    flightHeight: 1.6, // its cruise height
    riseDistance: 5.0, // metres it takes to settle onto that height

    /* --- 1 · the subsurface ice mesh --- */
    // One crystal, drawn twice: its back faces (the facets seen through it)
    // and then its surface. Measured off the sheet: the crystal is about a
    // quarter of the visible streak and its girdle about a fifth of its
    // length.
    coreLength: 2.6, // metres, nose to rear
    coreRadius: 0.55, // girdle radius, metres
    coreLead: 0.4, // metres the nose runs ahead of the front
    coreRoll: 0.12, // turns/second it rolls about its own axis
    coreWobble: 0.04, // radians the nose wanders off the tangent
    coreWobbleSpeed: 2.2,
    coreOpacity: 0.55, // how much the surface veils the inside
    coreInnerLevel: 0.8, // brightness of the inner facets
    coreInnerEdge: 0.35, // ... and of their edges, the facet lines seen through
    coreGlow: 0.5, // the cold light in the thick of it
    coreNoseGlow: 1.6, // the nose is brilliant
    coreNosePow: 4.0, // how tightly that light pools at the point
    coreScatter: 0.7, // light scattered through it toward the eye
    coreScatterPower: 3.0,
    coreScatterDistort: 0.4,
    coreFractures: 0.5, // the fracture planes inside
    coreFractureScale: 3.0,
    coreFractureDepth: 0.25, // metres in they sit - they shift with the view
    coreFractureWidth: 0.06,
    coreHaze: 0.35, // trapped air, deeper still
    coreHazeScale: 2.5,
    coreFrostEtch: 0.7, // the lattice etched over the rear facets
    coreFrostStart: 0.45, // where along the axis it begins, 0 nose 1 rear
    coreFrostScale: 2.5, // flakes per crystal radius
    corePulse: 0.15, // the light inside breathes
    corePulseSpeed: 2.5,
    coreBurstSpeed: 8.0, // strike: metres/second the facets fly at
    coreBurstSpin: 2.0, // strike: turns/second they tumble
    coreBurstDrag: 2.0,
    coreBurstGravity: 6.0,
    coreBurstHeat: 1.0, // they flash white as they go
    coreIntensity: 1.0,
    coreRolloff: 0.5, // compresses the body under the bloom threshold: the
    //                    ice is matter and the light on it is what blooms
    coreSoftFade: 0.25,

    /* --- how the ice is lit (the crystal and the shards) --- */
    // A deep glacial blue seen into the thick of it, a paler body, a frost
    // white where the air is trapped and along every edge, and the cold
    // light of the storm itself inside it. Every surface reflects the stage's
    // own HDR probe and takes the same sun highlight.
    colorDeep: '#0f3d6e', // the glacial blue in the thick of it
    colorIce: '#5fb0e8', // the body
    colorFrost: '#eef8ff', // trapped air, and the edges
    colorGlow: '#a8ecff', // the cold light inside
    iceEnv: 1.0, // the probe in every facet
    iceSunSpec: 1.2, // the sun highlight
    iceGloss: 90.0, // ... and how tight it is
    iceScreenKey: 0.75, // key: scene sun -> camera-relative. A crystal lit
    //                     only by the overhead sun lands its facets on one
    //                     value and draws as a cut-out
    iceRim: 0.6, // the light on the silhouette
    iceRimPower: 3.0,
    iceDispersion: 0.6, // the rim splits cyan against violet
    iceEdge: 0.6, // the hairline along every facet boundary
    iceEdgeWidth: 1.1, // ... in pixels

    /* --- 2 · the fluid frost vapour: the streaks --- */
    // Soft sprites laid down where the crystal passed, advected by curl
    // noise, each drawn out along its own motion. A share of them sheath the
    // crystal and keep nearly all of its speed, so they stream off its rear;
    // the rest keep almost none and bloom into puffs where they were left.
    // Two samples of the same noise a little apart light one side of every
    // puff and shadow the other.
    vaporCount: 309.0, // in the trail (capped at 800)
    vaporBurst: 90.0, // the gout thrown on the strike (capped at 240)
    vaporLife: 2.38, // seconds one puff lasts, and its respawn period
    vaporLead: -1.6, // metres ahead of the front it is shed: off the crystal's rear
    vaporRadius: 0.38, // how far off the axis it is born, metres
    vaporCarry: 0.1, // fraction of the head's speed the trail keeps: it lingers
    vaporSheath: 0.39, // fraction of the slots that sheath the crystal
    vaporSheathCarry: 0.44, // ... and how much of its speed those keep
    vaporSheathBack: 1.6, // metres along the crystal they are born over
    vaporSheathRadius: 0.71, // where they are born, x the birth radius
    vaporRise: 0.0, // metres/second it climbs
    vaporSpread: 1.11, // metres/second it spreads outward, dragged to a stop
    vaporDrag: 1.25,
    vaporCurl: 0.0, // metres/second the curl field carries it
    vaporCurlScale: 1.19,
    vaporCurlSpeed: 0.3,
    vaporSize: 0.32, // half-size at birth, metres
    vaporGrow: 2.2, // ... and how much it swells over its life, x
    vaporSizeVariance: 0.2,
    vaporStretch: 0.12, // how far a puff is drawn out along its motion, per m/s
    vaporStretchMax: 3.5, // ... at most, x
    vaporSpin: 0.1, // turns/second a puff turns
    vaporErode: 0.53, // how much of a puff the noise eats
    vaporErodeOut: 0.35, // ... more as it dies
    vaporNoiseScale: 1.6,
    vaporNoiseSpeed: 0.4,
    vaporFlow: 0.6, // the noise streams back along the streak
    vaporLit: 2.05, // contrast between the lit and the shadow side
    vaporInnerGlow: 0.5, // lit by the crystal while young
    vaporSheathGlow: 0.83, // ... and the sheath, always
    vaporOpacity: 0.29,
    vaporSoftFade: 0.6,
    vaporBurstLife: 1.6,
    vaporBurstThrow: 7.0, // metres/second
    vaporBurstDrag: 2.2,
    vaporBurstSize: 0.5,
    colorVaporShade: '#5c8cc7', // the shadow side of a puff
    colorVaporLit: '#e6f4ff', // ... and the lit side
    colorVaporGlow: '#9ae6ff', // the light in it

    /* --- 2 · ... and the silks --- */
    // A few broad strips wound loosely about the wake, opening toward the
    // tail, eroded into the long smooth streamers that reach furthest back.
    silks: 8.0, // strands (capped at 8)
    silkSpan: 16.5, // metres of path they reach back over
    silkLead: -1.2, // where they start: off the crystal's rear
    silkRadius: 1.3, // how far off the axis a silk bows at the tail, metres
    silkHeadRadius: 0.3, // ... x that, where it leaves the crystal
    silkFlatten: 0.8, // the vertical half of the bow, x the lateral
    silkCoil: 0.7, // turns one silk makes over the span
    silkSpin: 0.1, // turns/second the weave rolls
    silkBow: 0.5, // how sharply they converge at the ends
    silkWander: 0.3,
    silkWanderScale: 4.3,
    silkWanderSpeed: 0.4,
    silkWidth: 0.385, // half-width at its broadest, metres
    silkWidthBow: 0.4,
    silkSoft: 1.7, // falloff across the strip
    silkErode: 0.45, // how far the noise eats the silk into streamers
    silkTailErode: 0.35, // ... more toward the tail
    silkFiberScale: 5.0,
    silkFlow: 0.5, // the streamers run back along the silk
    silkLit: 2.0,
    silkHeadGlow: 0.6, // the end nearest the crystal runs brighter
    silkOpacity: 0.55,
    silkSoftFade: 1.34,

    /* --- 3 · the ordered frost lattice --- */
    // Snowflakes: a six-fold dendrite drawn as a signed distance on sprites
    // tumbling in the wake, no two alike. Two populations: many small, a few
    // large - measured, the largest on the sheet is about a fifth of the
    // crystal's length.
    latticeCount: 90.0, // in the trail (capped at 200)
    latticeBurst: 50.0, // thrown on the strike (capped at 140)
    latticeLife: 2.4, // seconds one lasts
    latticeLead: -1.5, // metres ahead of the front it is laid down: behind the crystal
    latticeRadius: 0.8, // how far off the axis, metres
    latticeCarry: 0.08, // fraction of the head's speed it keeps: it lingers
    latticeFall: 0.2, // metres/second it settles
    latticeSpread: 0.5, // metres/second it drifts outward, dragged to a stop
    latticeDrag: 1.2,
    latticeSize: 0.16, // radius of a small flake, metres
    latticeSizeVariance: 0.4,
    latticeBig: 0.18, // fraction that are large
    latticeBigScale: 3.0, // ... and how much larger, x
    latticeSpin: 0.15, // turns/second in its own plane
    latticeTumble: 0.2, // turns/second it flips through the view
    latticeFill: 0.35, // the pale body of the flake
    latticeEdgeGlow: 1.2, // ... and the light along its lines
    latticeSoft: 0.03, // how soft the fill's edge is, flake radii
    latticeTwinkle: 0.5,
    latticeTwinkleSpeed: 3.0,
    latticeSoftFade: 0.3,
    latticeBurstLife: 1.6,
    latticeBurstThrow: 6.0,
    latticeBurstDrag: 2.0,
    colorLattice: '#b3dbff', // the body of a flake
    colorLatticeEdge: '#dcf4ff', // its lines

    /* --- 4 · the glinting ice shards --- */
    // Bipyramid splinters struck off the crystal and left tumbling in the
    // wake, and a four-rayed glint pinned to each that flashes as its facets
    // turn through the key. Measured: a shard is about a twentieth of the
    // crystal's length.
    shardCount: 110.0, // gems (capped at 200)
    shardSplinters: 0.6, // long splinters alongside them, x the above
    shardBurst: 120.0, // thrown on the strike, both kinds (capped at 320)
    shardLife: 1.8, // seconds one lasts, and its respawn period
    shardLead: -1.4, // metres ahead of the front they come off: off the crystal's rear
    shardRadius: 0.5, // how far off the axis they are born, metres
    shardThrow: 2.0, // launch speed, metres/second
    shardForward: 0.2, // how much of that is along the heading ...
    shardSpread: 0.9, // ... and how much is radial
    shardCarry: 0.35, // fraction of the head's own speed they keep
    shardDrag: 1.0,
    shardGravity: 1.5,
    shardSize: 0.11, // metres, before the per-shard roll
    shardSizeVariance: 0.6, // squared, so most are small and a few are large
    shardLong: 2.2, // how slender the slenderest is, x
    shardSpin: 0.8, // tumble, turns/second
    shardGrowIn: 0.06, // fraction of life spent snapping to size
    shardShrinkOut: 0.65, // ... and where the shrink starts
    shardBands: 3.0, // facet steps
    shardPosterize: 0.7,
    shardTip: 0.6, // light through the two points
    shardTipStart: 0.5,
    shardBack: 0.5, // light through the shadow side
    shardBackPower: 2.0,
    shardTwinkle: 0.7, // the facet glint blinks
    shardTwinkleSpeed: 1.5,
    shardFlash: 0.8, // white the instant it is struck off
    shardFlashLife: 0.12,
    shardIntensity: 1.0,
    shardRolloff: 0.5,
    shardSoftFade: 0.2,
    shardBurstLife: 1.4,
    shardBurstThrow: 11.0, // metres/second
    shardBurstDrag: 2.0,
    shardBurstSize: 0.14,
    glintSize: 4.0, // the glint's reach, x the shard
    glintChance: 0.3, // how often a facet catches the key
    glintSpeed: 2.0,
    glintCoreTight: 12.0,
    glintRays: 1.0,
    glintRaySharp: 16.0,
    glintIntensity: 2.2,
    glintSoftFade: 0.15,
    colorGlintCore: '#ffffff',
    colorGlint: '#bfeaff',

    /* --- 5 · the refractive distortion --- */
    // A ball of glass riding the crystal that pulls the frame in toward it,
    // a bow wave standing ahead of the nose, rings shed behind, and one big
    // ring on the strike. Nothing is drawn: this writes the distortion layer.
    warpSize: 4.5, // the proxy's width, metres
    warpLens: 0.7, // the glass ball
    warpLensSize: 0.45, // its radius, x the proxy
    warpLensPower: 1.4,
    warpBow: 0.5, // the bow wave
    warpBowRadius: 0.55, // ... x the proxy
    warpBowWidth: 0.08,
    warpRing: 0.35, // the rings it sheds
    warpRingRate: 1.4, // per second
    warpRingWidth: 0.1,
    warpBurst: 1.0, // the strike's ring
    warpBurstLife: 0.5,
    warpBurstSpeed: 14.0, // metres/second it runs out
    warpBurstSize: 1.2, // how far the proxy grows for it, x
    warpBurstWidth: 0.2,
    warpStrength: 1.0,

    /* --- the strike, in the camera --- */
    impactShake: 0.28,
    shakeDuration: 0.4,
    rumble: 0.015, // while it flies
    burnShake: 0.025, // while it comes apart

    /* --- the two lights it carries --- */
    // One in the crystal and one standing back in the wake, so the floor is
    // lit along the length of the streak rather than under one spot of it.
    lightColor: '#9fdcff', // the crystal
    lightIntensity: 26.0,
    lightRadius: 11.0,
    lightShimmer: 0.2, // ice glints; it does not gutter
    lightShimmerSpeed: 6.0,
    wakeLightColor: '#5aa8e6', // the wake
    wakeLightIntensity: 14.0,
    wakeLightRadius: 12.0,
    wakeLightBack: 5.0, // metres behind the crystal it stands
    wakeBreath: 0.25,
    wakeBreathSpeed: 2.0
  },

  /* ------------------------------------------------------------------ */
  /* Sentinel Drone — the summon                                         */
  /* ------------------------------------------------------------------ */
  /**
   * The one ability that is not a cast: a **toggle**. Press it and an armed
   * hexacopter prints itself in over the caster's head and stays on station
   * until it is recalled; while it is up, every other slot is locked.
   *
   * It is flown, not aimed. The on-screen stick (or WASD, or the open hand
   * pushed off the middle of the frame) is a velocity; letting go holds
   * position. Closing the fist (or holding fire) puts it to work: it picks the
   * nearest body inside its ground ring, turns onto it, locks, and empties a
   * burst into it — and keeps doing that for as long as the fist stays shut.
   *
   * `range` is the ring; `speed` is here only because the shared contract
   * expects it, the drone never advances a front. See `abilities/DroneAbility.js`.
   */
  drone: {
    /* --- the cast --- */
    range: 7.0, // radius of the kill ring on the floor, metres
    minRange: 0,
    speed: 1, // unused — the summon has no front
    cooldown: 2.5, // starts on recall
    castAnim: 'cast2',

    /* --- the airframe --- */
    size: 2.1, // rotor tip to rotor tip, metres
    altitude: 3.6, // hover height, metres above the floor
    bladeSpeed: 18.0, // revolutions per second at full spin
    bladeSpinUp: 1.2, // seconds from still to full spin
    bladeBlur: 0.75, // how solid the blur disc reads at full spin
    counterRotate: true, // alternate rotors turn the other way

    /* --- the hover --- */
    hoverAmplitude: 0.11, // metres of bob
    hoverFrequency: 0.55, // bobs per second
    sway: 0.03, // radians of idle wobble
    swaySpeed: 0.8,
    bank: 0.3, // radians the body leans at full speed
    bankRate: 0.03, // fraction of the lean gap left after 1s (lower = snappier)
    aimPitch: 0.35, // radians the nose dips onto a target

    /* --- flight --- */
    maxSpeed: 7.0, // metres/second at full stick
    acceleration: 0.04, // fraction of the velocity gap left after 1s
    leash: 12.0, // furthest it may fly from the caster, metres
    turnRate: 0.03, // heading follows the velocity (fraction left after 1s)
    stickDeadZone: 0.08, // of the on-screen stick's throw
    stickExpo: 1.5, // >1 softens the middle of the stick
    handDeadZone: 0.22, // NDC radius round the centre where the hand holds
    handFullRange: 0.75, // NDC radius at which the hand is full stick
    watch: true, // the caster turns to follow it

    /* --- deploy & recall --- */
    deployTime: 1.5, // seconds to rise and print in
    recallTime: 1.0, // seconds to fly home and print out
    launchHeight: 1.9, // metres above the floor it appears at
    downwash: 26, // dust particles/second thrown off the floor under it
    downwashSize: 0.8,
    deployShake: 0.12,

    /* --- the look of the metal --- */
    revealColor: '#7fe0ff',
    revealWidth: 0.1, // metres the hot edge spans
    revealGlow: 7.0,
    rimColor: '#6fd2ff',
    rimStrength: 0.5,
    rimPower: 2.8,
    navLights: 1.2, // nav light brightness
    navSize: 0.11, // metres
    strobeRate: 1.4, // strobe flashes per second
    navColorFront: '#ff3b2f',
    navColorBack: '#3bff7a',

    /* --- the range ring --- */
    ringWidth: 0.22,
    ringGlow: 1.6,
    ringSoftness: 0.06,
    ringFill: 0.1,
    ringTicks: 36,
    ringTickLength: 0.35,
    ringTickWidth: 0.22,
    ringTickSpin: 0.04,
    ringSweep: 0.55,
    ringSweepSpeed: 0.3,
    ringPulse: 0.9,
    ringOpacity: 1.0,
    colorRing: '#5fd0ff',
    colorRingHot: '#ff3b2f',

    /* --- the searchlight --- */
    beamAngle: 9.0, // half-angle, degrees
    beamIntensity: 0.32,
    beamEdge: 1.6, // how fast the cone fades to its silhouette
    beamFalloff: 0.55, // how fast it fades from the drone to the floor
    beamNoise: 0.35,
    beamNoiseScale: 2.0,
    beamSwing: 0.002, // fraction of the aim gap left after 1s
    spotIntensity: 0.55, // the pool on the floor
    colorBeam: '#bfe9ff',
    colorBeamHot: '#ff5a3c',

    /* --- targeting --- */
    aimTurnRate: 0.0015, // fraction of the heading gap left after 1s
    lockTime: 0.4, // seconds the reticle takes to close
    lockCone: 0.18, // radians of heading error it will fire within
    aimHeight: 0.62, // fraction of a body's height the shot is aimed at
    retarget: 0.3, // seconds between one burst and the next lock
    reticleSize: 1.4, // metres
    reticleGlow: 1.6,
    colorReticle: '#ffc46a',
    colorLocked: '#ff3b2f',

    /* --- the burst --- */
    rounds: 6,
    burstTime: 0.32, // seconds the rounds are spread over
    tracerSpeed: 60.0, // metres/second
    tracerSize: 0.09,
    tracerLength: 1.4, // metres
    spread: 0.035, // radians
    casings: true,
    fireShake: 0.1,
    fireFlash: 0.05,
    muzzleSize: 0.55,
    colorTracer: '#fff1c4',
    colorTracerTail: '#ff8a3c',
    colorFlash: '#ffd9a8',
    impactSparks: 22,
    colorSpark: '#ffd27a',
    scorch: true,
    hit: {
      impulse: 7.5, // metres/second the body leaves at, along the shot
      lift: 3.2,
      spin: 1.3
    },

    /* --- light --- */
    lightIntensity: 9.0, // the body light
    lightRadius: 7.0,
    lightColor: '#9fdcff',
    muzzleLight: 40.0, // the punch each round adds
    spotLight: 6.0, // the floor light under the beam
    spotLightRadius: 6.0
  },

  /* ------------------------------------------------------------------ */
  /* Monowheel Bot — the second summon                                   */
  /* ------------------------------------------------------------------ */
  /**
   * The drone's principle on the ground: a **toggle** that prints an armoured
   * one-wheeled sentry in on the floor in front of the caster and keeps it
   * there until it is recalled, locking every other slot while it is out.
   *
   * It is driven, not flown. The same stick, keys and open hand hand it the
   * same screen-relative demand, but a wheel cannot strafe: free, it turns to
   * face the stick and drives along its heading; locked onto a target it faces
   * the target and the stick is a tank's throttle. Closing the fist (or
   * holding fire) puts it to work exactly as it does the drone — nearest body
   * in the ring, turn on, lock, burst — with the burst alternating the two
   * guns on its nose.
   *
   * `range` is the ring; `speed` is here only because the shared contract
   * expects it. See `abilities/MonowheelAbility.js`.
   */
  monowheel: {
    /* --- the cast --- */
    range: 7.0, // radius of the kill ring on the floor, metres
    minRange: 0,
    speed: 1, // unused — the summon has no front
    cooldown: 2.5, // starts on recall
    castAnim: 'cast2',

    /* --- the chassis --- */
    size: 1.7, // floor to the top of the hull, metres
    deployDistance: 2.4, // metres in front of the caster it prints in at

    /* --- the balance --- */
    lean: 0.2, // radians the hull leans forward at full speed
    leanRate: 0.03, // fraction of the lean gap left after 1s (lower = snappier)
    bankIntoTurns: 0.16, // radians of lean per rad/s of turn, at full speed
    recoil: 0.05, // radians the hull rocks back per round
    wobble: 0.012, // radians of idle balancing wobble
    wobbleSpeed: 1.8,

    /* --- the drive --- */
    maxSpeed: 6.5, // metres/second at full stick
    acceleration: 0.03, // fraction of the speed gap left after 1s
    leash: 12.0, // furthest it may drive from the caster, metres
    turnRate: 0.004, // heading follows the stick (fraction left after 1s)
    stickDeadZone: 0.08, // of the on-screen stick's throw
    stickExpo: 1.5, // >1 softens the middle of the stick
    handDeadZone: 0.22, // NDC radius round the centre where the hand holds
    handFullRange: 0.75, // NDC radius at which the hand is full stick
    watch: true, // the caster turns to follow it
    treadDust: 44, // dust particles/second off the tread at full speed
    treadDustSize: 0.55,

    /* --- deploy & recall --- */
    deployTime: 1.4, // seconds to print in
    recallTime: 0.9, // seconds to brake and print out
    deployShake: 0.1,

    /* --- the look of the metal --- */
    revealColor: '#ffc46a',
    revealWidth: 0.1, // metres the hot edge spans
    revealGlow: 7.0,
    rimColor: '#d9c08a',
    rimStrength: 0.45,
    rimPower: 2.8,

    /* --- the range ring --- */
    ringWidth: 0.22,
    ringGlow: 1.6,
    ringSoftness: 0.06,
    ringFill: 0.1,
    ringTicks: 36,
    ringTickLength: 0.35,
    ringTickWidth: 0.22,
    ringTickSpin: 0.04,
    ringSweep: 0.55,
    ringSweepSpeed: 0.3,
    ringPulse: 0.9,
    ringOpacity: 1.0,
    colorRing: '#e0c46a',
    colorRingHot: '#ff3b2f',

    /* --- the headlamp --- */
    beamAngle: 7.0, // half-angle, degrees
    beamIntensity: 0.26,
    beamEdge: 1.6, // how fast the cone fades to its silhouette
    beamFalloff: 0.55, // how fast it fades from the nose to the floor
    beamNoise: 0.35,
    beamNoiseScale: 2.0,
    beamSwing: 0.002, // fraction of the aim gap left after 1s
    headlightReach: 5.0, // metres ahead it lights when it has nothing to shoot
    spotIntensity: 0.5, // the pool on the floor
    colorBeam: '#ffe9bf',
    colorBeamHot: '#ff5a3c',

    /* --- targeting --- */
    aimTurnRate: 0.0015, // fraction of the heading gap left after 1s
    lockTime: 0.4, // seconds the reticle takes to close
    lockCone: 0.18, // radians of heading error it will fire within
    aimHeight: 0.62, // fraction of a body's height the shot is aimed at
    retarget: 0.3, // seconds between one burst and the next lock
    reticleSize: 1.4, // metres
    reticleGlow: 1.6,
    colorReticle: '#ffc46a',
    colorLocked: '#ff3b2f',

    /* --- the burst --- */
    rounds: 8, // alternates the two guns
    burstTime: 0.4, // seconds the rounds are spread over
    tracerSpeed: 60.0, // metres/second
    tracerSize: 0.09,
    tracerLength: 1.4, // metres
    spread: 0.03, // radians
    casings: true,
    fireShake: 0.1,
    fireFlash: 0.05,
    muzzleSize: 0.6, // the hot core on the muzzle, metres
    muzzleLength: 0.9, // metres the flame reaches out of the barrel
    muzzleStreaks: 6, // streaks in each flame
    colorTracer: '#fff1c4',
    colorTracerTail: '#ff8a3c',
    colorFlash: '#ffd9a8',
    impactSparks: 22,
    colorSpark: '#ffd27a',
    scorch: true,
    hit: {
      impulse: 7.5, // metres/second the body leaves at, along the shot
      lift: 3.2,
      spin: 1.3
    },

    /* --- light --- */
    lightIntensity: 7.0, // the body light, on the nose
    lightRadius: 6.0,
    lightColor: '#ffd9a8',
    muzzleLight: 40.0, // the punch each round adds
    spotLight: 5.0, // the floor light under the headlamp
    spotLightRadius: 5.0
  },

  /* ------------------------------------------------------------------ */
  /* Serpent Tide Field — the phoenix                                    */
  /* ------------------------------------------------------------------ */
  /**
   * A far cast that summons a phoenix onto the point. Built to a seven-panel
   * breakdown: the bird (a fresnel of fire), serpentine fire trails, wispy
   * flame waves, the scorched crust, a heat field, floating embers and the
   * sub-surface glow. Every temperature below is in kelvin, because the fire
   * is shaded as a radiator: the colours are what a grey body emits between
   * `tempEdge` and `tempCore`, and `palette` blends the four authored stops
   * over that.
   */
  phoenix: {
    /* --- the cast --- */
    range: 22.0, // max cast distance, metres
    minRange: 0,
    speed: 30.0, // the seed's flight, m/s
    cooldown: 5.0,
    castAnim: 'cast3',
    zoneRadius: 5.0, // the field's footprint on the floor, metres
    lifetime: 11.0, // seconds the phoenix hunts
    fadeTime: 1.7, // seconds it takes to burn out
    seedHeight: 1.4, // metres the seed leaves the hand at
    seedArc: 2.2, // metres of lob over the flight
    seedTrail: 140, // embers/second behind the seed
    seedSize: 0.4, // metres, the seed comet's head radius

    /* --- the eruption --- */
    eruptionEmbers: 160, // embers thrown up out of the pyre
    eruptionLight: 90.0,
    eruptionShake: 0.45,
    eruptionFlash: 0.14,
    spreadTime: 0.55, // seconds the scorch takes to reach its edge

    /* --- 1 · the phoenix --- */
    wingspan: 4.6, // metres, tip to tip
    altitude: 2.7, // metres the body hovers at
    riseTime: 1.3, // seconds to climb out of the pyre
    riseFrom: -0.7, // metres under the floor it starts
    hoverAmplitude: 0.16, // metres of bob
    hoverFrequency: 0.45, // bobs per second
    sway: 0.035, // radians of idle wobble
    swaySpeed: 0.9,
    flapSpeed: 1.0, // flap cycle rate
    turnRate: 0.004, // fraction of the heading gap left after 1s
    bank: 0.35, // radians it banks into a turn
    bankRate: 0.03, // fraction of the lean gap left after 1s
    aimPitch: 0.3, // radians the head dips onto a target
    divePitch: 0.75, // radians of nose-down in the dive
    burnClimb: 1.4, // m/s it lifts as it burns out
    flareStrength: 0.7, // how much brighter it runs as it spits and kicks

    /* --- the fire it is made of --- */
    tempCore: 3600, // K, the white-hot rim
    tempEdge: 1450, // K, the deep red body
    emissionCurve: 2.4, // radiated power goes as (T/Tcore)^this
    palette: 0.3, // 0 pure radiator → 1 the four colours below
    colorCore: '#fff3d0',
    colorMid: '#ff9a22',
    colorEdge: '#ff3a08',
    colorEmber: '#3a0a02',
    bodyHeat: 0.55, // how hot the plumage runs, 0 ember → 1 white
    rimPower: 2.2,
    rimStrength: 1.5, // the fresnel of fire
    flameScale: 1.5, // flame noise over the body, 1/m
    flameRise: 1.9, // m/s the flames climb it
    flameStrength: 0.6, // how much the flames move the heat
    lick: 1.4, // how far the rim drags the flames upward
    paintShow: 0.3, // how much of the painted plumage shows through
    emission: 2.4,
    featherBurn: 0.35, // how much the feather edges flicker away
    auraSize: 0.05, // metres the fire stands off the body
    auraStrength: 1.3,
    auraThreshold: 0.48, // higher = sparser tongues
    revealWidth: 0.2, // metres of molten edge as it rises
    revealGlow: 7.0,

    /* --- the hunt --- */
    fireRange: 9.0, // metres from the centre it engages
    retarget: 0.35, // seconds between one body and the next
    aimTime: 0.28, // seconds the beak takes to come onto a body
    lockCone: 0.2, // radians of heading error it will spit within
    aimHeight: 0.62, // fraction of a body's height the shot is aimed at
    spread: 0.03, // radians

    /* --- the volley --- */
    volleyRounds: 3,
    volleyInterval: 0.15, // seconds between them
    fireballSpeed: 19.0, // metres/second
    fireballSize: 0.36, // metres, the head's radius
    fireballTail: 3.0, // metres of burning wake behind it
    fireballArc: 0.35, // lift it leaves with, as a fraction of its speed
    fireballHoming: 0.02, // fraction of the aim gap left after 1s
    /* the volume each round is marched as: every length in head radii */
    fireballIntensity: 3.5, // emission
    fireballWakeWidth: 0.5, // the wake pinches to this just behind the head
    fireballWakeSpread: 0.6, // ...and spent gas swells back out by this
    fireballPlume: 1.5, // how far the wake's gas climbs, as a stretch
    fireballBulge: 0.28, // lobes in the silhouette
    fireballShred: 1.3, // how hard the fringe is torn
    fireballNoiseScale: 3.0, // turbulence, per head radius
    fireballFlow: 1.0, // gas streams back at this fraction of the round's speed
    fireballBuoyancy: 2.2, // how fast the flame field climbs
    fireballVortex: 0.8, // roll-up of the wake into billows
    fireballDetach: 0.8, // how far down the wake it tears into puffs
    fireballSoftness: 0.6, // hard sheets of gas → soft cloud
    fireballTailHeat: 0.45, // how hot the end of the wake still runs
    fireballDensity: 1.1,
    fireballSoot: 1.3, // how hard the cool gas blocks what is behind it
    fireballSteps: 26, // march samples per ray
    fireballHalo: 0.8, // the light round the head
    trailRate: 40, // embers, sparks and smoke shed per second by each round
    spitFlash: 0.7, // metres
    spitLight: 30.0,
    spitShake: 0.05,
    impactRadius: 1.0, // metres the burst reaches
    impactSparks: 26,
    impactScorch: true,
    hitShake: 0.14,
    hitFlash: 0.04,
    fireballLight: 38.0,
    hit: {
      impulse: 9.5, // metres/second the body leaves at, along the shot
      lift: 4.2,
      spin: 1.6
    },

    /* --- the kick --- */
    kickRange: 3.4, // metres from the centre within which it uses the talons
    kickTime: 0.95, // seconds for the dive and the climb back
    kickHeight: 0.15, // metres above the chest the talons stop
    kickBurst: 1.6, // metres the gout of fire reaches
    kickShake: 0.3,
    kickHit: {
      impulse: 13.0,
      lift: 6.5,
      spin: 2.6
    },

    /* --- 2 · serpentine fire trails --- */
    serpents: 3,
    serpentGrowTime: 1.4, // seconds they grow out of their heads
    serpentRadius: 0.72, // of the zone radius
    serpentWeave: 0.32, // how far the S-bends swing, of that radius
    serpentWaves: 3, // bends per lap
    serpentHeight: 0.45, // metres they rise and dip
    serpentLift: 0.3, // metres the spine sits off the floor
    serpentLength: 0.42, // fraction of a lap each trail covers
    serpentSpeed: 0.26, // laps per second
    serpentWidth: 0.5, // metres
    serpentFloorWidth: 1.3, // metres, the pool of light under each
    serpentNoiseScale: 1.3,
    serpentFlow: 1.2,
    serpentRise: 0.9,
    serpentShred: 1.3,
    serpentHeadGlow: 1.4,
    serpentIntensity: 1.5,
    serpentFloorGlow: 0.5,
    serpentEmbers: 18, // embers/second off each head

    /* --- 3 · wispy flame waves --- */
    skirtRadius: 0.52, // of the zone radius
    skirtHeight: 1.9, // metres
    skirtRiseTime: 0.7, // seconds it stands up in
    skirtFlare: 0.3, // how far the top leans out
    skirtBreathe: 0.07,
    skirtNoiseScale: 1.8,
    skirtRise: 1.5, // m/s the tongues climb
    skirtShred: 1.4,
    skirtWisp: 0.7, // ridged wisps at the top
    skirtWaveSpeed: 0.8, // waves per second rolling round it
    skirtWaveDepth: 0.45,
    skirtHeat: 1.0,
    skirtIntensity: 1.3,
    skirtOpacity: 0.7,
    smokeRate: 10, // smoke puffs/second off the top of it
    smokeOpacity: 0.3,

    /* --- 4 · the scorch --- */
    scorchRadius: 1.0, // of the zone radius
    scorchDark: 0.92,
    colorScorch: '#0a0503',
    crackScale: 1.3, // plates per metre
    crackWidth: 0.05,
    crackGlow: 2.0,
    crackReach: 0.8, // of the scorch radius the cracks run out to
    groundEmbers: 0.9,

    /* --- 5 · floating fire embers --- */
    emberRate: 110, // embers/second across the field
    bodyEmbers: 45, // embers/second off the bird
    emberSize: 0.075,
    emberLife: 2.8,
    emberRise: 1.4, // m/s^2 of lift
    emberGlow: 2.6,

    /* --- 6 · sub-surface heat glow --- */
    glowRadius: 0.85, // of the zone radius
    glowIntensity: 0.5,
    glowPulse: 0.4, // how hard it breathes
    glowPulseSpeed: 1.5,
    colorGlow: '#ff5a10',

    /* --- light --- */
    lightIntensity: 28.0, // the bird
    lightRadius: 14.0,
    lightColor: '#ff8a2a',
    lightGutter: 0.25,
    lightGutterSpeed: 11.0,
    fieldLight: 22.0, // under the pyre
    fieldLightRadius: 12.0
  },

  /* ================================================================== */
  /* SHARK — Abyssal Maw                                                 */
  /* ================================================================== */
  /**
   * A **targeted** far cast: the circle snaps onto the body under the cursor
   * (`snapRadius`), and that body is taken. Two portals of deep water tear
   * open in the floor either side of it, a spike of rock bursts up under it
   * and kicks it into the air, and a great white breaches out of one portal,
   * takes the body in its jaws at the top of the kick and carries it down
   * into the other.
   *
   * Everything about the leap is solved from these numbers every frame — the
   * arc, the portals' spacing, when the shark has to leave the water for the
   * jaw to arrive with the body — so dragging any of them re-plans a cast
   * that is already in the air. Times in **The timing** are seconds after the
   * cast lands; everything else is metres unless it says otherwise.
   */
  shark: {
    /* --- the cast --- */
    range: 20.0, // max cast distance, metres
    minRange: 0,
    speed: 70.0, // the cast's run to the target, m/s
    cooldown: 6.0,
    castAnim: 'cast2',
    zoneRadius: 1.1, // the circle drawn round the target, metres
    snapRadius: 2.4, // how far from the cursor a body is snapped onto, metres
    showTime: 3.6, // seconds from landing until the portals have closed
    fadeTime: 2.4, // seconds the stains take to dry off

    /* --- the timing --- */
    rockDelay: 0.34, // the rock bursts up
    rockRise: 0.09, // seconds it takes to stand
    hangTime: 0.44, // seconds from the kick to the bite — the body's flight
    emergeTime: 0.22, // seconds the shark takes to climb its well to the surface
    flightTime: 0.9, // seconds in the air, portal to portal
    diveTime: 0.55, // seconds from the far surface to the bottom of the dive

    /* --- 1 · the rock --- */
    rockHeight: 1.75, // metres
    rockWidth: 1.0, // girth, × the authored spike
    rockHold: 1.1, // seconds it stands before it crumbles
    rockSink: 0.75, // seconds it takes to crumble back into the floor
    rockChips: 26, // chunks thrown off it
    rockGrit: 70, // grit particles thrown off it
    rockDust: 16, // puffs of dust
    rockShake: 0.32,
    rockDamp: 0.35, // how wet the root of it is
    dustCoat: 0.6, // how much of the cloud settles on it
    kick: {
      impulse: 0.8, // m/s along the cast
      lift: 10.0, // m/s up
      spin: 1.9 // the tumble
    },
    hangGrip: 0.07, // how hard the body is steered onto the jaw's path, 0..1 per pass
    texScale: 2.6, // the stone scan, metres per tile
    texAmount: 1.0,
    normalScale: 1.3,
    stoneRough: 1.0,
    stoneRoughFloor: 0.34,
    stoneAO: 1.0,
    dustCoatSharp: 1.5,
    dustCoatScale: 1.2,
    stoneDesat: 0.3,
    stoneGrade: 0.6,
    colorStoneGrade: '#4f5350',
    colorStone: '#5b5e59',
    colorStoneDeep: '#1d201e',
    colorDustCoat: '#8a857c',
    colorDust: '#4d473f',

    /* --- 2 · the portals --- */
    portalRadius: 1.55, // metres, fully open
    portalSpan: 4.6, // metres from the top of the arc to each portal
    openTime: 0.36, // seconds they take to tear open
    closeDelay: 0.5, // seconds after the shark has gone through before one closes
    closeTime: 0.9, // seconds to spiral shut
    wellDepth: 10.0, // metres of water under each
    depthFog: 0.42, // how fast the water swallows the light, per metre
    wellRays: 1.0, // shafts of daylight down the well
    abyssGlow: 0.3, // light coming up out of the deep
    swirl: 1.1, // radians/second the water turns while open
    closeSwirl: 7.0, // ...and how hard it spins as it closes
    ripple: 0.04, // metres of wave
    rippleScale: 1.1,
    rippleSpeed: 0.9,
    clarity: 0.6, // how opaque the water is head-on — the shark under it is a shadow
    sheen: 1.2, // the sun's highlight
    gloss: 0.75,
    reflection: 0.5, // the sky in it at a graze
    caustic: 0.45,
    foam: 0.55, // against the wall
    foamWidth: 0.16,
    churnDecay: 1.8, // how fast the white water settles, 1/s
    lip: 0.12, // metres of torn stone edge
    wetReach: 1.75, // the stain, × the portal radius
    wetDark: 0.75,
    cracks: 1.0,
    crackReach: 2.0, // × the portal radius
    crackGlow: 0.9,
    rune: 0.75, // the circle the summons is drawn with
    runeRadius: 1.32, // × the portal radius
    runeSpin: 0.35, // radians/second
    warpScale: 1.4, // refraction
    warpSpeed: 0.8,
    warpStrength: 0.9,
    portalLight: 14.0,
    portalLightRadius: 7.0,

    /* --- 3 · the shark --- */
    length: 4.6, // metres, snout to tail
    biteHeight: 2.6, // metres off the floor the body is taken at
    emergeDepth: 3.4, // metres under the surface it starts its run from
    diveDepth: 6.5, // metres under the far surface it dives to
    diveDrift: 0.35, // metres it carries on past the far portal's centre under water
    socketDepth: 0.08, // how far back into the mouth the body is held, 0 lips → 1 throat
    deathRoll: 0.0, // full turns about its own axis while it carries the body (any turn shows its belly)
    rollTime: 0.6, // seconds that roll takes
    thrashRoll: 28, // degrees it rocks side to side after the bite — stays dorsal-up
    thrashRate: 2.2, // rocks per second
    thrashTime: 0.9, // seconds the thrash takes to die away
    biteSnap: 0.07, // seconds the jaw takes to take full hold
    grabJoint: 'Spine', // which joint of the body the jaw holds
    wetness: 1.0, // how glossy the skin is out of the water
    sharkRim: 0.5,
    sharkRimPower: 3.0,
    colorRim: '#7fe9ff',
    dissolveDepth: 2.4, // metres under the surface over which the body is taken by the deep

    /* --- 4 · the splash --- */
    crownHeight: 2.5, // metres
    crownRadius: 0.8, // × the portal radius
    crownSpread: 0.6, // how far it flares out over its life
    crownTime: 1.05, // seconds
    crownOpacity: 0.6,
    entryScale: 1.35, // how much bigger going in is than coming out
    sprayCount: 220, // droplets per breach
    spraySpeed: 9.5, // m/s
    mistCount: 22, // puffs per breach
    dripRate: 80, // droplets/second shed off the shark and the body in the air
    splashShake: 0.3,
    splashLight: 60.0,
    splashFlash: 0.05,

    /* --- 5 · the bite --- */
    biteSpray: 90,
    biteShake: 0.4,
    biteLight: 45.0,
    biteFlash: 0.06,

    /* --- the palette --- */
    colorShallow: '#0b4553',
    colorDeep: '#010a10',
    colorFoam: '#e9fbff',
    colorGlow: '#3fd8ff',
    colorRune: '#7ff3ff',
    colorWet: '#06090b',
    colorMist: '#cdefff',
    colorReticle: '#5fe3ff', // the lock on the target while aiming
    colorLocked: '#c8f8ff',

    /* --- light --- */
    lightIntensity: 16.0,
    lightRadius: 9.0,
    lightColor: '#5fe3ff'
  },

  /* ================================================================== */
  /* CHAINS — Chains of Penance                                          */
  /* ================================================================== */
  /**
   * A **targeted** far cast: the circle locks onto one body, and that body is
   * taken apart. Small portals tear open in the air all round it — gold
   * filigree, an iris of black lacquer, a tunnel of rune light behind it — and
   * a chain is thrown out of each one, barbed head first. Each winds round a
   * limb. They haul the body off its feet and hold it spread in the air; they
   * haul again, in ratchets, and the seams where the limbs join it light up and
   * stretch; then the limbs come away one after another, each dragged back
   * through its own portal. The trunk goes last, down through the one in the
   * floor. Every portal shuts behind what it took.
   *
   * Times in **The timing** are seconds after the cast lands. Everything is
   * re-solved from this block every frame, so the editor reshapes a rite that
   * is already under way.
   */
  chains: {
    /* --- the cast --- */
    range: 18.0, // max cast distance, metres
    minRange: 0,
    speed: 60.0, // the cast's run to the target, m/s
    cooldown: 7.0,
    castAnim: 'cast3',
    zoneRadius: 1.1, // the circle drawn round the target, metres
    snapRadius: 2.4, // how far from the cursor a body is snapped onto, metres
    showTime: 4.2, // seconds from landing the rite takes at least
    fadeTime: 2.4, // seconds the seal and the blood take to fade

    /* --- the timing --- */
    portalStagger: 0.045, // seconds between one portal opening and the next
    portalOpen: 0.32, // seconds a portal takes to inscribe itself and open
    fireDelay: 0.3, // the first chain is thrown
    fireStagger: 0.06, // seconds between chains
    flightTime: 0.17, // seconds a chain takes to reach its limb
    wrapTime: 0.16, // seconds it takes to wind round it
    liftTime: 0.5, // seconds to haul the body up to the hang
    strainStart: 1.1, // the hauling begins
    ratchets: 3, // how many hauls before the limbs give
    ratchetPeriod: 0.36, // seconds between hauls
    ratchetSnap: 0.07, // seconds one haul takes
    tearStagger: 0.11, // seconds between one limb coming away and the next
    recoilTime: 0.34, // seconds a torn limb takes to be dragged through its portal
    dragDelay: 0.3, // seconds after the last limb before the trunk is taken
    dragTime: 0.75, // seconds the trunk takes to go down through the floor
    closeDelay: 0.12, // seconds after its chain is home before a portal shuts
    closeTime: 0.32, // seconds it takes to shut

    /* --- 1 · the portals --- */
    portalRadius: 0.4, // metres, the aperture
    floorPortalRadius: 0.62, // the one in the floor the trunk goes through
    portalDistance: 2.9, // metres from the body
    portalSpread: 0.7, // random extra distance, metres
    portalJitter: 0.22, // random swing off each chain's line
    portalMinHeight: 0.6, // metres, the lowest a portal in the air may sit
    groundSpan: 1.3, // metres out to the two in the floor the legs are chained to
    blades: 7, // the iris
    irisOpen: 1.0, // how far it opens
    portalSpin: 0.7, // radians/second the filigree turns
    tunnelDepth: 2.4, // how deep the tunnel through it reads, in radii
    tunnelSpeed: 0.5, // rings/second streaming out of it
    runeGlow: 1.3, // the tunnel's rings
    lineGlow: 2.6, // the gold
    halo: 0.6,
    voidOpacity: 0.97,
    igniteFlash: 1.0, // the spark each one is lit with
    warpStrength: 0.6, // the lens round it
    warpSwirl: 0.45,
    portalLight: 9.0, // the light thrown off whichever portal is busiest
    portalLightRadius: 5.0,

    /* --- 2 · the chains --- */
    linkLength: 0.13, // metres, one link
    linkThickness: 1.0, // × the forged wire
    hookSize: 0.32, // metres, the barbed head
    curl: 0.9, // metres a chain arcs off the straight on its way out
    whip: 0.3, // metres of wave thrown down it as it flies
    whipWaves: 2.2, // waves along it
    sag: 0.18, // × its length, how far a slack chain hangs
    vibration: 0.022, // metres a taut chain thrums
    vibrationFreq: 23.0, // Hz
    jerkWave: 0.16, // metres of wave a haul sends down it
    wrapTurns: 2.6, // turns round the limb
    wrapReach: 1.0, // × how much of each limb its coil covers
    wrapRadius: 1.0, // × each limb's own girth
    runeScale: 3.5, // runes down each link
    chainRuneGlow: 1.1,
    heatGlow: 2.2, // how bright hot iron gets
    crackScale: 26.0, // the crust that breaks open as it heats
    metalness: 0.85,
    roughness: 0.42,
    ironEnv: 1.2, // the probe in the iron
    colorIron: '#2b2521',

    /* --- 3 · the hold --- */
    hangHeight: 1.75, // metres, the body's centre while it hangs
    reach: 1.0, // × how far each limb is held out from it
    grip: 0.12, // how hard each limb is held, 0..1 per pass
    waistGrip: 0.22, // how hard the trunk is held
    catchTime: 0.12, // seconds a chain takes to take its full grip
    kick: {
      impulse: 0.6, // m/s the first chain to land jolts it
      lift: 2.4,
      spin: 0.4
    },

    /* --- 4 · the strain --- */
    stretch: 0.16, // metres a limb is out of its socket on the last haul
    reachGain: 0.28, // × the hold, how much further each haul drags a limb
    seamStrain: 1.0, // how hot the seams run before they give
    jerkShake: 0.14,
    strainRumble: 0.035,
    ratchetLight: 25.0,

    /* --- 5 · the tear --- */
    tearShake: 0.24,
    tearLight: 30.0,
    tearFlash: 0.04,
    bloodCount: 130, // droplets per limb
    bloodSpeed: 5.5, // m/s
    goreCount: 9, // chunks per limb
    emberCount: 55, // embers per limb
    mistCount: 8, // puffs per limb
    recoilDepth: 1.4, // metres past its portal a limb is dragged
    tear: {
      tearNoise: 0.26, // how ragged the seam is
      tearNoiseScale: 15.0, // features up the body
      tearEdge: 0.07, // the hot band at the seam
      colorMeat: '#4a0709',
      meatGlow: 0.35,
      colorSeam: '#ffa53a',
      seamGlow: 6.5,
      veins: 1.0, // heat cracking out into a limb before it gives
      portalRimGlow: 6.0, // the line a portal burns across what goes through it
      portalRimWidth: 0.05
    },

    /* --- 6 · the seal --- */
    sealRadius: 1.9, // metres
    sealGlow: 1.3,
    sealDraw: 0.55, // seconds to inscribe it
    bloodPool: 1.15, // metres the pool spreads to
    bloodGrow: 1.6, // seconds it takes

    /* --- the air round it --- */
    sparkRate: 40, // per second off a chain grinding through its portal
    emberRate: 26, // per second drifting off the portals
    smokeRate: 7, // per second curling out of them

    /* --- the palette --- */
    colorGold: '#ffb547',
    colorCore: '#fff0d2',
    colorHeat: '#ff6a1c',
    colorDeep: '#b3121c',
    colorVoid: '#030102',
    colorLacquer: '#0e0a08',
    colorBlood: '#5c040a',
    colorBloodDark: '#160003',
    colorEmber: '#ffa040',
    colorSmoke: '#1c0b0b',
    colorReticle: '#ffb547', // the lock on the target while aiming
    colorLocked: '#fff0d2',

    /* --- light --- */
    lightIntensity: 14.0,
    lightRadius: 9.0,
    lightColor: '#ffa947'
  },

  /* ================================================================== */
  /* DRAGON — Dragonfire Circle                                          */
  /* ================================================================== */
  /**
   * A far cast, and a performance in five acts. A fuse of embers runs out to
   * the circle and the sky above it tears open; a dragon dives out of the tear
   * and flies one lap of the circle **breathing fire onto its edge**, so the
   * ring draws itself behind the breath; it climbs over the middle and roars,
   * and the fire runs **inward** from the ring until the whole disc is alight
   * and everything standing in it has burnt; a last breath into the middle
   * erupts it; and the dragon climbs back into the tear, which shuts behind
   * it, leaving the floor charred and smoking.
   *
   * Times in **The timing** are seconds, each act following the last; the
   * whole show is re-planned from them every frame, so dragging one moves
   * everything after it — on a cast that is already in the air. Distances on
   * the footprint (`orbitRadius`) are fractions of `zoneRadius`; everything
   * else is metres unless it says otherwise.
   */
  dragon: {
    /* --- the cast --- */
    range: 22.0, // max cast distance, metres
    minRange: 0,
    speed: 46.0, // the fuse's run to the circle, m/s
    cooldown: 9.0,
    castAnim: 'cast3',
    zoneRadius: 5.5, // the circle the dragon burns, metres
    fadeTime: 6.5, // seconds the scorched floor takes to cool and go
    fuseEmbers: 260, // embers/second the fuse sheds

    /* --- the timing --- */
    portalOpen: 0.6, // the sky tears open
    arriveTime: 1.75, // the dive, from the tear to the circle
    traceTime: 4.2, // one lap of the circle, breathing
    climbTime: 1.0, // off the ring and up over the middle
    roarTime: 0.9, // the roar that sets the field going
    spreadTime: 3.2, // the fire's run from the ring to the middle
    finaleTime: 0.75, // the last breath into the middle
    departTime: 2.0, // back up into the tear

    /* --- 1 · the tear in the sky --- */
    portalHeight: 12.5, // metres over the floor
    portalBack: 8.0, // metres past the circle, along the cast
    portalRadius: 3.6, // metres, fully open
    portalTilt: 0.6, // radians it is turned down toward the circle
    portalSpin: 1.3, // radians/second the vortex turns
    portalIntensity: 2.2,
    portalVoid: 0.92, // how black the inside is
    portalShake: 0.3, // when the dragon comes through
    portalLight: 60.0,
    portalLightRadius: 20.0,
    revealWidth: 0.4, // metres of molten edge where it passes through
    revealGlow: 9.0,

    /* --- 2 · the dragon --- */
    wingspan: 8.5, // metres, tip to tip
    altitude: 3.6, // metres it flies the lap at
    orbitRadius: 1.12, // its lap, × the zone radius — just outside the fire
    lag: 0.42, // radians it trails the point it is burning
    hoverHeight: 6.4, // metres over the middle while the field burns
    idleWeight: 0.3, // how much of the authored idle runs under the flight
    flapRate: 1.2, // wing beats/second on the lap
    flapAmplitude: 0.42, // radians at the shoulder, on the lap
    hoverRate: 0.95, // ...and hovering, where it has to work
    hoverAmplitude: 0.78,
    diveSweep: 0.75, // radians the wings fold back in the dive
    dihedral: 0.08, // radians the wings are held up
    bank: 0.7, // how hard it leans into a turn
    bob: 0.22, // metres the body lifts on each downstroke
    tailSway: 0.14, // radians
    neckCurl: 0.2, // radians the neck carries down in flight
    aimLimit: 1.5, // radians the neck will turn to point the mouth
    roarJaw: 0.8, // radians the jaw drops to roar
    breathJaw: 0.5, // ...and to breathe
    roarShake: 0.55,
    roarFlash: 0.06,
    underGlow: 0.9, // the fire's light on its belly and through its wings
    dragonRim: 0.45,
    dragonRimPower: 3.0,
    colorRim: '#ff6a24',

    /* --- 3 · the breath --- */
    breathWidth: 0.16, // metres at the lips
    breathSpread: 1.25, // metres where it lands
    breathCore: 0.34, // the white core, × the width
    breathSpeed: 19.0, // m/s the gas leaves at
    breathBend: 0.45, // how far the gas is left behind as the dragon flies
    breathNoiseScale: 1.4,
    breathShred: 1.5,
    breathIntensity: 2.0,
    breathPuffs: 110, // fire puffs/second along the jet
    splashRate: 70, // puffs/second thrown off where it lands
    breathSparks: 60, // sparks/second where it lands
    throatGlow: 1.6,
    breathLight: 32.0,
    breathShake: 0.15, // a rumble while it breathes

    /* --- 4 · the ring --- */
    ringHeight: 2.3, // metres of flame wall
    ringThick: 0.3, // metres between its two shells
    ringGrow: 0.45, // radians of lap it takes to come up to height
    ringFlare: 1.1, // how much taller it leaps where it has just caught
    ringNoiseScale: 1.2,
    ringRise: 1.8, // m/s the tongues climb
    ringShred: 1.35,
    ringIntensity: 1.7,
    ringBand: 0.55, // metres, the scorched band under it
    ringEmbers: 70, // embers/second off the lit ring
    closeShake: 0.4,
    closeFlash: 0.1,
    closeLight: 90.0,

    /* --- 5 · the spread --- */
    frontHeight: 1.9, // metres of flame on the advancing edge
    frontWobble: 0.65, // metres the edge is torn by
    frontWidth: 0.4, // metres of burning line on the floor
    frontGlow: 2.6,
    heatReach: 1.6, // metres behind the front that still burn hot
    blazeHeight: 1.45, // metres, the tongues standing in the burnt field
    blazeWidth: 1.05,
    blazeBurn: 2.0, // seconds a tongue roars before it settles
    blazeSustain: 0.35, // ...and the share of them that burn on after
    blazeLeap: 0.8, // how much taller it leaps when it catches
    blazeIntensity: 0.7,
    blazeNoiseScale: 1.6,
    fieldPuffs: 12, // fire puffs/second over the burning field
    fieldEmbers: 120, // embers/second over the burning field
    smokeRate: 16, // puffs/second
    smokeOpacity: 0.5,
    eruptionShake: 0.65,
    eruptionFlash: 0.16,
    eruptionLight: 140.0,
    eruptionEmbers: 260,

    /* --- 6 · the floor --- */
    charDark: 0.94,
    crackScale: 1.15, // plates per metre
    crackWidth: 0.05,
    crackGlow: 1.7,
    groundEmbers: 1.6,
    ash: 0.6, // pale ash flecks once it has cooled
    colorChar: '#050201',
    colorAsh: '#4b4541',
    colorHot: '#ff5f12',
    colorCrack: '#ff5c16',

    /* --- 7 · the bodies --- */
    burn: {
      stain: 1.4, // how fast a body chars, 1/s
      onset: 0.55, // seconds alight before it starts to go
      rate: 0.42, // how fast it burns away, 1/s
      flames: 34, // fire puffs/second off each burning body
      look: {
        color: '#0d0705', // charred
        rimColor: '#ff5a14', // the silhouette, glowing
        rimEmissive: 2.6,
        edgeColor: '#ffc266', // the line the burn runs along
        edgeEmissive: 7.0,
        edgeWidth: 0.16
      }
    },
    burnHit: {
      impulse: 1.6, // m/s it staggers in from the fire
      lift: 2.4,
      spin: 1.1
    },

    /* --- the aftermath --- */
    heatHaze: 0.1, // distortion over the field while it burns
    hazeHeight: 4.5, // metres
    lingerEmbers: 60, // embers/second off the cooling floor

    /* --- the fire's palette --- */
    tempCore: 3400, // K, the white-hot core
    tempEdge: 1400, // K, the deep red fringe
    emissionCurve: 2.4,
    palette: 0.35, // 0 pure radiator → 1 the four colours below
    colorCore: '#fff1c8',
    colorMid: '#ff8a1e',
    colorEdge: '#ff360a',
    colorEmber: '#2a0702',

    /* --- light --- */
    lightIntensity: 18.0, // on the dragon
    lightRadius: 12.0,
    lightColor: '#ff7a26',
    lightGutter: 0.3,
    lightGutterSpeed: 13.0,
    fieldLight: 14.0, // over the burning field
    fieldLightRadius: 16.0
  },

  /* ================================================================== */
  /* GYRO — Stormheart Gyroscope                                         */
  /* ================================================================== */
  /**
   * A far cast. A violet arc crawls along the floor to the circle; a sigil
   * writes itself round it and a shaft of light falls into it; a brass
   * gyroscope condenses out of its own rune at the top of the shaft and comes
   * down it, rings spinning; the rune charges into a star; and then it fires
   * lightning into everyone standing in the circle, one at a time, each bolt
   * free to jump on to the next body near it. It ends in an overload — a ring
   * of bolts to the edge and one into everyone left — and burns back into the
   * rune.
   *
   * Times in **The timing** are seconds, each act following the last, and are
   * re-read every frame. `size` is the gyroscope's height in metres.
   */
  gyro: {
    /* --- the cast --- */
    range: 20.0,
    minRange: 0,
    speed: 34.0, // the arc's run along the floor, m/s
    cooldown: 8.0,
    castAnim: 'cast2',
    zoneRadius: 6.0, // the circle it claims, metres
    fuseSparks: 160, // sparks/second off the running arc
    fuseArcs: 18, // arcs/second licking back along it

    /* --- the timing --- */
    summonTime: 1.6, // sigil, shaft, and the gyroscope condensing
    chargeTime: 1.1, // the rune lighting up
    stormTime: 5.0, // the strikes
    overloadTime: 0.9, // the discharge
    departTime: 1.2, // burning back into the rune

    /* --- 1 · the summoning --- */
    size: 3.4, // metres tall, stand to crown — it stands on the floor
    arriveDrop: 2.6, // metres over its stand it condenses at, before it drops
    landAt: 0.82, // fraction of the summoning at which the stand hits the floor
    departRise: 0.0, // metres it lifts as it leaves
    revealWidth: 0.22, // metres of violet fire on the condensing front
    revealGlow: 4.5,
    revealColor: '#a46bff',
    columnRadius: 2.0,
    columnIntensity: 1.1,
    moteRate: 220, // motes/second spiralling in
    moteSize: 0.09,
    moteSwirl: 3.2, // radians/second they turn as they fall in
    formShake: 0.4, // the stand hitting the floor
    formFlash: 0.06,

    /* --- 2 · the construct --- */
    spinRate: 1.0, // × the authored spin, at rest
    spinSummon: 5.0, // ...while it condenses
    spinStorm: 1.8, // ...in the storm
    spinDepart: 7.0, // ...as it leaves
    strikeKick: 2.5, // extra spin on each strike
    yawSpeed: 0.12, // radians/second the whole thing turns on its stand
    sway: 0.0, // radians — it stands, so none by default
    bobAmplitude: 0.0,
    bobRate: 0.35,
    rimColor: '#9a6bff',
    rimStrength: 0.2,
    rimPower: 3.2,
    gemGlow: 3.0, // how hard the amethyst lights with the charge

    /* --- 3 · the core --- */
    coreSize: 3.2, // metres across, fully charged
    coreIntensity: 1.6,
    coreRays: 7,
    coreFlicker: 0.35,
    starRate: 90, // stars/second born round it
    starSize: 0.16,
    starReach: 1.1, // × the ring radius
    crawlRate: 9, // arcs/second from the core out to the rings
    chargeRumble: 0.05,

    /* --- 4 · the sigil --- */
    sigilIntensity: 1.1,
    sigilSpin: 0.35,
    sigilFill: 0.14,

    /* --- 5 · the strikes --- */
    strikeInterval: 0.45, // seconds between strikes
    chainJumps: 1, // bodies a bolt jumps on to after the first
    chainRange: 4.5, // metres a jump reaches
    chainDelay: 0.12, // seconds between links
    idleStrikeRate: 2.4, // floor strikes/second with nobody left to hit
    aimHeight: 0.6, // × body height
    boltWidth: 0.15, // metres, half-width of the ribbon
    boltCore: 0.16, // the white spine, × the width
    boltJag: 0.2,
    boltArch: 0.12,
    boltForks: 3,
    boltLife: 0.38,
    boltLeader: 0.045, // seconds the leader takes to reach the mark
    boltRestrikes: 3,
    boltIntensity: 3.0,
    impactSparks: 46,
    strikeShake: 0.22,
    strikeFlash: 0.05,
    strikeLight: 60.0,
    strikeLightRadius: 9.0,
    hit: {
      impulse: 8.5,
      lift: 4.0,
      spin: 1.6
    },

    /* --- 6 · the overload --- */
    novaBolts: 10,
    novaShake: 0.6,
    novaFlash: 0.16,
    novaLight: 120.0,

    /* --- palette --- */
    colorCore: '#ffffff',
    colorBolt: '#dccbff',
    colorGlow: '#7b3dff',
    colorArc: '#62d6ff',
    colorStar: '#efe4ff',
    colorSigil: '#9b6bff',
    colorSigilGold: '#ffcf7a',

    /* --- light --- */
    lightIntensity: 11.0, // at the core
    lightRadius: 12.0,
    lightColor: '#a77bff',
    lightGutter: 0.35
  },

  /* ================================================================== */
  /* TOME — Astral Tome                                                  */
  /* ================================================================== */
  /**
   * A far cast. A clasped tome materialises at the caster's shoulder, flies
   * to the middle of the circle and swells to full size over it; a fan of
   * light pours out of the zodiac dial on its cover, a star rises out of it,
   * and an orrery draws itself round the star — orbits at every tilt, a
   * planet on each. Then the planets tear free one after another and come
   * down as lights on everyone standing in the circle, each drawing a beam
   * behind it. The star throws a last light at whoever is left, and the
   * orrery and the book fold away.
   *
   * Times in **The timing** are seconds, each act following the last, and
   * are re-read every frame — except the flight, which is fixed at the cast
   * from the distance and `flySpeed`. `size` is the tome's width in metres.
   * The book was built in Blender (`public/models/arcane_tome.glb`).
   */
  tome: {
    /* --- the cast --- */
    range: 20.0,
    minRange: 0,
    speed: 30.0, // unused — the tome flies on its own clock; see flySpeed
    cooldown: 8.0,
    castAnim: 'cast1',
    zoneRadius: 6.0, // the circle it claims, metres

    /* --- the timing --- */
    conjureTime: 0.85, // materialising at the shoulder
    flySpeed: 11.0, // m/s along the arc to the circle...
    flyMin: 0.6, // ...but never quicker than this, seconds
    flyMax: 1.5, // ...nor slower
    growTime: 0.65, // swelling to full size
    openTime: 1.1, // the fan, the star, the orrery drawing itself
    judgeTime: 3.2, // the lights falling
    closeTime: 1.3, // the last light, and folding away

    /* --- 1 · the conjuring --- */
    conjureSize: 0.55, // metres across, at the shoulder and in flight
    conjureHeight: 1.55, // metres over the floor
    conjureReach: 0.8, // metres ahead of the caster
    conjureSide: 0.45, // metres to the side
    conjureMotes: 180, // motes/second spiralling in
    moteSize: 0.06,
    moteSwirl: 3.0,
    edgeWidth: 0.08, // of the materialising front, × the book
    edgeGlow: 6.0,
    colorEdge: '#5fb6ff',

    /* --- 2 · the flight --- */
    flyArc: 2.2, // metres it rises over the higher end
    flySpin: 1.0, // turns it makes on the way
    flyTilt: 0.35, // radians it banks
    flyTrail: 160, // particles/second shed behind it

    /* --- 3 · the book --- */
    size: 2.3, // metres across, full size
    hoverHeight: 1.15, // metres, the middle of the book
    hoverBob: 0.06,
    bobRate: 0.4,
    yawSpeed: 0.22, // radians/second it turns as it hangs there
    glyphGlow: 4.0, // how hard the dial, glyphs and gems light with the charge
    rimStrength: 0.25,

    /* --- 4 · the orrery --- */
    holoHeight: 1.7, // metres the star rises over the dial
    holoRadius: 2.3, // metres, the widest orbit
    planets: 4, // 0–6
    orbitSpeed: 0.9, // radians/second round the widest orbit
    orbitWidth: 0.014, // metres, the line
    orbitIntensity: 1.4,
    planetSize: 0.6,
    planetIntensity: 1.3,
    planetRegrow: 0.8, // seconds a thrown planet takes to gather again
    coreSize: 1.7,
    coreIntensity: 1.6,
    fanRadius: 1.25, // metres across the top of the fan
    fanIntensity: 1.2,
    fanMotes: 90,
    starRate: 80, // stars/second about the orrery
    starSize: 0.09,
    starReach: 1.2, // × holoRadius
    openFlash: 0.05,

    /* --- 5 · the judgement --- */
    strikeInterval: 0.3, // seconds between throws
    idleStrikeRate: 1.5, // floor throws/second with nobody left
    cometFlight: 0.42, // seconds a light takes to land
    cometArc: 0.18, // how far it bows up, × the distance
    cometSize: 0.7,
    cometIntensity: 1.6,
    trailDensity: 18, // trail particles per metre
    beamWidth: 0.07,
    beamIntensity: 2.4,
    aimHeight: 0.6, // × body height
    impactSparks: 40,
    strikeShake: 0.18,
    strikeFlash: 0.04,
    strikeLight: 50.0,
    strikeLightRadius: 8.0,
    hit: {
      impulse: 7.0,
      lift: 5.0,
      spin: 1.4
    },

    /* --- 6 · the finale --- */
    finaleShake: 0.45,
    finaleFlash: 0.12,
    finaleLight: 90.0,

    /* --- 7 · the zodiac --- */
    sigilIntensity: 1.1,
    sigilSpin: 0.4,

    /* --- palette --- */
    colorCore: '#ffffff',
    colorGlow: '#2a7dff',
    colorLine: '#5ab6ff',
    colorSpark: '#e4f5ff',
    colorStar: '#cfe9ff',
    colorSigil: '#3a86ff',
    colorDeep: '#0a2470',

    /* --- light --- */
    lightIntensity: 10.0,
    lightRadius: 11.0,
    lightColor: '#4f9dff'
  },

  /* ================================================================== */
  /* RELIQUARY — Wildroot Reliquary                                      */
  /* ================================================================== */
  /**
   * A targeted far cast: one body, taken back by the earth. A seed skims to
   * the target; two braided roots burst out of the floor either side of it
   * and climb into an arch over it; a broken ring of carved slabs and a
   * horseshoe of rune cubes rise into the arch; four tendrils take the body
   * by the wrists and ankles and hold it spread in the ring while the runes
   * light; then the arch clenches and drags it down into the floor, the
   * stones come down, the roots wither back, and a sapling comes up where it
   * stood.
   *
   * Times in **The timing** are seconds after the seed lands. The slabs and
   * cubes are cut in Blender (`public/models/wildroot_reliquary.glb`); the
   * roots and leaves are procedural, placed by a vertex shader off curves
   * re-solved every frame — so every number here stays live mid-cast.
   */
  reliquary: {
    /* --- the cast --- */
    range: 18.0,
    minRange: 0,
    speed: 30.0, // the seed's run to the target, m/s
    cooldown: 9.0,
    castAnim: 'cast3',
    zoneRadius: 3.0, // the sigil round the target, metres
    snapRadius: 2.4, // how far from the cursor a body is snapped onto, metres
    fadeTime: 2.4, // seconds the sapling and the sigil take to go

    /* --- the timing --- */
    drawTime: 0.6, // the sigil writing itself
    archAt: 0.2, // the great roots break the floor
    archGrow: 1.15, // seconds they take to climb over
    haloAt: 0.85, // the first slab comes up
    haloRise: 0.75, // seconds a slab takes to rise into place
    haloStagger: 0.1, // seconds between slabs
    cubeStagger: 0.035, // seconds between cubes
    bindAt: 1.55, // the tendrils come up for the body
    whipTime: 0.42, // seconds they take to reach it
    wrapTime: 0.3, // seconds to wind round the limb
    hoistTime: 0.95, // seconds to haul it up into the ring
    igniteAt: 2.75, // the runes start to light
    igniteTime: 1.5, // seconds to light the whole ring
    finaleDelay: 0.25, // after the last rune, before the cubes dive
    diveTime: 0.38, // seconds the cubes take to dive into it
    dragTime: 0.7, // seconds to drag it under
    witherDelay: 0.45,
    witherTime: 1.9, // seconds the roots take to draw back into the floor
    saplingGrow: 1.3,

    /* --- 1 · the sigil --- */
    sigilIntensity: 1.0,
    sigilSpin: 0.5,

    /* --- 2 · the arch --- */
    archSpan: 2.7, // metres from the body to each foot
    archHeight: 4.7, // metres to the apex
    archBehind: 0.35, // metres the arch stands behind the body
    archRadius: 0.3, // metres, at the foot
    archTipRadius: 0.07,
    archFlare: 0.9, // how much the foot swells
    archTwist: 0.55, // turns per metre the strands braid at
    archTwine: 0.3, // metres each leans off the plane, crossing over the top
    archSway: 0.05, // metres
    vines: 1, // wound round each great root (0–2)
    vineRadius: 0.06,
    vineTurns: 0.45, // turns per metre
    curls: 8, // tendrils curling off the arch (0–8)
    curlLength: 1.25, // metres
    curlRadius: 0.06,
    groundRoots: 4, // crawling out of the feet (0–4)
    groundLength: 1.9,
    eruptShake: 0.22,

    /* --- 3 · the bark and the leaves --- */
    barkBump: 0.8,
    moss: 0.22,
    lichen: 0.35,
    veinGlow: 1.0, // light in the crevices
    sapGlow: 1.0, // the sap pulses, once the runes are lit
    sapSpeed: 1.0,
    tipGlow: 5.0, // the growing tip
    barkRim: 0.35,
    barkEnv: 0.35, // how much of the hall the bark reflects
    taper: 0.55, // metres the tip tapers over
    leafSize: 0.3, // metres
    leafTranslucency: 1.0,

    /* --- 4 · the reliquary --- */
    haloHeight: 2.35, // metres, the middle of the ring
    haloRadius: 1.8, // metres, the outside of the slabs
    haloSpan: 296, // degrees the slabs are spread over, open at the bottom
    haloSway: 0.08, // radians it rocks
    slabs: 4, // (2–5)
    slabThickness: 1.0, // × the cut thickness
    slabDropStagger: 0.08, // seconds between slabs falling
    sinkSpeed: 0.25, // × the radius per second, once fallen
    cubes: 13, // (0–16)
    cubeRadius: 1.12, // metres
    cubeSize: 0.21, // metres
    cubeSpan: 240, // degrees the cubes are spread over
    cubeTumble: 0.55, // radians/second
    converge: 0.22, // how far they close in as the runes light

    /* --- 5 · the stone --- */
    patina: 0.4,
    glyphGlow: 1.0,
    carveDepth: 1.0,
    stoneRim: 0.45,
    stoneEnv: 1.1,
    auraIntensity: 1.0,

    /* --- 6 · the binding --- */
    sproutRadius: 1.25, // metres from the body the tendrils come up
    tendrilRadius: 0.055,
    wrapTurns: 2.6,
    wrapRadius: 0.07, // metres off the bone
    spreadArms: 0.82, // metres out from the middle
    armsUp: 0.6, // metres above the middle of the ring
    spreadLegs: 0.3,
    legsDown: 0.95, // metres below it
    bindShake: 0.12,
    overgrow: 1.0, // how far the bark takes the body
    hit: {
      impulse: 0.6, // the first bite takes it off its feet
      lift: 2.4,
      spin: 0.3
    },
    look: {
      color: '#1d1810', // bark
      rimColor: '#3fffd0', // the silhouette, lit by the sap
      rimEmissive: 2.2,
      edgeColor: '#b8fff0', // the line it goes under along
      edgeEmissive: 6.0,
      edgeWidth: 0.08
    },

    /* --- 7 · the reclamation --- */
    dragDepth: 2.6, // metres it is dragged under
    finaleLeaves: 110,
    finaleSpores: 150,
    finaleDirt: 14,
    finaleShake: 0.55,
    finaleFlash: 0.12,
    finaleLight: 80.0,

    /* --- 8 · the sapling --- */
    saplingHeight: 0.8, // metres (0 for none)
    saplingRadius: 0.035,
    saplingGlow: 1.0,

    /* --- 9 · the air --- */
    sporeRate: 70,
    leafFall: 14,

    /* --- palette --- */
    colorBarkDark: '#2a2119',
    colorBark: '#7d6c5b',
    colorMoss: '#5c8a2c',
    colorLichen: '#2fb8a8',
    colorVine: '#4f7a2a',
    colorVein: '#3fffd0',
    colorTip: '#e6fff8',
    colorDry: '#5b5248',
    colorLeaf: '#7fd23c',
    colorLeafDark: '#24561a',
    colorStoneDark: '#151c1c',
    colorStone: '#3d4a48',
    colorPatina: '#2a9e94',
    colorGlyph: '#cfe9e4',
    colorGlyphHot: '#bffff4',
    colorSigil: '#2fe6c4',
    colorAura: '#1fbfa5',
    colorDirt: '#3a3026',

    /* --- light --- */
    lightIntensity: 12.0,
    lightRadius: 11.0,
    lightColor: '#3fffd0'
  },

  /* ================================================================== */
  /* AMETHYST — Amethyst Verdict                                         */
  /* ================================================================== */
  /**
   * A targeted far cast: one body, crushed. The circle locks onto whoever is
   * under the cursor. A rite writes itself on the floor round them, with a
   * socket circle at every point of a star on its edge; an amethyst point
   * rises out of every socket and hangs there, charging; they all turn their
   * points on the body, draw back, and come in one after another, each one
   * shattering on it. The last of them sets off the whole circle.
   *
   * Times in **The timing** are seconds after the cast lands, each act
   * following the last. Everything is re-read every frame. The stones are the
   * five cut in Blender (`public/models/amethyst_stones.glb`), dealt out at
   * random to the sockets.
   */
  amethyst: {
    /* --- the cast --- */
    range: 18.0,
    minRange: 0,
    speed: 48.0, // the cast's run to the target, m/s
    cooldown: 7.0,
    castAnim: 'cast2',
    zoneRadius: 3.2, // the circle round the target, metres
    snapRadius: 2.4, // how far from the cursor a body is snapped onto, metres
    fadeTime: 1.6, // seconds the circle and the dust take to go

    /* --- the timing --- */
    drawTime: 0.45, // the circle writing itself
    socketStagger: 0.07, // seconds between one socket opening and the next
    socketOpen: 0.3, // seconds a socket takes to inscribe itself
    riseTime: 0.55, // seconds a stone takes to come up out of its socket
    riseStagger: 0.08, // seconds between stones rising
    hoverTime: 0.55, // seconds they hang, charging, before they turn
    aimTime: 0.4, // seconds they take to turn their points on the body
    launchStagger: 0.09, // seconds between one stone coming and the next
    flightTime: 0.2, // seconds a stone takes to cross to the body
    finaleDelay: 0.08, // seconds after the last stone before the circle goes off
    afterTime: 0.9, // seconds the rite holds after the finale

    /* --- 1 · the circle --- */
    stones: 6, // sockets on the edge, one stone each (3–8)
    socketRadius: 0.55, // metres
    circleIntensity: 1.1,
    circleSpin: 0.5,

    /* --- 2 · the stones --- */
    stoneSize: 1.35, // metres tall
    stoneSizeVariance: 0.18,
    hoverHeight: 2.1, // metres, the middle of a hanging stone
    hoverVariance: 0.45,
    hoverBob: 0.08, // metres
    hoverSpin: 0.9, // radians/second about its own axis
    riseOvershoot: 0.25, // metres it overshoots before settling
    windup: 0.55, // metres it draws back before it comes
    tremble: 0.025, // metres, while it is drawn back
    flightSpin: 9.0, // radians/second it drills on the way in
    stopShort: 0.18, // metres short of the body's middle it breaks
    aimHeight: 0.95, // metres, where on a standing body they aim

    /* --- 3 · the crystal --- */
    stoneCloud: 1.0,
    stoneVeins: 1.0,
    stoneInner: 0.35, // light held inside, at rest
    stoneRim: 0.55,
    stoneEnv: 1.4,
    chargeGlow: 1.0, // how lit the stones get before they come

    /* --- 4 · the shattering --- */
    shards: 14, // real pieces per stone
    shardSize: 0.2, // metres
    shardSpeed: 6.5, // m/s
    shardLife: 2.4, // seconds before they melt away
    chipCount: 40, // fine chips per stone
    sparkCount: 34,
    dustCount: 6,
    impactShake: 0.14,
    impactLight: 26.0,
    hit: {
      impulse: 2.5, // the first stone takes it off its feet
      lift: 3.0,
      spin: 0.9
    },
    shove: 3.2, // m/s each later stone drives the body along its line
    shoveLift: 1.2, // m/s up with each

    /* --- 5 · the finale --- */
    finaleLift: 6.5, // m/s the body is thrown up
    finaleShards: 22,
    finaleShake: 0.5,
    finaleFlash: 0.12,
    finaleLight: 90.0,

    /* --- palette --- */
    colorDeep: '#2a0b45',
    colorStone: '#7a3aa8',
    colorPale: '#e2c6f5',
    colorGlow: '#b56bff',
    colorVein: '#fff1ff',
    colorCircle: '#9a5cff',
    colorSocket: '#e0b3ff',
    colorCharge: '#ff7af0',
    colorSpark: '#f6d9ff',
    colorDust: '#6b4a85',

    /* --- light --- */
    lightIntensity: 10.0,
    lightRadius: 9.0,
    lightColor: '#b06bff'
  },

  /* ================================================================== */
  /* SHARD — Corrupted Shard Spawn                                       */
  /* ================================================================== */
  /**
   * A far cast built to the six-panel breakdown sheet — ground rune decal,
   * rising crystal shards, radial water splash, dark mist tendrils, glow
   * flash, corrupted droplets — and this block is grouped in exactly those six
   * sections, so a panel of the sheet and a folder of the editor are the same
   * thing. A seventh section, **the beam**, is what the composite implies and
   * the sheet does not draw: the glow flash is a *light source*, and once it is
   * lit it fires a beam of that light at whatever is standing in reach.
   *
   * The palette is the load-bearing decision. Everything here is one hue —
   * violet — pushed two ways: **cold** toward indigo and near-black for the
   * water, the mist and the crystal bases; **hot** toward magenta and white for
   * the corruption sealed inside the gems, the flare and the beam. The single
   * pure white on the sheet is the flash, and the beam carries it out.
   *
   * Two units are in play. Anything about the **footprint** — where the
   * crystals are planted, how wide the splash is, the rune's rails — is a
   * fraction of `zoneRadius`, so dragging the footprint re-seats the whole
   * spawn. Anything about a **single thing** — a crystal's height, a rail's
   * stroke, a droplet's size — is in metres.
   */
  shard: {
    /* --- the cast --- */
    range: 22.0, // maximum cast distance, metres
    minRange: 0.0, // it can be planted at the caster's own feet
    zoneRadius: 3.6, // the footprint — what the circle indicator measures out
    speed: 64.0, // how fast the seed runs to the point, metres/second
    cooldown: 3.0,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
    lifetime: 7.0, // seconds the spawn stands, once it is lit
    fadeTime: 1.7, // seconds it takes to go out

    /* --- the order things happen in, seconds from the seed landing --- */
    /**
     * The spawn is a *sequence*: the rune is cut before anything comes through
     * it, the water is thrown by the crystals breaking the floor, the flash
     * ignites once the crystals are standing around it, and the beam is only
     * armed once there is a light to fire it from.
     */
    runeTime: 0.4, // the rune races out to the boundary
    splashRise: 0.2, // the crown goes up over
    splashHold: 0.08, // ... hangs for
    splashFall: 0.6, // ... and falls away over
    crystalDelay: 0.08, // the first crystal breaks the floor at
    crystalTime: 0.5, // how long one takes to reach full height
    crystalStagger: 0.55, // how much later the last one may leave than the first
    crystalOvershoot: 0.12, // how far past full height the punch throws it
    crystalSettle: 0.28, // seconds it takes to drop back onto its seat
    flareDelay: 0.42, // the flash ignites at
    flareTime: 0.3, // ... and reaches full brightness over
    mistDelay: 0.15, // the tendrils start rising at
    fireDelay: 0.35, // seconds after the flash is lit before the first beam

    /* --- where the seed leaves the caster --- */
    handHeight: 1.25, // metres above the floor
    handForward: 0.62, // metres in front of the caster
    handSide: -0.14, // metres to the side (+ follows `Ability#side`)

    /* --- the pulse everything glowing rides --- */
    /**
     * Fast and shallow, with a *snap* in it:
     * this is not a plant, it is a light source with something wrong sealed in
     * it. Two sines a fifth apart, sharpened.
     */
    pulseRate: 1.7, // radians/second through the envelope
    pulseDepth: 0.45, // how hard it modulates, 0 = flatline

    /* ------------------------------------------------------------------ */
    /* Layer 1 — the ground rune                                           */
    /* ------------------------------------------------------------------ */
    runeRailWidth: 0.03, // stroke thickness, metres
    runeRailOuter: 1.0, // the boundary rail, × footprint
    runeRailTwin: 0.955, // the second rail just inside it
    runeRailInner: 0.84, // the rail the glyph band sits against
    runeRailMid: 0.6, // the rail the star is inscribed in
    runeRailHub: 0.15, // the hub
    runeRailGlow: 1.8,
    runeSpin: 0.018, // revolutions/second the ring turns

    runeGlyphs: 42, // glyphs around the band
    runeGlyphBand: 0.27, // height of the band, metres
    runeGlyphSeat: 0.905, // where it sits, × footprint
    runeGlyphWeight: 0.055, // stroke thickness, cell space
    runeGlyphStrokes: 0.55, // how many candidate strokes a glyph keeps
    runeGlyphSweep: 1.6, // brightness of the read head running round it
    runeGlyphSweepSpeed: 0.17, // revolutions/second
    runeGlyphSweepWidth: 0.1, // how much of the ring it covers
    runeGlyphFlicker: 0.28, // per-glyph brightness stutter
    runeGlyphGlow: 2.4,

    runeStar: 1.1, // the hexagram inscribed in the mid rail
    runeStarWidth: 0.028, // metres
    runeStarSpin: -0.011, // counter to the ring
    runeHex: 0.7, // the hexagon through the star's points
    runeOrbits: 0.9, // the small circles on those points
    runeOrbitRadius: 0.1, // × footprint
    runeSpokes: 6, // radial lines from the hub to the inner rail
    runeSpokeWidth: 0.018, // metres
    runeSpokeGlow: 0.65,
    runeTicks: 0.8, // graduations on the outer rail
    runeTickCount: 60,
    runeTickWidth: 0.3,
    runeTickLength: 0.05, // × footprint

    runeWash: 0.34, // the wash of light inside the circle
    runeWashFalloff: 2.0,
    runeGrain: 0.5, // break-up over that wash
    runeGrainScale: 2.4,
    runeOpacity: 1.0,
    runeGlow: 1.2,
    runeHeight: 0.03, // hover distance above the floor, metres

    /* ------------------------------------------------------------------ */
    /* Layer 2 — the crystal shards                                        */
    /* ------------------------------------------------------------------ */
    /**
     * Three populations, as the sheet draws them: one **spire** in the middle
     * that owns the silhouette, a ring of **blades** around it leaning outward,
     * and a skirt of short fat **shards** at the foot that stop the cluster
     * floating on the rune. Capacity is 24; the count is dealt round the three.
     */
    crystals: 12,
    spireHeight: 3.7, // the middle one, metres
    bladeHeight: 2.3, // the ring, metres
    shardHeight: 1.0, // the skirt, metres
    crystalHeightJitter: 0.35,
    crystalRadius: 0.36, // base radius of a blade, metres
    crystalRadiusJitter: 0.3,
    bladeSeat: 0.36, // where the ring is planted, × footprint
    shardSeat: 0.62, // ... and the skirt
    crystalSeatJitter: 0.25,
    bladeLean: 0.42, // radians the ring leans outward
    shardLean: 0.6, // ... and the skirt
    crystalLeanJitter: 0.35,
    crystalTwist: 1.0, // how far each is yawed about its own axis
    crystalFacets: 6, // sides on the prism
    crystalTaper: 0.11, // tip radius, × base
    crystalRough: 0.32, // how far facets are pushed off a clean prism
    crystalBend: 0.16, // sideways curve from base to tip
    crystalSinkTime: 0.9, // seconds they take to withdraw as the spawn goes
    shatterChips: 90, // fragments thrown as they go

    /* --- what the stone is made of --- */
    gemDepthTint: 1.3, // how hard the body darkens where you look into it
    gemFresnel: 2.0,
    gemFresnelPower: 2.6,
    gemDispersion: 0.6, // how far the rim splits into its colours
    gemFacetSharp: 0.75, // how hard facets are lifted toward the camera
    gemScreenKey: 0.7, // how much of that lift comes from a screen-space key
    gemCleave: 0.7, // internal cleavage planes
    gemCleaveScale: 7.0,
    gemVein: 1.1, // the corruption sealed in the flaws
    gemVeinScale: 3.2,
    gemVeinFlow: 0.4, // how fast it climbs
    gemVeinBase: 0.3, // how much thinner it is at the tip than the base
    gemVeinSharp: 5.0,
    gemBaseDark: 0.28, // how far up the obsidian foot reaches, 0..1
    gemTipFrost: 0.55, // the milky band at the tip
    gemTipStart: 0.62,
    gemGlint: 0.7,
    gemGlintScale: 28,
    gemGlintSpeed: 0.6,
    gemGlow: 0.75,
    gemEdgeGlow: 0.6,
    gemBodyGlow: 0.45, // the glass lit from inside — what keeps it violet on a dark stage
    gemBirthGlow: 0.6, // how incandescent a crystal is as it tears out
    gemBirthFade: 0.45, // seconds that takes to cool
    gemChargeGlow: 2.0, // how hot the veins run as the beam winds up
    gemCoreBleed: 0.55, // how much of the flash's light lands on the facets
    gemCoreBleedRadius: 3.6, // metres it carries
    gemOpacity: 0.96,
    gemRoughness: 0.14,
    gemEnv: 1.0,

    /* ------------------------------------------------------------------ */
    /* Layer 3 — the radial water splash                                   */
    /* ------------------------------------------------------------------ */
    splashRadius: 0.5, // where the crown stands, × footprint
    splashHeight: 2.1, // how high the fingers reach, metres
    splashFingers: 24, // roughly how many
    splashFingerDepth: 0.9, // how much lower the wall is between them
    splashFlare: 0.3, // how far the wall leans out as it stands
    splashLean: 1.1, // ... and how much further as it falls
    splashCurl: 0.18, // how far the tips curl back in
    splashWobble: 0.08, // how far the wall wanders off round
    splashWobbleScale: 2.2,
    splashTear: 0.55, // how far down the crest is torn into spray
    splashFresnel: 1.3,
    splashOpacity: 1.0,
    splashGlow: 1.0,
    splashRipple: 1.25, // the ring that runs out across the floor, × footprint
    splashDrops: 160, // droplets flung off the crown
    splashDropSpeed: 6.0,
    splashDropSize: 0.14,
    splashDropLife: 1.3,

    /* ------------------------------------------------------------------ */
    /* Layer 4 — the dark mist tendrils                                    */
    /* ------------------------------------------------------------------ */
    mistRate: 40.0, // puffs per second while it stands
    mistSize: 0.9,
    mistLifetime: 2.8,
    mistSpeed: 0.8,
    mistRise: 0.6,
    mistSwirl: 1.6, // radians/second it coils round the cluster
    mistSwirlExpand: 0.5, // how far out it drifts as it coils
    mistOpacity: 0.75,
    mistTurbulence: 0.85,
    mistBurst: 60, // the gout as the floor breaks

    /* ------------------------------------------------------------------ */
    /* Layer 5 — the glow flash                                            */
    /* ------------------------------------------------------------------ */
    flareHeight: 1.45, // metres above the floor — the heart of the cluster
    flareSize: 1.45, // half-width of the quad, metres
    flareCore: 1.0, // the white point
    flareCoreSize: 0.13, // × the quad
    flareRays: 1.0, // the four long rays
    flareRayLength: 1.0, // × the quad
    flareRaySharp: 3.2, // how narrow they are
    flareDiagonals: 0.42, // the four short rays between them
    flareStreak: 0.75, // the horizontal lens streak
    flareStreakLength: 1.0, // × the quad
    flareHalo: 0.55, // the soft bloom around it
    flareHaloFalloff: 2.4,
    flareRing: 0.12, // the faint ring at the edge of the halo
    flareRingRadius: 0.5, // × the quad
    flareSpin: 0.03, // revolutions/second the rays turn
    flareFlicker: 0.14, // how hard it stutters
    flareChargeGain: 1.6, // how much bigger and brighter it runs as a beam winds up
    flareIgnite: 2.6, // the pop as it lights
    flareIntensity: 2.2,
    flareOpacity: 1.0,

    /* ------------------------------------------------------------------ */
    /* Layer 6 — the corrupted droplets                                    */
    /* ------------------------------------------------------------------ */
    beadRate: 24.0, // beads per second shed while it stands
    beadSize: 0.1,
    beadLifetime: 2.6,
    beadSpeed: 0.7,
    beadRise: 0.12,
    beadSwirl: 0.8, // radians/second they drift round the cluster
    beadBurst: 80, // thrown as the flash ignites
    glintRate: 14.0, // the pinpoints of light among them
    glintSize: 0.07,
    glintLifetime: 1.4,

    /* ------------------------------------------------------------------ */
    /* The beam                                                            */
    /* ------------------------------------------------------------------ */
    /**
     * What the flash does once it is lit.
     *
     * It picks the nearest body still standing inside `laserRange` of the
     * spawn, winds up for `laserWarmup` — the flare swells and the veins in
     * every crystal run hot, which is the only warning a body gets — then fires
     * a beam of its own light straight through it. What it hits is thrown, and
     * then burnt out from the inside.
     */
    laserEnabled: true,
    laserRange: 12.0, // metres from the spawn
    laserInterval: 0.55, // seconds between shots
    laserWarmup: 0.3, // seconds the flash charges before one leaves
    laserVolley: 1, // targets taken per shot
    laserLife: 0.4, // seconds a beam is on screen
    laserWidth: 1.0, // master on its thickness
    laserAim: 0.58, // where up the body it lands, 0 feet 1 head
    laserShake: 0.16, // the knock on the camera
    laserFlash: 0.16, // and the flash
    /** How the body leaves. A beam is a *push*, so it goes back and up. */
    laserHit: { impulse: 5.5, lift: 3.4, spin: 2.0 },

    /* --- what the light does to a body it has gone through --- */
    burn: {
      enabled: true,
      stain: 2.6, // how fast the violet takes the body over, per second
      onset: 0.3, // seconds after the hit before it starts to go
      rate: 1.1, // how fast it is burnt away once it starts, per second
      look: {
        color: '#170a2a', // the flesh, lit from inside
        rimColor: '#e070ff', // the silhouette, while it still has one
        rimEmissive: 2.2,
        edgeColor: '#fff2ff', // the line the burn runs along
        edgeEmissive: 4.4,
        edgeWidth: 0.05
      }
    },
    impactBeads: 46, // what comes out of a body the beam has gone through
    impactGlints: 28,
    impactScorch: 0.7, // the mark under it, metres

    beamRadius: 0.06, // half-width at the far end, metres
    beamMuzzleRadius: 0.13, // ... and where it leaves the flash
    beamRadiusCurve: 0.7,
    beamFlare: 0.6, // how much it opens where it lands
    beamFlareWidth: 0.12,
    beamRipple: 0.08, // pressure ripple along its width
    beamRippleBands: 7,
    beamRippleSpeed: 6.0,
    beamStrike: 0.1, // fraction of its life spent arriving
    beamHold: 0.5, // ... and how long before it starts to go
    beamCoreFill: 2.2, // how hard the white is weighted to the axis
    beamEdgePower: 2.4,
    beamSheath: 0.8,
    beamPulse: 1.2, // charge racing along it
    beamPulseBands: 6,
    beamPulseSpeed: 9.0,
    beamPulseSharp: 7.0,
    beamHeadGlow: 2.6,
    beamHeadWidth: 0.07,
    beamMuzzleGlow: 1.7,
    beamMuzzleWidth: 0.08,
    beamIntensity: 2.6,
    beamOpacity: 1.0,
    beamSoftFade: 0.3,

    /* ------------------------------------------------------------------ */
    /* Impact, camera and light                                            */
    /* ------------------------------------------------------------------ */
    muzzleSize: 0.5, // the flash at the caster's hand
    muzzleIntensity: 1.3,
    castFlash: 0.1,
    seedBeads: 22, // thrown from the hand as the seed leaves
    creepRate: 30, // beads off the seed while it runs across the floor
    igniteFlash: 0.3, // the screen flash as the flare lights
    igniteShake: 0.34,
    shakeDuration: 0.5,
    holdShake: 0.03, // the standing rumble
    rumble: 0.03, // ... and the one while the seed is running
    stainLife: 6.0, // the mark left on the floor
    stainIntensity: 0.55,

    lightIntensity: 16,
    lightRadius: 13,
    lightHeight: 0.85, // where the light sits, 0 the floor 1 the flare
    lightPulse: 0.4, // how much of it the pulse owns

    /* --- the palette --- */
    colorRune: '#c65cff',
    colorRuneCore: '#f4dcff',
    colorGlyph: '#e28cff',
    colorRuneWash: '#4d1a80',
    colorRuneFront: '#ffd8ff',

    colorGem: '#8347e6',
    colorGemDeep: '#341466',
    colorGemRim: '#c48cff',
    colorVein: '#ff2e8e',
    colorGemTip: '#f4e6ff',
    colorGemBase: '#110a1c',

    colorWater: '#1b1745',
    colorWaterDeep: '#09071f',
    colorWaterRim: '#a89cff',
    colorWaterCrest: '#ece8ff',
    colorDropA: '#c9c2ff',
    colorDropB: '#5b4fd6',
    colorDropC: '#221a5e',
    colorDropD: '#0b0826',

    colorMistA: '#4a2470',
    colorMistB: '#2a1146',
    colorMistC: '#150826',
    colorMistD: '#06020e',

    colorFlareCore: '#ffffff',
    colorFlareGlow: '#f1cbff',
    colorFlareHalo: '#a35cff',
    colorFlareStreak: '#dba8ff',

    colorBeadA: '#d05cf0',
    colorBeadB: '#7a2ad0',
    colorBeadC: '#2a0f55',
    colorBeadD: '#0e0420',
    colorGlintA: '#ffffff',
    colorGlintB: '#ff9cf0',
    colorGlintC: '#c050ff',
    colorGlintD: '#2a0a4a',

    colorBeamCore: '#ffffff',
    colorBeamInner: '#f2b0ff',
    colorBeamOuter: '#8a2ee6',
    colorBeamPulse: '#ff5ad8',

    colorBurstA: '#f2e0ff',
    colorBurstB: '#a45cff',
    colorBurstC: '#2c0f5c',
    colorScorch: '#1a0f2a',
    colorScorchEdge: '#8a3cd8',
    colorCastFlash: '#d8b0ff',
    colorFlash: '#f0d8ff',
    lightColor: '#b46cff'
  },

  /* ------------------------------------------------------------------ */
  /* Camera rig                                                          */
  /* ------------------------------------------------------------------ */
  camera: {
    // Opens fully zoomed out — this matches `maxDistance`, so the first frame
    // shows the whole arena and the wheel only ever pulls in from there.
    distance: 30,
    minDistance: 3.5,
    maxDistance: 30,
    zoomSpeed: 1.0,
    zoomDamping: 0.002,
    minPolar: 0.35,
    maxPolar: 1.32,
    fov: 46,
    targetHeight: 1.35,
    damping: 0.06,
    autoFrame: 0.35, // how strongly the rig drifts toward an active cast

    /*
     * Edge panning — how the view is steered while a cast is armed.
     *
     * The whole middle of the frame is dead: nothing moves until the aim cursor
     * (the hand, in camera mode) reaches the border, which is what keeps an
     * unsteady hand from dragging the camera around while it is trying to hold
     * an aim. Past the dead zone the speed ramps in with the *square* of how
     * far into the margin the cursor has gone, so the edge starts as a nudge
     * and only reaches `panSpeed` when the hand is right out at the rim.
     */
    panDeadZone: 0.7, // |ndc| below this never pans — the still centre
    panSpeed: 5.0, // metres/second at the very edge of the view
    panRange: 10.0, // furthest the view may be pushed from the caster, metres
    panRecenter: 0.35 // fraction of the offset still left 1s after disarming
  },

  /* ------------------------------------------------------------------ */
  /* Environment & lighting                                              */
  /* ------------------------------------------------------------------ */
  environment: {
    // A dark cinematic stage: one cool key, a colder rim from behind, and very
    // little fill, so the ice is the brightest thing on screen and the fog can
    // swallow the floor into the backdrop.
    sunIntensity: 2.6,
    sunColor: '#e8f3ff',
    sunAzimuth: 2.95,
    sunElevation: 0.6,
    ambientIntensity: 0.14,
    ambientColor: '#8ea8d8',
    hemiIntensity: 0.36,
    hemiSkyColor: '#bdd7ff',
    hemiGroundColor: '#3a4552',
    rimIntensity: 1.1,
    rimColor: '#9ec2ff',
    rimAzimuth: 5.45,
    rimElevation: 0.35,
    envIntensity: 0.32,
    backgroundColor: '#121820',
    // Fog is pulled well back so it only dissolves the far edge of the floor into
    // the backdrop rather than sitting on top of the action. Toggle and range are
    // both live in the editor (Environment → Backdrop, fog & dust).
    fogEnabled: true,
    fogColor: '#121820',
    fogNear: 26,
    fogFar: 135,
    shadowBias: -0.0008,
    shadowRadius: 2.2,
    floorColor: '#191f27',
    floorTint: '#232b35',
    floorRoughness: 0.88,
    floorSheen: 0.34,
    floorPool: 0.8,
    // The stone tiling that dresses the floor: ambientCG Rock030 (CC0), a rough
    // natural rock, living in public/textures/cathedral. `floorTextureScale` is metres of floor
    // one tile covers; `floorTexTint` grades the grey stone toward `floorTint` so
    // it sits inside the cool stage palette instead of fighting it.
    floorTexture: false,
    floorTextureScale: 12.0,
    floorNormalScale: 0.85,
    floorTexTint: 0.4,
    dustAmount: 0.85,
    contactShadow: 0.55
  },

  /* ------------------------------------------------------------------ */
  /* Duel hall (world/DuelHall.js)                                       */
  /* ------------------------------------------------------------------ */
  hall: {
    enabled: true, // off: back to the stone stage plane
    lightIntensity: 1.0, // the hall's warm point lights and violet underglow
    godRays: 1.0,
    runeGlow: 1.0,
    candleGlow: 1.0,
    carpetBrightness: 0.35, // velvet only — the gold embroidery keeps its value
    motion: 1.0 // speed of the candles, rune rings and orrery
  },

  /* ------------------------------------------------------------------ */
  /* Post processing                                                     */
  /* ------------------------------------------------------------------ */
  post: {
    enabled: true,
    exposure: 1.05,
    vignette: 0.52,
    chromaticAberration: 0.4,
    contrast: 1.12,
    saturation: 1.08,
    temperature: -0.03, // + warm / - cool
    lift: -0.008,
    gain: 1.0,
    grain: 0.045,
    // Master gain on the screen-space warp written by LAYER.DISTORTION — the
    // last link in the heat-haze chain. Screen widths, so it stays put when the
    // window resizes.
    distortion: 0.045,
    flashStrength: 1.0
  },
  frost: {
    /* --- the cast --- */
    range: 20.0, // max cast distance, metres
    minRange: 3.0,
    cooldown: 7.0,
    castAnim: 'cast2',
    zoneRadius: 3.2, // the prison's footprint, metres
    lifetime: 4.8, // seconds it stands
    fadeTime: 1.7, // seconds it takes to thaw

    /* --- the landing --- */
    landShake: 0.28,
    landLight: 60.0,
    landGlints: 220, // glints thrown up as the floor freezes
    landMotes: 160, // frost blown off the rim

    /* --- 1 · the ice cylinder --- */
    wallDelay: 0.12, // seconds after the floor freezes
    wallRiseTime: 0.97, // seconds it takes to stand
    wallHeight: 6.9, // metres
    wallOpacity: 0.71,
    wallBody: 0.33, // how solid the clear ice is
    wallTopFade: 0.1, // fraction of the height the top starts thinning at
    wallRimPower: 3.2, // fresnel
    wallRimGlow: 0.61, // cold light at the graze
    wallFrostScale: 1.93, // frost patches per metre
    wallFrost: 0.9, // how much of the wall is frosted
    wallStriaScale: 1.7, // vertical striations per metre
    wallFlow: 0.33, // m/s the caustic light climbs
    wallCaustic: 0.8,
    wallFootGlow: 1.3, // lit from the floor
    wallCracks: 0.74, // hairline cracks
    wallRefraction: 0, // how far the stage bends through it

    /* --- 2 · frost particles --- */
    glintRate: 70, // glints/s lifting inside the wall
    glintSize: 0.09,
    glintLife: 2.6,
    glintRise: 0.35, // m/s² of lift
    glintGlow: 2.0,
    moteRate: 45, // snow/s settling out of the air
    moteSize: 0.06,
    moteLife: 3.2,
    moteFall: -0.35, // m/s² (negative falls)

    /* --- 3 · ground ice --- */
    floorReach: 1.35, // × the footprint the hoarfrost feathers out to
    floorFreezeTime: 0.4, // seconds the front takes to reach the frost
    floorOpacity: 0.86, // the sheet
    floorFrost: 0.75, // the feathers beyond it
    floorFrostScale: 1.6, // feathers per metre
    crackScale: 1.1, // crack cells per metre
    crackWidth: 0.035, // metres
    crackGlow: 1.6, // lit from within
    crackDepth: 0.12, // metres under the surface the cracks sit
    spokes: 9, // radial cracks out of the centre
    footGlow: 1.2, // the ring where the wall stands
    floorSparkle: 1.0, // glitter in the frost
    floorPulse: 0.25, // breathing of the crack light

    /* --- 4 · cold air mist --- */
    // The same smoke the Corrupted Shard coils round its cluster: eroded
    // puffs, not a raymarched volume. Born at the foot of the wall, rolled
    // outward and coiling round the prison as they thin.
    mistRate: 44.0, // puffs per second while it stands
    mistDelay: 0.05,
    mistSize: 1.9,
    mistLifetime: 3.2,
    mistSpeed: 0.65, // m/s it rolls off the rim
    mistRise: -0.35, // m/s² (heavy air settles)
    mistSwirl: -1.4, // radians/second it coils round the wall
    mistSwirlExpand: 0, // how far out it drifts as it coils
    mistOpacity: 0.17,
    mistTurbulence: 0,
    mistBurst: 87, // the gout as the floor freezes

    /* --- 5 · rising shards --- */
    shardCount: 48, // splinters in the air at once
    shardDelay: 0.3, // seconds after the landing they start lifting
    shardSize: 0.16, // metres
    shardRise: 0.5, // m/s
    shardLife: 3.4, // seconds one is in the air
    shardSpin: 0.9, // rad/s
    crownCount: 30, // crystals at the foot of the wall
    crownDelay: 0.1,
    crownGrowTime: 0.5, // seconds they take to grow
    crownHeight: 0.85, // metres
    crownBase: 0.17, // base radius, metres
    crownRadius: 0.97, // × the footprint they stand at
    crownLean: 0.3, // radians outward
    crystalOpacity: 0.92,
    crystalScreenKey: 0.55, // how far the key is turned toward the camera
    crystalInclusions: 5.0, // frost inside the crystals, features per metre
    crystalRim: 0.8, // cold light at the graze

    /* --- 6 · ambient glow --- */
    glowRadius: 1.3, // × the footprint
    glowHeight: 0.9, // metres off the floor
    glowIntensity: 0.4,
    glowPulse: 0.2,
    glowPulseSpeed: 1.8,

    /* --- the frozen bodies --- */
    freezeReach: 1.0, // × the footprint a body has to stand inside
    freezeDelay: 0.1, // seconds after the landing the frost takes the first body
    freezeStagger: 0.2, // seconds more per footprint radius from the centre
    freezeTime: 0.55, // seconds the frost takes to climb a body
    holdTime: 1.1, // seconds it stands frozen
    crackTime: 0.45, // seconds the cracks take to run up it
    bodyCrackWidth: 0.02, // metres
    crackGlowBody: 3.0,
    shatterChunks: 30, // pieces it breaks into (of 48)
    shatterGap: 0.012, // metres opened between the pieces
    shatterSpeed: 3.0, // m/s the pieces leave at
    shatterLift: 3.2, // m/s upward
    shatterOut: 1.2, // share of the throw pointed out of the circle
    shatterSpin: 8.0, // rad/s the pieces tumble
    shatterGravity: -14.0,
    shatterBounce: 0.25,
    shatterFriction: 0.55,
    shatterChips: 160, // splinters thrown off the break
    chipSize: 0.07,
    shatterLight: 50.0,
    shatterShake: 0.16,
    meltDelay: 1.5, // seconds the pieces lie there
    meltTime: 1.3, // seconds they take to melt away
    meltVapour: 12, // puffs/s off the melting pieces
    bodyFrostScale: 9.0, // frost patches per metre on the ice
    iceRough: 0.08, // clear ice
    frostRough: 0.55, // frosted ice
    iceGlow: 0.5, // cold light in the ice
    iceRim: 1.0, // ...at the graze
    iceClearcoat: 0.7, // the glass coat
    iceEnv: 1.3, // the probe in it

    /* --- the ice --- */
    colorDeep: '#0d3b5e',
    colorIce: '#7cc6ee',
    colorFrost: '#eaf7ff',
    colorGlow: '#8fe3ff',
    colorMistA: '#f4faff', // the cold air, bright as it leaves the wall ...
    colorMistB: '#c9dff2',
    colorMistC: '#8fb6d9', // ... going to the blue of the ice ...
    colorMistD: '#3d6690', // ... and dark as it thins
    envStrength: 1.0, // the probe in every raw surface
    sunSpec: 1.2, // the sun highlight on every raw surface

    /* --- the light --- */
    lightColor: '#8fdcff',
    lightIntensity: 40.0,
    lightRadius: 16.0
  },
  toxic: {
    /* --- the cast --- */
    range: 20.0, // max cast distance, metres
    minRange: 3.0,
    cooldown: 8.0,
    castAnim: 'cast3',
    zoneRadius: 3.4, // the barrier's radius, metres
    lifetime: 5.5, // seconds it stands
    fadeTime: 1.6, // seconds it takes to break

    /* --- the landing --- */
    landShake: 0.32,
    landLight: 70.0,
    landSpores: 180, // spores thrown up as the floor breaks

    /* --- 1 · the crystalline barrier --- */
    domeDelay: 0.05, // seconds after the floor breaks
    domeRiseTime: 0.6, // seconds the facets take to all arrive
    domeSink: 0.45, // fraction of the radius the sphere sits under the floor
    domeSpin: 0.05, // rad/s the lattice turns
    domeOpacity: 0.9,
    domeBody: 0.1, // how solid the clear glass is
    domeRimPower: 2.6, // fresnel
    domeRimGlow: 0.55, // venom light at the graze
    sparCount: 24, // crystal spars in the lattice (of 28)
    sparWidth: 0.011, // their thickness, as a fraction of the radius
    sparSpeed: 2.5, // the light running along them
    sparGlow: 1.7,
    sparMinArc: 0.5, // radians a spar reaches either side of its middle
    sparMaxArc: 3.1,
    cellScale: 3.2, // facets per radius
    cellWidth: 0.03, // the facet seams
    cellGlow: 0.2,
    domeSwirl: 0.28, // the poison moving inside the glass
    domeSwirlScale: 2.2,
    domeSwirlSpeed: 0.12,
    domeFootGlow: 0.5, // lit from the rupture at its foot
    domeRefraction: 0, // how far the stage bends through it

    /* --- 2 · the poison gas miasma --- */
    // The same smoke the Corrupted Shard coils round its cluster: eroded
    // puffs, not a raymarched volume. Born under the foot of the barrier,
    // seeping outward and coiling round it as they thin.
    gasRate: 44.0, // puffs per second while it stands
    gasDelay: 0.05,
    gasRadius: 0.9, // × the radius the puffs are born at
    gasSize: 1.9,
    gasLifetime: 3.2,
    gasSpeed: 0.65, // m/s they seep outward
    gasRise: -0.35, // m/s² (heavy gas settles, like the prison mist)
    gasSwirl: -1.4, // radians/second it coils round the barrier
    gasSwirlExpand: 0, // how far out it drifts as it coils
    gasOpacity: 0.17,
    gasTurbulence: 0,
    gasBurst: 87, // the gout as the floor breaks
    sporeRate: 45, // spores/s drifting up inside the barrier
    sporeSize: 0.07,
    sporeLife: 2.8,
    sporeRise: 0.3, // m/s² of lift
    sporeGlow: 2.2,

    /* --- 3 · the ground rupture --- */
    plateReach: 1.0, // × the radius the plate is cut to
    plateCells: 48, // slabs the disc is cut into
    plateDepth: 0.12, // slab thickness, fraction of the radius
    plateRagged: 0.24, // how far the outline bites in
    plateBias: 0.5, // <0.5 makes the middle cells finer
    plateBreakTime: 0.32, // seconds the fracture takes to reach the rim
    plateGap: 0.06, // seam opening, fraction of a slab
    plateHeave: 0.075, // dome, fraction of the radius
    plateTilt: 0.24, // radians the middle slabs cant
    plateRumble: 0.01, // metres the slabs shiver as the shield breaks
    plateWallDark: 0.6,
    colorStain: '#0a1a0e', // the venom stain on the stone
    colorEmber: '#ff7a1a', // the fire still burning in the cracks
    seamGlow: 3.2, // the venom lighting the seams and walls
    crustCrackScale: 2.2, // the top-face fracture network, features per metre
    crustCrackWidth: 0.05,
    crustCrackGlow: 2.2,
    crustCrackReach: 0.9, // fraction of the radius it runs out to
    crustStain: 0.65,
    crustEmber: 1.0, // embers along the cracks
    crustEmberScale: 9.0, // embers per metre
    crustPulse: 0.3, // breathing of the seam light
    crustPulseSpeed: 2.0,
    emberRate: 26, // embers/s lifting off the cracks
    emberSize: 0.06,
    emberLife: 1.6,
    emberRise: 1.4, // m/s² of lift
    texScale: 2.6, // the stone scan
    texAmount: 1.0,
    normalScale: 1.3,
    stoneRough: 1.0,
    stoneRoughFloor: 0.34,
    stoneAO: 1.0,
    dustCoatSharp: 1.5,
    dustCoatScale: 1.2,
    stoneDesat: 0.3,
    stoneGrade: 0.7,
    colorStoneGrade: '#4f5350',
    colorStone: '#565a55',
    colorStoneDeep: '#1e211f',
    colorDustCoat: '#cfc6b3',

    /* --- 4 · the radial shockwave --- */
    ringReach: 1.9, // × the radius the landing ring runs out to
    ringTime: 0.9, // seconds it takes
    ringWidth: 0.028, // thickness, fraction of its reach
    ringSpikes: 28, // flares round it
    ringSpikeReach: 12, // how far the longest flare reaches, × the width
    ringIntensity: 1.4,
    pulsePeriod: 1.4, // seconds between the pulses while it stands (0 = none)
    pulseReach: 1.5, // × the radius a pulse runs out to
    pulseIntensity: 0.55,

    /* --- the bodies turned to glass --- */
    convertReach: 0.85, // × the radius a body has to stand inside
    convertDelay: 0.15, // seconds after the landing the first body is taken
    convertStagger: 0.25, // seconds more per radius from the centre
    convertTime: 0.75, // seconds the conversion takes to climb a body
    convertCellWise: 0.65, // 0 a waterline → 1 whole cells at a time
    convertLead: 0.35, // how far ahead of the front the seams light, of the body
    holdTime: 1.2, // seconds it stands as glass
    crackTime: 0.45, // seconds the cracks take to run up it
    bodyCrackWidth: 0.02, // metres
    crackGlowBody: 3.0,
    bodySeamWidth: 0.012, // the lattice on the body, metres
    bodySeamGlow: 2.6,
    bodySeamSet: 0.3, // how much of it stays lit once the glass has set
    bodySwirl: 0.35, // the poison moving inside the glass
    bodySwirlScale: 4.0,
    glassGlow: 0.55, // venom light in the glass
    glassRim: 1.0, // ...at the graze
    glassClearcoat: 0.85, // the glass coat
    glassRough: 0.08,
    glassEnv: 1.4, // the probe in it
    shatterChunks: 32, // pieces it breaks into (of 48)
    shatterGap: 0.012, // metres opened between the pieces
    shatterSpeed: 3.2, // m/s the pieces leave at
    shatterLift: 3.4, // m/s upward
    shatterOut: 1.1, // share of the throw pointed out of the circle
    shatterSpin: 8.0, // rad/s the pieces tumble
    shatterGravity: -14.0,
    shatterBounce: 0.28,
    shatterFriction: 0.55,
    shatterChips: 170, // splinters thrown off the break
    chipSize: 0.07,
    shatterLight: 55.0,
    shatterShake: 0.18,
    dissolveDelay: 1.4, // seconds the pieces lie there
    dissolveTime: 1.2, // seconds they take to go to vapour
    dissolveVapour: 12, // puffs/s off the dissolving pieces
    breakChips: 90, // glass/s thrown off the barrier as it breaks

    /* --- the glass --- */
    colorDeep: '#05281a',
    colorGlass: '#2ebf73',
    colorGlow: '#73ffb8',
    colorLattice: '#c7ffea',
    colorVenom: '#7a3db3',
    colorGasA: '#a8e89a', // the gas, green where the light gets it ...
    colorGasB: '#4fa85e',
    colorGasC: '#5a3a8e', // ... bruise purple in its own shadow ...
    colorGasD: '#1a0e30', // ... and dark as it thins
    envStrength: 1.0, // the probe in every raw surface
    sunSpec: 1.2, // the sun highlight on every raw surface

    /* --- the light --- */
    lightColor: '#5cff9e',
    lightIntensity: 45.0,
    lightRadius: 17.0
  }
};

/**
 * How an ability is aimed.
 *
 * `LINE` is the skillshot the sandbox started with: an arrow swung about the
 * caster, cast along its length. `ZONE` is the **far cast** — a circle with a
 * thick boundary dropped at the cursor, which answers the only question a
 * ground-targeted AoE has to answer before you commit: how much space is this
 * going to take. Both resolve to the same `cast(origin, direction, distance)`
 * event, so an ability never has to care which one aimed it; a zone ability
 * simply reads its target as `pointAt(1)` and works outward from there.
 */
export const CastShape = Object.freeze({
  LINE: 'line',
  ZONE: 'zone',
  /**
   * A **summon** — not aimed at all. Pressing the slot toggles a construct on
   * and off, and while it stands every other slot is locked. The aim
   * controller draws nothing for it; `App` routes the press to the construct.
   */
  SUMMON: 'summon'
});

/**
 * Ability ids, in slot order.
 *
 * `AbilityManager`, the HUD, the aim controller and the editor all key off this
 * array, and the index is the slot the keyboard binds to — adding a tenth
 * ability is a new file, an entry here and a settings block above.
 *
 * The letter in `ELEMENT_META[...].key` belongs to the ability and travels
 * with it when the roster is reordered; the digit alternative belongs to the
 * slot. `InputManager` maps both onto the index here, so moving an entry
 * means moving its `case` there too.
 */
export const ELEMENTS = [
  'flux',
  'voidslash',
  'glacial',
  'shard',
  'frost',
  'toxic',
  'phoenix',
  'monowheel',
  'drone',
  // Last, so every slot before it keeps the digit it always had.
  'shark',
  // Past the digits: a letter only.
  'chains',
  'dragon',
  'gyro',
  'amethyst',
  'tome',
  'reliquary'
];

/**
 * Registry metadata: how an ability is presented, and how it is aimed.
 *
 * `key` must match `InputManager`. `cast` is read by `AimController` to pick
 * between the arrow and the circle; omit it and the ability is a line cast.
 * `deck` is the badge the control deck wears while a summon is out.
 */
export const ELEMENT_META = {
  flux: {
    label: 'Shimmering Flux',
    accent: '#ff2b4e',
    key: 'Q',
    hint: 'Shimmering Flux of Chaos'
  },
  voidslash: {
    label: 'Void Slash',
    accent: '#a45cff',
    key: 'E',
    hint: 'Linear Void Slash — an obsidian lance with a wake of shadow'
  },
  glacial: {
    label: 'Glacial Shard Storm',
    accent: '#9fdcff',
    key: 'R',
    hint: 'Glacial Shard Storm — a crystal of ice with a wake of frost'
  },
  shard: {
    label: 'Corrupted Shard',
    accent: '#c65cff',
    key: 'X',
    hint: 'Corrupted Shard Spawn — a light that fires back',
    cast: CastShape.ZONE
  },
  frost: {
    label: 'Glacial Prison',
    accent: '#8fdcff',
    key: 'B',
    hint: 'Glacial Prison — freezes what stands in it, then shatters it',
    cast: CastShape.ZONE
  },
  toxic: {
    label: 'Toxic Shield',
    accent: '#73ffb8',
    key: 'Z',
    hint: 'Toxic Shield of Conquest — turns what stands in it to glass, then shatters it',
    cast: CastShape.ZONE
  },
  phoenix: {
    label: 'Serpent Tide Field',
    accent: '#ff8a22',
    key: 'F',
    hint: 'Serpent Tide Field — a phoenix that hunts',
    cast: CastShape.ZONE
  },
  monowheel: {
    label: 'Monowheel Bot',
    accent: '#e0c46a',
    key: 'V',
    hint: 'Monowheel Army Bot — toggle to deploy',
    cast: CastShape.SUMMON,
    deck: 'BOT'
  },
  drone: {
    label: 'Sentinel Drone',
    accent: '#ff5a3c',
    key: 'Y',
    hint: 'Sentinel Drone — toggle to deploy',
    cast: CastShape.SUMMON,
    deck: 'DRONE'
  },
  shark: {
    label: 'Abyssal Maw',
    accent: '#3fd8ff',
    key: 'K',
    hint: 'Abyssal Maw — a rock kicks the target up, a shark takes it under',
    cast: CastShape.ZONE,
    // The circle locks onto the body nearest the cursor: this cast takes one.
    snap: true
  },
  chains: {
    label: 'Chains of Penance',
    accent: '#ffb547',
    key: 'L',
    hint: 'Chains of Penance — chains from portals all round it tear the target apart',
    cast: CastShape.ZONE,
    snap: true
  },
  dragon: {
    label: 'Dragonfire Circle',
    accent: '#ff5a1f',
    key: 'I',
    hint: 'Dragonfire Circle — a dragon draws a ring of fire, and the fire takes everything inside it',
    cast: CastShape.ZONE
  },
  gyro: {
    label: 'Stormheart Gyroscope',
    accent: '#a77bff',
    key: 'O',
    hint: 'Stormheart Gyroscope — a gyroscope condenses over the circle and strikes everyone in it with lightning',
    cast: CastShape.ZONE
  },
  amethyst: {
    label: 'Amethyst Verdict',
    accent: '#c07bff',
    key: 'U',
    hint: 'Amethyst Verdict — amethyst points rise round the target and crush it',
    cast: CastShape.ZONE,
    snap: true
  },
  tome: {
    label: 'Astral Tome',
    accent: '#4f9dff',
    key: ';',
    hint: 'Astral Tome — a tome flies to the circle, opens an orrery over it, and its planets fall on everyone inside',
    cast: CastShape.ZONE
  },
  reliquary: {
    label: 'Wildroot Reliquary',
    accent: '#3fffd0',
    key: "'",
    hint: 'Wildroot Reliquary — roots arch over the target, hang it in a ring of runestones and drag it into the earth',
    cast: CastShape.ZONE,
    snap: true
  }
};

/** Whether the far-cast circle locks onto the body under the cursor. */
export function snapsToTarget(element) {
  return ELEMENT_META[element]?.snap === true;
}

/** How the given ability is aimed. Line unless its metadata says otherwise. */
export function castShapeOf(element) {
  return ELEMENT_META[element]?.cast ?? CastShape.LINE;
}

/** Whether the ability is a toggled construct rather than a cast. */
export function isSummon(element) {
  return castShapeOf(element) === CastShape.SUMMON;
}

/** The footprint a far cast will cover, metres. 0 for a line cast. */
export function zoneRadiusOf(element) {
  return castShapeOf(element) === CastShape.ZONE ? (settings[element]?.zoneRadius ?? 0) : 0;
}

/** Immutable snapshot used by "Reset to defaults" and the preset system. */
export const DEFAULT_SETTINGS = structuredClone(settings);

/**
 * Deep-merge a plain object into `settings` in place.
 * Existing object identity is preserved so every live binding keeps working.
 */
export function applySettings(patch, target = settings) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (target[key] && typeof target[key] === 'object') applySettings(value, target[key]);
    } else if (key in target) {
      target[key] = value;
    }
  }
  return target;
}

/** Restore every value to the shipped defaults (in place). */
export function resetSettings() {
  applySettings(structuredClone(DEFAULT_SETTINGS));
}

/** Serialisable clone of the current state. */
export function snapshotSettings() {
  return structuredClone(settings);
}
