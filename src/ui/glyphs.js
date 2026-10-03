/**
 * Ability sigils for the HUD — drawn inline so they inherit `currentColor` (the
 * slot's `--accent`) and need no image assets.
 *
 * A 100×100 box, stroke only, so the mark reads the same at 34px in the ability
 * slot as it does scaled up.
 */

const WRAP = (body) =>
  `<svg class="glyph-svg" viewBox="0 0 100 100" aria-hidden="true" fill="none"
     stroke="currentColor" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * Shimmering Flux of Chaos — a funnel with ribbons streaming out of its point,
 * a drop of blood falling off it and two glints thrown clear.
 *
 * The one sigil in the set built around a *direction*: everything else here is
 * a thing standing still, and this ability is something going somewhere at
 * speed. So the mark reads corner to corner — the mouth of the conical trail
 * at the bottom left with a second ring inside it for the mesh, the two lines
 * of the cone converging on a point at the top right, and the ribbons carrying
 * on past that point and out of the box. The teardrop is the only mark that
 * says *blood* at 34px, and without it the slot could be any beam.
 */
const FLUX = WRAP(`
  <ellipse cx="26" cy="74" rx="17" ry="6" transform="rotate(47 26 74)"/>
  <ellipse cx="47" cy="55" rx="10" ry="3.6" transform="rotate(47 47 55)"/>
  <path d="M37 86L78 26"/>
  <path d="M15 62L78 26"/>
  <path d="M16 88C38 72 44 52 66 38C76 31 84 26 93 20"/>
  <path d="M31 91C45 71 62 63 72 45C78 34 82 26 88 12"/>
  <path d="M52 74C56 80 58 83 58 86A6 6 0 0 1 46 86C46 83 48 80 52 74Z"/>
  <path d="M84 42V52M79 47H89"/>
  <path d="M62 14V22M58 18H66"/>
`);

/** Keyed by the ids in `ELEMENTS`. */
/**
 * Drone — a hexacopter seen from above, inside its ring.
 *
 * The only sigil that is a *machine*: a body with six arms and a rotor disc
 * on each, framed by the range ring the ability draws on the floor. Nothing
 * else on the bar has straight spokes, which is what separates it at a glance
 * from the organic shapes around it.
 */
const DRONE = WRAP(`
  <circle cx="50" cy="50" r="44" stroke-dasharray="6 5"/>
  <circle cx="50" cy="50" r="9"/>
  <path d="M50 41V27M57.8 45.5L70 38.5M57.8 54.5L70 61.5M50 59V73M42.2 54.5L30 61.5M42.2 45.5L30 38.5"/>
  <circle cx="50" cy="22" r="6"/>
  <circle cx="74.5" cy="36" r="6"/>
  <circle cx="74.5" cy="64" r="6"/>
  <circle cx="50" cy="78" r="6"/>
  <circle cx="25.5" cy="64" r="6"/>
  <circle cx="25.5" cy="36" r="6"/>
`);

/**
 * Phoenix — the bird rising, wings up, over the ring it burns into the floor.
 *
 * A body-and-wings mark rather than a flame, because the fire is what every
 * other hot sigil on the bar already is; what this one has that they do not
 * is the bird. The ring under it is the field, drawn open at the front so
 * the wings read as standing *in* it rather than on it.
 */
const PHOENIX = WRAP(`
  <path d="M50 78V46"/>
  <path d="M50 46C46 34 38 28 30 26C36 32 40 36 41 42C34 38 26 38 20 42C30 44 38 48 43 54"/>
  <path d="M50 46C54 34 62 28 70 26C64 32 60 36 59 42C66 38 74 38 80 42C70 44 62 48 57 54"/>
  <path d="M50 46C48 40 50 34 52 30M50 30L55 27"/>
  <path d="M50 78C44 74 38 68 36 62M50 78C56 74 62 68 64 62"/>
  <path d="M26 66C20 70 16 76 18 84C26 88 38 90 50 90C62 90 74 88 82 84C84 76 80 70 74 66"/>
`);

/**
 * Monowheel — the bot side-on: a hull straddling one big wheel, the pair of
 * guns on its nose, inside its ring.
 *
 * The other machine on the bar. Where the drone is six discs seen from above,
 * this is one disc seen from the side with a body over it — the wheel is the
 * whole point of the thing, so the wheel is most of the sigil.
 */
const MONOWHEEL = WRAP(`
  <circle cx="50" cy="50" r="44" stroke-dasharray="6 5"/>
  <circle cx="50" cy="58" r="18"/>
  <circle cx="50" cy="58" r="5"/>
  <path d="M50 40V28M50 76V70M32 58H26M74 58H68"/>
  <path d="M33 44C34 32 42 26 50 26C58 26 66 32 67 44"/>
  <path d="M60 30L76 34M60 36L76 40"/>
  <circle cx="77" cy="34" r="2.5"/>
  <circle cx="77" cy="40" r="2.5"/>
