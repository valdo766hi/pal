/** Bundled pets: pixel art drawn as data, with no code, network or model access of their own. */

/** Rows of one sprite layer: `.` is empty, every other character is an ink from the pet's colors. */
type Layer = readonly string[];
/** A blink pair (`open` most of the time, `shut` briefly) or two alternating frames (`a`, `b`); still without one. */
export type Motion = "open" | "shut" | "a" | "b";
type Part = readonly [Layer, Motion?];
/** What the pet does: sits while the owner is around, works while a run is active, rests, then naps. */
export type Pose = "sit" | "work" | "rest" | "nap";
export type Pet = {
  readonly name: string;
  readonly kind: string;
  readonly about: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly colors: Readonly<Record<string, string>>;
  /** `beat` is one a/b cycle in seconds. */
  readonly poses: Readonly<
    Record<Pose, { readonly label: string; readonly beat?: number; readonly parts: readonly Part[] }>
  >;
};

/** Rows drawn from row `top` down, so a small overlay needs no empty rows above it. */
const at = (top: number, ...rows: string[]): Layer => [...Array<string>(top).fill(""), ...rows];
/** The same layer drawn `rows` higher, for frames that hop; the layer must start with that many empty rows. */
const up = (layer: Layer, rows: number): Layer => layer.slice(rows);

// Abuy: the original grey tabby, sitting upright with a striped tail.
const ABUY_TAIL = at(
  7,
  "..............o",
  ".............oso",
  ".............obo",
  "............obo",
  "............obo",
  "............obo",
  "..........oobbo",
  ".........obboo",
);
const ABUY_HEAD: Layer = [
  ".o.........o",
  "obo.......obo",
  "obpo.....opbo",
  "obpbooooobpbo",
  "obbbbbbbbbbbo",
  "obbbsbsbsbbbo",
  "obbbbbsbbbbbo",
  "obbbbbbbbbbbo",
  "obbbbbbbbbbbo",
  "obcbbbbbbbcbo",
  ".obbbbbbbbbo",
];
const ABUY_BODY = at(11, "..oobbbbboo", "..obwwwwwbo", "..obwwwwwbo", "..owwbwbwwo");
const ABUY_MOUTH = at(9, "......p", ".....o.o");
const ABUY_OPEN = at(7, "...we...we", "...ee...ee");
const ABUY_SHUT = at(8, "...oo...oo");
const ABUY_LID = at(11, ".kkkkkkkkkkk", ".klllllllllk", ".kllllgllllk", ".klllllllllk");
const ABUY_TYPE_A = at(10, "..owwo", "..owwo..owwo");
const ABUY_TYPE_B = at(10, "......owwo", "..owwo..owwo");
const ABUY_HAPPY = at(7, "...oo...oo", "..o..o.o..o");
const ABUY_MUG = at(
  10,
  "...........kkkkk",
  "..........wknnnnk",
  "..........wkmmmk",
  "...........kmmmk",
  "...........kkkkk",
);
const ABUY_STEAM_A = at(5, "..............z", ".............z", "..............z", ".............z");
const ABUY_STEAM_B = at(5, ".............z", "..............z", ".............z", "..............z");
const ABUY_NAP = at(
  6,
  "..o...o",
  ".obo.obo",
  "obbbobbbooooo",
  "obbbbbbbobbbboo",
  "obbbbbbbbbbbbbbo",
  "obbbbbbbbbbbbbbo",
  "obbbbbbbbbbbbbbo",
  ".obbbbbbbbbbbbo",
  "..oooooooooooo",
);
const ABUY_NAP_FACE = at(8, "..p...p", "", ".........s.s", "..oo.oo...s.s", ".c..p..c", "..ww.ww.sssss");
const ABUY_Z = at(3, "...........zzz", "............z", "...........zzz");

