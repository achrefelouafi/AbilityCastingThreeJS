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

/** Keyed by the ids in `ELEMENTS`. */
export const ELEMENT_SIGILS = {
  reliquary: RELIQUARY,
  tome: TOME,
  amethyst: AMETHYST,
  gyro: GYRO,
  dragon: DRAGON,
  chains: CHAINS,
  shark: SHARK
};