`);

/**
 * Shard — a cluster of crystals standing in a circle you look into, with the
 * star blazing in the heart of them.
 *
 * A far cast built around an ellipse, and what separates it from the Void
 * Slash (the other violet on the bar) is the *light*: three faceted spires,
 * the middle one tallest, and a four-pointed star drawn over the place they
 * meet — which is the whole ability, a light source standing in a nest of
 * stone.
 */
const SHARD = WRAP(`
  <ellipse cx="50" cy="80" rx="36" ry="11"/>
  <path d="M50 78L42 40L50 12L58 40Z"/>
  <path d="M34 78L27 54L36 38L43 56"/>
  <path d="M66 78L73 54L64 38L57 56"/>
  <path d="M50 36V54M41 45H59"/>
  <path d="M44 39L56 51M56 39L44 51" stroke-width="2.6"/>
`);

/**
 * Glacial Prison — a body standing in a cylinder of ice.
 *
 * The far-cast ellipse every zone sigil stands on, and rising off it the two
 * walls of the tube, closed by a second ellipse at the top that is drawn
 * open: this is the one sigil that is a room. Inside it a figure — a head and
 * shoulders on a single stroke — with a crack running through it, and two
 * crystals growing at the foot of the wall: not a thing standing in the
 * circle but someone held in it.
 */
const FROST = WRAP(`
  <ellipse cx="50" cy="82" rx="34" ry="10"/>
  <path d="M16 82V26M84 82V26"/>
  <path d="M16 26C16 14 84 14 84 26"/>
  <path d="M16 26C16 38 84 38 84 26" stroke-dasharray="6 5"/>
  <circle cx="50" cy="44" r="7"/>
  <path d="M50 51V74M38 60L50 55L62 60"/>
  <path d="M44 62L50 68L47 74" stroke-width="2.6"/>
  <path d="M24 82L28 64L33 82M67 82L72 68L77 82"/>
`);

/**
 * Toxic Shield — a lattice dome standing on a broken floor.
 *
 * The far-cast ellipse every zone sigil stands on, and rising off it the
 * arc of the barrier: a dome, drawn as a shell rather than a room, with
 * three spars crossing over it — the lattice — and a bright node where two
 * of them meet. Under it the floor is broken: two cracks running out from
 * the middle to the rim. Where the Glacial Prison is someone held in a
 * room, this is a thing sealed under glass.
 */
const TOXIC = WRAP(`
  <ellipse cx="50" cy="82" rx="36" ry="10"/>
  <path d="M14 82C14 34 86 34 86 82"/>
  <path d="M22 60C40 52 62 50 80 62"/>
  <path d="M30 44C44 64 56 70 72 46"/>
  <path d="M38 38C50 54 50 72 48 82"/>
  <circle cx="50" cy="57" r="3.5" stroke-width="2.6"/>
  <path d="M50 82L36 88M50 82L64 90M50 82L54 74" stroke-width="2.6"/>
`);

/**
 * Void Slash — the composite read as one silhouette.
 *
 * A diagonal, like the other line casts: the lance is a dart with its point in the bottom-left corner,
 * two scales lifting off its rear, and the wake streaming up and to the right
 * out of it — two ribbons that cross once, a chip and a sliver of the glass
 * tumbling off the top, and one four-rayed spark. Its nose is a point.
 */
const VOIDSLASH = WRAP(`
  <path d="M10 90L42 58L50 66Z"/>
  <path d="M30 70L38 60M36 76L45 68"/>
  <path d="M46 62C58 58 56 42 70 36C82 30 84 22 90 12"/>
  <path d="M50 70C64 64 60 48 74 44C86 38 86 26 92 20"/>
  <path d="M72 24L78 18L82 26L75 30Z"/>
  <path d="M86 40L93 36L91 46Z"/>
  <path d="M60 22V32M55 27H65" stroke-width="2.6"/>