// Oyen: a round orange loaf with tabby stripes and cream paws.
const OYEN_LOAF: Layer = [
  "...o.......o",
  "..obo.....obo",
  ".obbbooooobbbo",
  ".obbbbbbbbbbbo",
  ".obbbbbbbbbbbo",
  ".obbbbbbbbbbbo",
  ".obbbbbbbbbbbo",
  "obbbbbbbbbbbbbo",
  "obbbbbbbbbbbbbo",
  "obbbbbbbbbbbbbo",
  "obbbbbbbbbbbbbo",
  ".obbbbbbbbbbbo",
  "..ooooooooooo",
];
const OYEN_MARKS = at(
  2,
  "...p.......p",
  "......s.s",
  ".......s",
  "",
  "",
  ".s.c..w.w..c.s",
  ".s.....w.....s",
  "",
  "",
  "....ww...ww",
);
const OYEN_NOSE = at(7, ".......p", "......o.o");
const OYEN_OPEN = at(5, "....we...we", "....ee...ee");
const OYEN_SHUT = at(6, "....oo...oo");
const OYEN_YARN_A = at(
  8,
  "............oooo",
  "...........oyYyyo",
  ".........wwoyyYyo",
  "...........oYyyo",
  "............oooo",
);
const OYEN_YARN_B = at(
  8,
  "...........oooo",
  "..........oyyYyo",
  ".........wwYyyyo",
  "..........oyyYyo",
  "...........oooo",
);
const OYEN_HAPPY = at(5, "....oo...oo", "...o..o.o..o");
const OYEN_FISH_A = at(8, "..q..qqq", ".qFqqfffqq", "..qffffffeq", ".qFqqfffqq", "..q..qqq");
const OYEN_FISH_B = at(8, "...q.qqq", "..qFqfffqq", "..qffffffeq", "..qFqfffqq", "...q.qqq");
const OYEN_Z: Layer = [".............zzz", "..............z", ".............zzz"];

// Kuro: a slim black cat with yellow eyes, a red collar and a question-mark tail.
const KURO_TAIL = at(
  4,
  "..........o",
  ".........obo",
  "..........obo",
  "...........obo",
  "...........obo",
  "...........obo",
  "...........obo",
  "..........obo",
  "..........obo",
  ".........obo",
  "........obo",
  ".........o",
);
const KURO_BODY: Layer = [
  "o.........o",
  "oo.......oo",
  "obo.....obo",
  "obpo...opbo",
  "obpbooobpbo",
  "obbbbbbbbbo",
  "obbbbbbbbbo",
  "obbbbbbbbbo",
  "obbbbbbbbbo",
  ".obbbbbbbo",
  "..orrgrro",
  "..obbbbbo",
  "..obbbbbo",
  "..obbbbbo",
  "..obbbbbo",
  "..obobobo",
];
const KURO_NOSE = at(8, ".....p");
const KURO_OPEN = at(6, "..ew...ew", "..ee...ee");
const KURO_SHUT = at(7, "..hh...hh");
const KURO_PAW = at(7, ".........o", "........obo", ".......obbo", ".......obo", "........o");
const KURO_ORB_A = at(1, "...........V", "..........vVv", "...........v", "", "............V");
const KURO_ORB_B = at(1, "..........V.V", "...........v", "..........vVv", "...........v", "..........V");
const KURO_HAPPY = at(6, "..hh...hh", ".h..h.h..h");
const KURO_LICK = at(7, "..oo", ".obbo", ".obbp", "..oo");
const KURO_CURL = at(
  7,
  "..o...o",
  ".obo.obo",
  "obpbobpboooo",
  "obbbbbbbobbboo",
  "obhhbhhbbbbbbbo",
  "obbbpbbbbbbbbbo",
  "obhhhhhhhhhhhbo",
  ".obbbbbbbbbbbo",
  "..ooooooooooo",
);
const KURO_Z = at(4, "...........zzz", "............z", "...........zzz");

