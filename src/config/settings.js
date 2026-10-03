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
  /* WOLF — Astral Fang                                                  */
  /* ================================================================== */
  /**
   * A **targeted** far cast, the Abyssal Maw's principle in starlight: a gold
   * compass rose writes itself under the target and a rift tears open in the
   * air beside it. The rose throws the body up on a shaft of light, a wolf
   * made of light bursts out of the rift, takes it at the top of the throw,
   * shakes it, and carries it into a second rift on the far side — and both
   * implode behind it.
   *
   * As with the shark, the pounce is solved from these numbers every frame —
   * the arc between the rifts, when the wolf has to leave for the jaw to
   * arrive with the body — so dragging any of them re-plans a cast in the
   * air. Times in **The timing** are seconds after the cast lands.
   */
  wolf: {
    /* --- the cast --- */
    range: 20.0,
    minRange: 0,
    speed: 70.0,
    cooldown: 6.0,
    castAnim: 'cast3',
    zoneRadius: 1.1,
    snapRadius: 2.4,
    showTime: 3.2, // seconds from landing until both rifts have shut
    fadeTime: 1.4, // seconds the sigils take to burn off the stone

    /* --- the timing --- */
    sigilTime: 0.4, // the rose writes itself
    riftDelay: 0.08, // the near rift starts to tear
    openTime: 0.42, // seconds a rift takes to iris open
    liftDelay: 0.5, // the rose throws the body up
    hangTime: 0.42, // seconds from the throw to the bite
    farRiftLead: 0.42, // the far rift opens this long before the bite
    closeDelay: 0.3, // after the last of it is through
    closeTime: 0.5, // seconds to implode

    /* --- 1 · the rifts --- */
    riftRadius: 1.4, // metres
    riftHeight: 1.45, // the middle of each, off the floor — they stand on it
    riftSpan: 6.0, // metres from the target to each rift
    riftFacing: 0.7, // how far each turns its face toward the caster
    riftSwirl: 1.4, // radians/second the vortex turns
    riftRim: 1.5,
    filaments: 1.0,
    nebula: 1.0,
    riftStars: 1.0,
    runeSpin: 0.04, // turns/second of the rune rings
    warp: 0.8, // refraction round the rim
    riftSigilRadius: 1.6, // the sigil on the floor under each rift
    riftShake: 0.28,
    riftLight: 16.0,
    riftLightRadius: 8.0,
    closeFlash: 0.04,

    /* --- 2 · the mark --- */
    sigilRadius: 2.5, // the rose under the target, metres
    sigilGlow: 1.0,
    column: 1.0, // the shaft of light the body is thrown up on
    columnRadius: 0.6,
    lift: {
      impulse: 0.3, // m/s along the cast
      lift: 5.0, // m/s up
      spin: 1.4
    },
    hangGrip: 0.08, // how hard the body is steered onto the jaw's path
    liftShake: 0.18,

    /* --- 3 · the wolf --- */
    length: 3.2, // metres, nose to tail — a dire wolf, not a dog
    biteHeight: 2.1, // metres off the floor the body is taken at
    runSpeed: 10.0, // m/s along the ground, and through the leap
    stride: 3.4, // metres a gallop stride covers — the feet plant when this is right
    gaitBlend: 0.08, // seconds the gallop and the pounce cross-fade over
    footHeight: 0.05, // metres the paw bones ride over the stone
    leapTime: 0.62, // seconds off the ground
    biteAt: 0.42, // how far through the leap the jaw closes
    arcPitch: 0.55, // how much it pitches along the leap (1 = nose along the arc)
    minArc: 9.0, // the least gravity the leap is solved with, m/s² — keeps it a leap
    runUp: 2.5, // metres it starts inside the near rift
    runOut: 3.0, // metres it carries on into the far one
    socketDepth: 0.05, // how far back into the mouth the body is held
    biteSnap: 0.06,
    grabJoint: 'Spine',
    carryDrop: 0.75, // metres under the jaw the hips are carried
    carryGrip: 0.14, // how hard, 0..1 per pass — a leash, so it still swings
    thrashRoll: 18, // degrees the body twists with the head-shake
    thrashRate: 2.6,
    thrashTime: 0.7,
    echoes: 3, // afterimages
    echoLag: 0.045, // seconds between them
    echoOpacity: 0.32,
    flareGlow: 1.0, // how hard it lights up coming through and biting

    /* --- 4 · the hologram --- */
    rim: 1.5,
    rimPower: 2.2,
    wire: 1.0, // its own quads, drawn as light
    wireWidth: 1.1, // pixels
    flow: 0.9, // bands of light running nose to tail
    flowSpeed: 1.6,
    flowBands: 3.5,
    innerStars: 1.0,
    furDetail: 0.55, // how much of its own pelt shows through
    fill: 1.0, // how solid the body reads
    scanlines: 0.12,
    seam: 2.6, // the white-hot cut where a rift crosses it
    seamWidth: 0.14, // metres
    halo: 0.9,
    haloWidth: 0.05, // metres
    haloPower: 2.0,

    /* --- 5 · the prey --- */
    stainTime: 0.45, // seconds the starlight takes to cover it
    preyRim: 2.4,
    preyEdge: 3.0,
    preySeam: 3.0,
    consumeDepth: 1.2, // metres past the far rift by which it is gone

    /* --- 6 · the hits --- */
    crossSparks: 140, // sparks off a rift's face as the wolf goes through
    footDust: 1.0, // star dust kicked up by each paw
    landShake: 0.22,
    trailRate: 160, // star dust per second off it in flight
    eyeTrail: 70, // sparks per second trailing from its eyes
    biteSparks: 150,
    biteShake: 0.42,
    biteLight: 50.0,
    biteFlash: 0.07,

    /* --- the palette --- */
    colorDeep: '#0a2a72',
    colorCore: '#2f7dff',
    colorRim: '#3fd2ff',
    colorWire: '#7febff',
    colorPrey: '#8fd0ff', // what the starlight turns the body
    colorStar: '#ffffff',
    colorHot: '#eafdff',
    colorVoid: '#05030f',
    colorNebula: '#6a35e0',
    colorNebulaHot: '#ff5adf',
    colorGold: '#ffc45e',
    colorReticle: '#6fe6ff',
    colorLocked: '#d6fbff',

    /* --- light --- */
    lightIntensity: 10.0,
    lightRadius: 9.0,
    lightColor: '#6fdcff'
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
   * ring draws itself behind the breath; the moment the ring closes it pulls
   * up off the lap and back into the tear, which shuts behind it; and the
   * fire runs **inward** from the ring until the whole disc is alight and
   * everything standing in it has burnt, erupts in the middle, and leaves
   * the floor charred and smoking.
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
    departTime: 2.0, // off the end of the lap and back up into the tear
    spreadDelay: 0.35, // after the ring closes, before the fire turns inward
    spreadTime: 3.2, // the fire's run from the ring to the middle

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
    idleWeight: 0.3, // how much of the authored idle runs under the flight
    flapRate: 1.2, // wing beats/second on the lap
    flapAmplitude: 0.42, // radians at the shoulder, on the lap
    climbRate: 1.28, // ...and pulling up into the tear, where it has to work
    climbAmplitude: 0.86,
    diveSweep: 0.75, // radians the wings fold back in the dive
    dihedral: 0.08, // radians the wings are held up
    bank: 0.7, // how hard it leans into a turn
    bob: 0.22, // metres the body lifts on each downstroke
    tailSway: 0.14, // radians
    neckCurl: 0.2, // radians the neck carries down in flight
    aimLimit: 1.5, // radians the neck will turn to point the mouth
    snarlJaw: 0.44, // radians the jaw drops, snarling out of the tear
    breathJaw: 0.5, // ...and to breathe
    inwardShake: 0.55, // when the fire turns inward
    inwardFlash: 0.06,
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
    barkBump: 0.1,
    moss: 0.22,
    lichen: 0.35,
    veinGlow: 1.0, // light in the crevices
    sapGlow: 1.0, // the sap pulses, once the runes are lit
    sapSpeed: 1.0,
    tipGlow: 5.0, // the growing tip
    barkRim: 0.35,
    barkEnv: 0.15, // how much of the hall the bark reflects
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
    saplingHeight: 1.1, // metres (0 for none)
    saplingRadius: 0.05,
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
  /* LANCE — Starbreaker Lance                                           */
  /* ================================================================== */
  /**
   * A **targeted shot**: the circle snaps onto the body under the cursor, and
   * a beam is fired into it from the caster's hands. A magic circle writes
   * itself under the caster while light is drawn in to the palms; the beam
   * leaves wound in streamers, lands in a star of sparks, blows the body off
   * its feet and stays on it, driving it along the line and burning it away
   * to light, then collapses into the mark from behind.
   *
   * Times in **The timing** are seconds; everything else is metres unless it
   * says otherwise. Everything is re-read every frame.
   */
  lance: {
    /* --- the cast --- */
    range: 22.0,
    minRange: 0,
    speed: 120.0, // the beam's head down the line, m/s
    cooldown: 5.0,
    castAnim: 'cast1',
    zoneRadius: 1.2, // the circle round the target, metres
    snapRadius: 2.4, // how far from the cursor a body is snapped onto, metres

    /* --- the timing --- */
    chargeTime: 0.42, // light drawn into the hands before the shot
    beamTime: 1.0, // seconds the beam stays on the body
    collapseTime: 0.35, // seconds it takes to be pulled into the mark
    fadeTime: 0.9, // seconds the circles take to go

    /* --- 1 · the hands --- */
    handHeight: 1.3, // metres, where the shot leaves if the rig will not say
    handForward: 0.5, // metres in front of the caster, the same
    handFollow: 0.65, // how much the beam follows the real hands, 0..1
    muzzle: 0.2, // metres it starts out in front of them
    handSize: 0.6, // radius of the star between the palms
    handIntensity: 0.7,
    handLight: 8.0,
    gatherRate: 60, // motes per second drawn in while charging
    handSigilSize: 0.7, // radius of the circle standing before the hands
    handSigilOffset: 0.35,
    handSigilIntensity: 0.6,

    /* --- 2 · the beam --- */
    coreRadius: 0.16,
    beamRadius: 0.42,
    glowRadius: 0.9,
    coreIntensity: 1.6,
    beamIntensity: 0.9,
    glowIntensity: 0.28,
    startTaper: 0.35, // its radius at the hands, × the full radius
    taperLength: 1.8, // metres it takes to open to full width
    impactBulge: 0.5, // how much it swells into the mark
    wobble: 0.03, // how much its skin boils
    streakFrequency: 0.55, // striations per metre
    streakSpeed: 34.0, // metres/second they race downrange
    pulse: 0.05,
    pulseSpeed: 22.0,
    aimHeight: 1.0, // metres, where on a standing body it lands
    trailRate: 30, // motes per second peeling off it
    arcRate: 5, // arcs per second crawling over it
    arcIntensity: 1.1,

    /* --- 3 · the streamers --- */
    ribbons: 4,
    ribbonRadius: 0.5,
    ribbonRadiusVariance: 0.45,
    ribbonTwist: 0.14, // turns per metre down the shot
    ribbonSpin: 5.0, // radians/second they wind
    ribbonWidth: 0.045,
    ribbonFlare: 1.0, // how wide they swirl round the caster, × radius
    ribbonFlareLength: 3.0, // metres it takes them to close in on the beam
    ribbonBehind: 1.6, // metres they reach back past the caster
    ribbonBulge: 0.8, // how wide they open into the blast
    ribbonIntensity: 0.75,

    /* --- 4 · the blast --- */
    novaSize: 2.4,
    novaIntensity: 1.0,
    burstSize: 2.4,
    impactSparks: 160,
    impactEmbers: 40,
    sprayRate: 120, // sparks per second off the mark while it holds
    emberRate: 30,
    impactShake: 0.3,
    impactFlash: 0.04,
    impactLight: 30.0,
    fireShake: 0.08,
    fireLight: 10.0,
    beamRumble: 0.035,
    hit: {
      impulse: 7.0,
      lift: 3.2,
      spin: 1.2
    },
    push: 9.0, // m/s² the beam drives the body along the line
    pushLift: 2.0,
    disintegrate: true, // the body burns away under the beam
    burnStart: 0.35, // fraction of the beam time before it starts to go
    burn: {
      color: '#0d1a33',
      rimColor: '#7fe6ff',
      rimEmissive: 4.0,
      edgeColor: '#e6f6ff',
      edgeEmissive: 9.0
    },

    /* --- 5 · the circle --- */
    sigilRadius: 2.6,
    sigilIntensity: 0.55,
    sigilSpin: 0.25,

    /* --- palette --- */
    colorCore: '#ffffff',
    colorBeam: '#7fe6ff',
    colorSheath: '#3d7dff',
    colorGlow: '#5a34ff',
    colorRibbonA: '#c46bff',
    colorRibbonB: '#5fd0ff',
    colorRibbonC: '#ff74d4',
    colorSparkA: '#ff9a4a',
    colorSparkB: '#ff6fd0',
    colorSparkC: '#7fd8ff',
    colorSigil: '#8fd4ff',
    colorSigilGold: '#e8c27a',

    /* --- light --- */
    lightIntensity: 7.0,
    lightRadius: 12.0,
    lightColor: '#8fc8ff'
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
    dustAmount: 0.85,
    contactShadow: 0.55
  },

  /* ------------------------------------------------------------------ */
  /* Duel hall (world/DuelHall.js)                                       */
  /* ------------------------------------------------------------------ */
  hall: {
    enabled: true, // off: back to the stone stage plane
    // The castle around the platform: walls, dome, windows, shelves, banners and
    // the orrery. Off, it burns away and leaves the platform and its candles
    // floating over the stone plane, which runs out into the fog — a quiet
    // backdrop for reading the abilities. Toggle with ` or the HUD switch.
    castle: false,
    castleFade: 2.4, // seconds for the castle to burn away / rebuild
    castleEdge: '#ff7a2e', // colour of the burning edge and its embers
    castleEmbers: 1.0,
    // Where the stone plane sits under the floating platform, metres. Below
    // the cloth's hem and clear of the top rune ring (at -3), so the platform
    // reads as a dais hovering over an open floor that runs out into the fog.
    groundDepth: -3.8,
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
  ZONE: 'zone'
});