`);

/**
 * Glacial Shard Storm — the composite read as one silhouette.
 *
 * A diagonal like the other line casts, and the only one whose nose is a
 * gem: a faceted crystal with its point in the bottom-left corner and one
 * facet line across it, the vapour streaming up and to the right out of its
 * rear as two smooth strokes, one six-armed snowflake hanging in it and two
 * splinters thrown off the top. Where the Void Slash's nose is a dart, this
 * one is a cut stone.
 */
const GLACIAL = WRAP(`
  <path d="M10 90L24 60L44 54L52 66L36 82Z"/>
  <path d="M24 60L52 66"/>
  <path d="M46 58C58 52 62 40 76 34C84 30 88 22 92 12"/>
  <path d="M50 68C62 66 66 52 78 46C86 42 90 34 94 26"/>
  <path d="M68 62V78M61 70H75M63 65L73 75M73 65L63 75" stroke-width="2.6"/>
  <path d="M80 16L84 10L87 18L82 22Z"/>
  <path d="M60 30L66 24L67 32Z"/>
`);

/**
 * Abyssal Maw — the leap, portal to portal, over the rock.
 *
 * The one sigil that is a *journey between two places*: two rings of water on
 * the floor, the arc between them dashed so it reads as a path rather than a
 * shape, the shark at the top of it with its jaw open toward where it is
 * going, and the spike of rock standing under it — the kick that put the
 * target there.
 */
const SHARK = WRAP(`
  <ellipse cx="17" cy="82" rx="12" ry="4.5"/>
  <ellipse cx="83" cy="82" rx="12" ry="4.5"/>
  <path d="M17 77C22 52 34 40 44 36M60 36C70 40 78 52 83 77" stroke-dasharray="4 5"/>
  <path d="M28 40C38 30 56 28 72 34C66 38 58 41 48 42C40 43 33 42 28 40Z"/>
  <path d="M49 30L54 20L58 31"/>
  <path d="M28 40L20 32M28 40L21 47"/>
  <path d="M64 37L74 40L66 42"/>
  <path d="M43 90L50 62L57 90"/>
  <path d="M38 90L42 78M62 90L58 78"/>
`);

/**
 * Chains of Penance — a body spread on four chains, out to four portals.
 *
 * The one sigil that is *held*: a small figure in the middle with its arms
 * and legs pulled out to the corners, and at each corner a ring with a
 * second inside it — a portal — that its chain runs back into. The chains
 * are drawn as alternating dashes so they read as links, not as rope, and
 * the figure's limbs stop just short of where they meet it: the gap is the
 * tear, and at 34px it is what says this one takes things apart.
 */
const CHAINS = WRAP(`
  <circle cx="13" cy="13" r="8"/>
  <circle cx="13" cy="13" r="3.5"/>
  <circle cx="87" cy="13" r="8"/>
  <circle cx="87" cy="13" r="3.5"/>
  <circle cx="13" cy="87" r="8"/>
  <circle cx="13" cy="87" r="3.5"/>
  <circle cx="87" cy="87" r="8"/>
  <circle cx="87" cy="87" r="3.5"/>
  <path d="M19 19L34 34M81 19L66 34M19 81L36 64M81 81L64 64" stroke-dasharray="5 3.4"/>
  <circle cx="50" cy="36" r="6"/>
  <path d="M50 43V60"/>
  <path d="M46 46L39 39M54 46L61 39"/>
  <path d="M47 63L41 69M53 63L59 69"/>
`);

/**
 * Dragonfire Circle — the dragon over the ring it is burning.
 *
 * The one sigil that is drawn *in progress*: the ring on the floor is solid
 * and licked with flame for the part the breath has been round, and dashed
 * for the part it has still to go — which is the whole idea of the cast at
 * 34px. Over it the dragon, wings spread with the fingers of a bat, and the
 * breath running from its jaw down onto the leading end of the fire.
 */
const DRAGON = WRAP(`
  <path d="M18 74A36 12 0 0 0 82 74"/>
  <path d="M82 74A36 12 0 0 0 18 74" stroke-dasharray="4 6"/>
  <path d="M30 84L28 78M44 87L44 80M58 87L59 80M72 83L75 77" stroke-width="3"/>
  <path d="M50 22V48C50 54 54 58 60 58"/>
  <path d="M50 30C42 22 30 18 14 18C20 24 22 28 22 33C28 30 32 31 35 36C38 33 42 34 45 38"/>
  <path d="M50 30C58 22 70 18 86 18C80 24 78 28 78 33C72 30 68 31 65 36C62 33 58 34 55 38"/>
  <path d="M47 18L50 14L53 18"/>
  <path d="M53 22C62 34 74 48 82 70" stroke-dasharray="3 4" stroke-width="3"/>