// Kalong: a round grey fruit bat with big ears, little fangs and black wings.
const KALONG_WINGS = at(
  3,
  ".o...........o",
  "odo.........odo",
  "oddo.......oddo",
  "odddo.....odddo",
  "odmddo...oddmdo",
  "odmmdo...odmmdo",
  "oddmdo...odmddo",
  "ododo.....ododo",
  ".o.o.......o.o",
);
const KALONG_BALL: Layer = [
  "..obo.....obo",
  "..obbo...obbo",
  "..obpbooobpbo",
  "..obpbbbbbpbo",
  "...obbbbbbbo",
  "...obbbbbbbo",
  "...obbbbbbbo",
  "...obbbbbbbo",
  "...obbfffbbo",
  "....obfffbo",
  ".....obfbo",
  "......ooo",
];
const KALONG_FACE = at(7, "....c..e..c", "......w.w");
const KALONG_OPEN = at(5, ".....we.we", ".....ee.ee");
const KALONG_SHUT = at(6, ".....oo.oo");
const KALONG_UP: Layer = [
  "odo.........odo",
  "oddo.......oddo",
  "odmdo.....odmdo",
  "oddmdo...odmddo",
  ".oddmdo.odmddo",
  ".oddddo.oddddo",
  "..ododo.ododo",
  "...o.o...o.o",
];
const KALONG_DOWN = at(
  5,
  "....oo...oo",
  "..ooddo.oddoo",
  ".oddddo.oddddo",
  "odmmddo.oddmmdo",
  "odmdddo.odddmdo",
  "odododo.odododo",
  ".o.o.o...o.o.o",
);
const KALONG_HAPPY = at(5, ".....o...o", "....o.o.o.o");
const KALONG_MANGO = at(8, "......QgQ", ".....QyyyQ", "....QyyyyMQ", ".....QyMMQ", "......QQQ");
const KALONG_WRAP = at(
  6,
  "....ooooooo",
  "...odddddddo",
  "..oddddmddddo",
  "..oddmdddmddo",
  "...odmdddmdo",
  "....ooooooo",
);
const KALONG_NAP_BLUSH = at(7, "....c.....c");
const KALONG_Z: Layer = ["......zzz", ".......z", "......zzz"];

// Jelok: a little pumpkin with a leafy stem; it has two spare rows on top for hopping.
const JELOK = at(
  4,
  "....ooooooo",
  "..oobbrbrbboo",
  ".obhbrbbbrbhbo",
  ".ohbrbbbbbrbho",
  "obhbrbbbbbrbhbo",
  "obbbrbbbbbrbbbo",
  "obbbrbbbbbrbbbo",
  "obbbrbbbbbrbbbo",
  "obbbrbbbbbrbbbo",
  ".obbrbbbbbrbbo",
  "..oorbbbbbroo",
  "....ooooooo",
);
const JELOK_STEM = at(2, "......ss.ll", ".......slll", ".......s");
const JELOK_FACE = at(11, "...c.......c", "......o.o", ".......o");
const JELOK_OPEN = at(9, "....we...we", "....ee...ee");
const JELOK_SHUT = at(10, "....oo...oo");
const JELOK_HAPPY = at(9, "....oo...oo", "...o..o.o..o");
const JELOK_HOP = up(JELOK, 2);
const JELOK_STEM_HOP = up(JELOK_STEM, 2);
const JELOK_FACE_HOP = up(JELOK_FACE, 2);
const JELOK_HAPPY_HOP = up(JELOK_HAPPY, 2);
const JELOK_SHADOW = at(15, "...zzzzzzzzz");
const JELOK_SHADES = at(8, "..kkkkkkkkkkk", "..kkwkk.kkwkk", "...kkk...kkk");
const JELOK_Z = at(2, ".zzz", "..z", ".zzz");