/**
 * Ability ids, in slot order.
 *
 * `AbilityManager`, the HUD, the aim controller and the editor all key off this
 * array, and the index is the slot the keyboard binds to — adding an ability
 * is a new file, an entry here and a settings block above.
 *
 * The letter in `ELEMENT_META[...].key` belongs to the ability and travels
 * with it when the roster is reordered; the digit alternative belongs to the
 * slot. `InputManager` maps both onto the index here, so moving an entry
 * means moving its `case` there too.
 */
export const ELEMENTS = [
  'shark',
  'chains',
  'dragon',
  'gyro',
  'amethyst',
  'tome',
  'reliquary',
  'lance',
  'wolf'
];

/**
 * Registry metadata: how an ability is presented, and how it is aimed.
 *
 * `key` must match `InputManager`. `cast` is read by `AimController` to pick
 * between the arrow and the circle; omit it and the ability is a line cast.
 */
export const ELEMENT_META = {
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
  },
  lance: {
    label: 'Starbreaker Lance',
    accent: '#7fe6ff',
    key: 'Y',
    hint: 'Starbreaker Lance — a beam from your hands into one target, blasting it away and burning it to light',
    cast: CastShape.ZONE,
    snap: true
  },
  wolf: {
    label: 'Astral Fang',
    accent: '#5fe8ff',
    key: 'B',
    hint: 'Astral Fang — a wolf of starlight leaps out of a rift, takes the target and carries it into another',
    cast: CastShape.ZONE,
    // The circle locks onto the body nearest the cursor: this cast takes one.
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