`);

/**
 * Stormheart Gyroscope — three rings round a star, and a bolt out of it.
 *
 * The rings are drawn as one circle and two ellipses turned against each
 * other, which is what says *gyroscope* at 34px; the star in the middle is
 * the rune; and the bolt leaves it down to the right and forks, landing on
 * the floor line — the only mark in the set with a zigzag in it.
 */
const GYRO = WRAP(`
  <circle cx="44" cy="38" r="24"/>
  <ellipse cx="44" cy="38" rx="24" ry="9" transform="rotate(-25 44 38)"/>
  <ellipse cx="44" cy="38" rx="9" ry="24" transform="rotate(-25 44 38)"/>
  <path d="M44 31L46 36L51 38L46 40L44 45L42 40L37 38L42 36Z"/>
  <path d="M54 50L62 62L56 66L68 80L64 84L80 94" stroke-width="3.6"/>
  <path d="M62 72L54 80" stroke-width="2.6"/>
  <path d="M14 94H88" stroke-dasharray="4 5"/>
`);

/**
 * Amethyst Verdict — a circle with a socket at every point of it, and the
 * crystal in the middle they all come for.
 *
 * The six small circles on the rim are the whole idea, so they are drawn at
 * full weight; the crystal is a faceted point, a centre line for the ridge;
 * and two chevrons either side say *inward*.
 */
const AMETHYST = WRAP(`
  <circle cx="50" cy="52" r="36" stroke-width="2.6"/>
  <circle cx="50.0" cy="16.0" r="7"/>
  <circle cx="81.2" cy="34.0" r="7"/>
  <circle cx="81.2" cy="70.0" r="7"/>
  <circle cx="50.0" cy="88.0" r="7"/>
  <circle cx="18.8" cy="70.0" r="7"/>
  <circle cx="18.8" cy="34.0" r="7"/>
  <path d="M50 34L58 46L55 66L50 72L45 66L42 46Z"/>
  <path d="M50 34V72" stroke-width="2.4"/>
  <path d="M26 46L33 52L26 58M74 46L67 52L74 58" stroke-width="3"/>
`);

/**
 * Astral Tome — the book at the foot, its dial, the fan of light out of it,
 * and the star at the top with one orbit tilted across it and a planet on it.
 *
 * The book is drawn as a slab with its page block, so it reads as a book and
 * not a box; the two fan lines are what tie the sky to it.
 */
const TOME = WRAP(`
  <path d="M14 70L50 60L86 70L50 82Z"/>
  <path d="M14 70V78L50 90L86 78V70" stroke-width="3.4"/>
  <ellipse cx="50" cy="71" rx="10" ry="3.6" stroke-width="3"/>
  <path d="M44 68L36 34M56 68L64 34" stroke-width="2.6" stroke-dasharray="3 4"/>
  <circle cx="50" cy="28" r="7"/>
  <ellipse cx="50" cy="28" rx="34" ry="10" transform="rotate(-18 50 28)" stroke-width="2.8"/>
  <circle cx="81" cy="18" r="4" fill="currentColor" stroke="none"/>
  <path d="M22 12V18M19 15H25" stroke-width="2.6"/>
`);

/**
 * Wildroot Reliquary — two roots braided into an arch over a broken ring of
 * stone, a rune cube hanging in the middle, and a curl off one side.
 *
 * The arch is two strokes that cross at the top, which is the whole of the
 * braid at 34px; the ring is three heavy arcs with the bottom left open, the
 * way the slabs stand in the cast.
 */
const RELIQUARY = WRAP(`
  <path d="M18 92C14 62 18 30 44 16C58 9 72 14 76 30"/>
  <path d="M82 92C86 62 82 30 56 16C42 9 28 14 24 30"/>
  <path d="M32 66A20 20 0 0 1 34 40" stroke-width="6"/>
  <path d="M40 34A20 20 0 0 1 60 34" stroke-width="6"/>
  <path d="M66 40A20 20 0 0 1 68 66" stroke-width="6"/>
  <rect x="44" y="46" width="12" height="12" rx="1.5" transform="rotate(12 50 52)"/>
  <path d="M76 30C84 26 90 32 86 38C83 42 78 38 81 35" stroke-width="3"/>
  <path d="M10 92H90" stroke-width="3"/>
`);

export const ELEMENT_SIGILS = {
  reliquary: RELIQUARY,
  tome: TOME,
  amethyst: AMETHYST,
  gyro: GYRO,
  dragon: DRAGON,
  chains: CHAINS,
  shark: SHARK,
  flux: FLUX,
  glacial: GLACIAL,
  drone: DRONE,
  phoenix: PHOENIX,
  monowheel: MONOWHEEL,
  shard: SHARD,
  frost: FROST,
  toxic: TOXIC,
  voidslash: VOIDSLASH
};