export const PETS = {
  abuy: {
    name: "Abuy",
    kind: "Grey tabby cat",
    about: "Codes on a laptop while Pal works and stops for coffee when it's quiet.",
    size: { width: 16, height: 15 },
    colors: {
      o: "#4f5668",
      b: "#b8c0d0",
      s: "#8e97ab",
      w: "#f4f6fa",
      e: "#1c2130",
      p: "#ff96ab",
      c: "#ffb3c2",
      z: "#a1a1aa",
      k: "#2c303b",
      l: "#6b7388",
      g: "#a9bdf2",
      m: "#f1e9dd",
      n: "#8a5a3c",
    },
    poses: {
      sit: {
        label: "Sitting",
        parts: [[ABUY_TAIL], [ABUY_HEAD], [ABUY_BODY], [ABUY_MOUTH], [ABUY_OPEN, "open"], [ABUY_SHUT, "shut"]],
      },
      work: {
        label: "On the laptop",
        beat: 0.5,
        parts: [
          [ABUY_TAIL],
          [ABUY_HEAD],
          [ABUY_BODY],
          [ABUY_MOUTH],
          [ABUY_OPEN, "open"],
          [ABUY_SHUT, "shut"],
          [ABUY_LID],
          [ABUY_TYPE_A, "a"],
          [ABUY_TYPE_B, "b"],
        ],
      },
      rest: {
        label: "Coffee break",
        beat: 1.6,
        parts: [
          [ABUY_HEAD],
          [ABUY_BODY],
          [ABUY_MOUTH],
          [ABUY_HAPPY],
          [ABUY_MUG],
          [ABUY_STEAM_A, "a"],
          [ABUY_STEAM_B, "b"],
        ],
      },
      nap: { label: "Napping", parts: [[ABUY_NAP], [ABUY_NAP_FACE], [ABUY_Z]] },
    },
  },
  oyen: {
    name: "Oyen",
    kind: "Orange cat",
    about: "A round loaf who plays with yarn while Pal works and sneaks a fish on breaks.",
    size: { width: 16, height: 13 },
    colors: {
      o: "#9a4a1c",
      b: "#f6a04d",
      s: "#d9772f",
      w: "#fff1dc",
      e: "#2a1c14",
      p: "#ff8fa3",
      c: "#ffb39a",
      z: "#a1a1aa",
      y: "#7f9ee8",
      Y: "#b7c9f5",
      f: "#b9d0dd",
      F: "#8fb0c4",
      q: "#4d6b80",
    },
    poses: {
      sit: {
        label: "Loafing",
        parts: [[OYEN_LOAF], [OYEN_MARKS], [OYEN_NOSE], [OYEN_OPEN, "open"], [OYEN_SHUT, "shut"]],
      },
      work: {
        label: "Playing with yarn",
        beat: 0.8,
        parts: [
          [OYEN_LOAF],
          [OYEN_MARKS],
          [OYEN_NOSE],
          [OYEN_OPEN, "open"],
          [OYEN_SHUT, "shut"],
          [OYEN_YARN_A, "a"],
          [OYEN_YARN_B, "b"],
        ],
      },
      rest: {
        label: "Fish snack",
        beat: 0.9,
        parts: [[OYEN_LOAF], [OYEN_MARKS], [OYEN_NOSE], [OYEN_HAPPY], [OYEN_FISH_A, "a"], [OYEN_FISH_B, "b"]],
      },
      nap: { label: "Napping", parts: [[OYEN_LOAF], [OYEN_MARKS], [OYEN_NOSE], [OYEN_SHUT], [OYEN_Z]] },
    },
  },
  kuro: {
    name: "Kuro",
    kind: "Black cat",
    about: "Slim and sharp-eyed. Conjures a little light while Pal works, grooms when it's quiet.",
    size: { width: 15, height: 16 },
    colors: {
      o: "#0e0f13",
      b: "#363944",
      h: "#6a6f80",
      p: "#e98aa0",
      e: "#ffd34d",
      w: "#ffffff",
      r: "#e04f63",
      g: "#ffd34d",
      v: "#c4b0ff",
      V: "#f4efff",
      z: "#a1a1aa",
    },
    poses: {
      sit: {
        label: "Sitting",
        parts: [[KURO_TAIL], [KURO_BODY], [KURO_NOSE], [KURO_OPEN, "open"], [KURO_SHUT, "shut"]],
      },
      work: {
        label: "Casting a spell",
        beat: 1,
        parts: [
          [KURO_TAIL],
          [KURO_BODY],
          [KURO_NOSE],
          [KURO_OPEN, "open"],
          [KURO_SHUT, "shut"],
          [KURO_PAW],
          [KURO_ORB_A, "a"],
          [KURO_ORB_B, "b"],
        ],
      },
      rest: { label: "Grooming", parts: [[KURO_TAIL], [KURO_BODY], [KURO_HAPPY], [KURO_LICK]] },
      nap: { label: "Curled up", parts: [[KURO_CURL], [KURO_Z]] },
    },
  },
  kalong: {
    name: "Kalong",
    kind: "Fruit bat",
    about: "Flaps along while Pal works and snacks on mango between runs.",
    size: { width: 15, height: 13 },
    colors: {
      o: "#0b0c0f",
      b: "#7c8190",
      f: "#a3a8b5",
      d: "#2c2e36",
      m: "#5d6170",
      e: "#121318",
      w: "#ffffff",
      p: "#e98aa0",
      c: "#f2a7b8",
      y: "#f6b73c",
      M: "#e2703a",
      Q: "#8a4b1c",
      g: "#6cbf6a",
      z: "#a1a1aa",
    },
    poses: {
      sit: {
        label: "Hanging out",
        parts: [[KALONG_WINGS], [KALONG_BALL], [KALONG_FACE], [KALONG_OPEN, "open"], [KALONG_SHUT, "shut"]],
      },
      work: {
        label: "Flying",
        beat: 0.5,
        parts: [
          [KALONG_UP, "a"],
          [KALONG_DOWN, "b"],
          [KALONG_BALL],
          [KALONG_FACE],
          [KALONG_OPEN, "open"],
          [KALONG_SHUT, "shut"],
        ],
      },
      rest: {
        label: "Mango snack",
        parts: [[KALONG_WINGS], [KALONG_BALL], [KALONG_FACE], [KALONG_HAPPY], [KALONG_MANGO]],
      },
      nap: {
        label: "Wrapped up",
        parts: [[KALONG_BALL], [KALONG_WRAP], [KALONG_SHUT], [KALONG_NAP_BLUSH], [KALONG_Z]],
      },
    },
  },
  jelok: {
    name: "Jelok",
    kind: "Pumpkin",
    about: "A little pumpkin. Hops while Pal works and puts on shades to rest.",
    size: { width: 15, height: 16 },
    colors: {
      o: "#8a3d12",
      b: "#f5913e",
      r: "#d9702a",
      h: "#ffc07a",
      s: "#4c7d34",
      l: "#7fbf5a",
      e: "#2a1a12",
      w: "#ffffff",
      c: "#ff9a8a",
      k: "#1d1d22",
      z: "#a1a1aa",
    },
    poses: {
      sit: {
        label: "Smiling",
        parts: [[JELOK], [JELOK_STEM], [JELOK_FACE], [JELOK_OPEN, "open"], [JELOK_SHUT, "shut"]],
      },
      work: {
        label: "Hopping",
        beat: 0.6,
        parts: [
          [JELOK, "a"],
          [JELOK_STEM, "a"],
          [JELOK_FACE, "a"],
          [JELOK_HAPPY, "a"],
          [JELOK_HOP, "b"],
          [JELOK_STEM_HOP, "b"],
          [JELOK_FACE_HOP, "b"],
          [JELOK_HAPPY_HOP, "b"],
          [JELOK_SHADOW, "b"],
        ],
      },
      rest: { label: "In shades", parts: [[JELOK], [JELOK_STEM], [JELOK_FACE], [JELOK_SHADES]] },
      nap: { label: "Dozing", parts: [[JELOK], [JELOK_STEM], [JELOK_FACE], [JELOK_SHUT], [JELOK_Z]] },
    },
  },
} as const satisfies Record<string, Pet>;

export type PetId = keyof typeof PETS;

/** One rectangle per run of same-ink pixels in a row, so a sprite stays a few dozen SVG nodes. */
export function pixels(layer: Layer): { x: number; y: number; width: number; ink: string }[] {
  return layer.flatMap((row, y) =>
    [...row.matchAll(/([^.])\1*/g)].map((run) => ({ x: run.index, y, width: run[0].length, ink: run[1] ?? "" })),
  );
}
