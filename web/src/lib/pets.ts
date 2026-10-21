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

// Abuy: the original grey tabby, sitting upright.
const ABUY_SIT: Layer = [
  "",
  ".s.......s",
  ".sp.....ps",
  ".bbbbbbbbb",
  ".bbbbbbbbb",
  ".bbbbbbbbb",
  ".bbbbpbbbb",
  "..bbbbbbb",
  "..bbwwwbb",
  ".bbbwwwbbb",
  ".bbbwwwbbb",
  ".bwbbbbbwb",
];
const ABUY_OPEN = at(5, "...e...e", "...e...e");
const ABUY_SHUT = at(6, "..ss...ss");
const ABUY_TAIL = at(9, "..........s", "..........bs", "..........bbbs");
const ABUY_SCREEN: Layer = [
  ".kkkkkkkkkkkkk",
  ".kqqqqqqqqqqqk",
  ".kqqqqqqqqqqqk",
  ".kqqqqqqqqqqqk",
  ".kqqqqqqqqqqqk",
  ".kkkkkkkkkkkkk",
  "lllllllllllllll",
];
const ABUY_CODE_A: Layer = ["", "...uuu.vvv", "....vvvv.u", "...u.uuuu", "...vv.uu"];
const ABUY_CODE_B: Layer = ["", "....vvvv.u", "...u.uuuu", "...vv.uuu", "....uuu"];
const ABUY_BACK = at(
  4,
  "....s.....s",
  "....bs...sb",
  "....bbbbbbb",
  "....bbbsbbb",
  "....bbbsbbb",
  "...bsbbbbbsb",
  "..bbbbsbsbbbb",
  "..bbbbbbbbbbb",
);
const ABUY_BACK_TAIL_A = at(11, ".............bs");
const ABUY_BACK_TAIL_B = at(10, "..............s", ".............b");
const ABUY_MUG = at(6, "..ss...ss", "...........mcm", ".........wwmmmn", "...........mmmn", "...........mmm");
const ABUY_STEAM_A = at(3, "............z", ".............z", "............z");
const ABUY_STEAM_B = at(4, ".............z", "............z", ".............z");
const ABUY_NAP = at(
  3,
  "............zzz",
  ".............z",
  ".s.......s..zzz",
  ".sp.....ps",
  ".bbbbbbbbbbb",
  ".bssbbbssbbbb",
  "bbbbbpbbbbbbbs",
  "bbwwwwwbbbbbbbs",
  ".bbbbbbbbbbbss",
);

// Oyen: a round orange loaf with tabby stripes and a cream muzzle.
const OYEN_LOAF: Layer = [
  "",
  ".bb.....bb",
  ".bpb...bpb",
  ".bbbsbsbbb",
  "bbbbbsbbbbb",
  "bbbbbbbbbbb.sbs",
  "bbbbbbbbbbbbsbbs",
  "bbbbbbbbbbsbbsbb",
  "bbbbwpwbbbbbbsbb",
  ".bbwewewbbbbbbbb",
  "..bwwwwwbbbbbbbb",
  "...wbbbwbbbbbbs",
];
const OYEN_OPEN = at(6, "..ie...ie", "..ee...ee");
const OYEN_SHUT = at(7, "..ss...ss");
const OYEN_YARN_A = at(8, "............yYy", "..........wyyYy", "...........yyyy", "............yy");
const OYEN_YARN_B = at(8, "............yyy", "...........yYyy", "..........wyyYy", "............yy");
const OYEN_BOWL = at(7, "..ss...ss", "", "", ".yyyyyyyyy", "..YyyyyyY");
const OYEN_BITE_A = at(9, "...k.kk");
const OYEN_BITE_B = at(9, "....kk.k");
const OYEN_NAP: Layer = ["............zzz", ".............z", "............zzz", "", "", "", "", "..ss...ss"];

// Kuro: a slim black cat with big yellow eyes, a red collar and a question-mark tail.
const KURO_SIT: Layer = [
  ".l.....l",
  ".bl...lb",
  ".bpb.bpb",
  "lbbbbbbbb",
  "lbbbbbbbb",
  "lbbbbbbbb",
  "lbbbpbbbb",
  ".lbbbbbb",
  "..rrgrr",
  "..lbbbb",
  "..lbbbb",
  ".lbbbbbb",
  ".lbbbbbb",
  ".ll.l.ll",
];
const KURO_OPEN = at(4, ".ee...ee", ".ei...ie");
const KURO_SHUT = at(5, ".ll...ll");
const KURO_TAIL = at(
  4,
  ".........ll",
  "...........l",
  "...........b",
  "...........b",
  "...........b",
  "..........b",
  ".........b",
  "........bb",
);
const KURO_PAW = at(7, "........l", "........bb", ".......bb");
const KURO_ORB_A: Layer = ["", ".........v", "........vVv.V", ".........v", "", "...........V"];
const KURO_ORB_B: Layer = ["", "............V", ".........v", "........vVv", ".........v", "..........V"];
const KURO_LICK = at(5, ".ll...ll", "lbbl", "lbbbp", ".lbb");
const KURO_CURL = at(
  3,
  "..........zzz",
  "...........z",
  "..........zzz",
  "",
  "......llll",
  ".l.l.lbbbbl",
  "lplbllbbbbbl",
  "lbbbbbbbbbbbl",
  "lbllbbbbbbbbl",
  "lbbbbblllllbl",
  ".lllllbbbbbl",
);

// Kalong: a fruit bat with a russet fox face, wrapped in dark wings.
const KALONG_FOLDED: Layer = [
  "",
  "....d.....d",
  "....bd...db",
  "....bbbbbbb",
  "...bbbbbbbbb",
  "...bbbnnnbbb",
  "....bbnpnbb",
  "..D...nnn...D",
  "..dd.bnnnb.dd",
  "..dddbnnnbddd",
  "..dddddnddddd",
  "...ddddddddd",
  "....b.....b",
];
const KALONG_OPEN = at(4, "....e...e");
const KALONG_SHUT = at(5, "....d...d");
const KALONG_BODY = at(
  3,
  ".....d....d",
  ".....bd..db",
  ".....bbbbbb",
  ".....bebbeb",
  ".....bbnnbb",
  "......npn",
  "......nnn",
  "......bbb",
  "......b.b",
);
const KALONG_UP: Layer = [
  "d..............d",
  "dd............dd",
  "ddd..........ddd",
  "dDdd........ddDd",
  ".dDdd......ddDd",
  ".ddDdd....ddDdd",
  "..d.ddd..ddd.d",
  ".....dd..dd",
];
const KALONG_DOWN = at(7, "....ddd..ddd", ".dDddd....ddddDd", "ddDdd......ddDdd", "d.dd........dd.d", "..d..........d");
const KALONG_MANGO = at(5, "....d...d", "", "", ".....mmmg", "....mmmmM", "....mmmMM");
const KALONG_BITE_A = at(8, ".....m");
const KALONG_NAP: Layer = ["............zzz", ".............z", "............zzz", "", "....D...D", "...DD...DD"];

// Jelok: a lantern pumpkin with a carved, glowing face.
const JELOK = at(
  2,
  ".......s.ll",
  "......ssll",
  "....oooooo",
  "..ohooroorooo",
  ".ohhoorooorooo",
  ".ohooroooorooo",
  ".ooooroooorooo",
  ".ooooroooorooo",
  ".ooooroooorooo",
  "..oooroooorooo",
  "....oooooooo",
);
const JELOK_FACE = at(6, "....g....g", "...ggg..ggg", "", "...g......g", "....gGgGgg", ".....g..g");
const JELOK_DIM = at(6, "....G....G", "...GGG..GGG", "", "...G......G", "....GGGGGG", ".....G..G");
const JELOK_SHADES = at(6, "..kkkkkkkkk", "...kkk..kkk", "", "....g....g", ".....gggg");
const JELOK_GLINT = at(6, "...w....w");
const JELOK_OUT: Layer = [
  "...........zzz",
  "............z",
  "...........zzz",
  "",
  "",
  "",
  "",
  "...ddd..ddd",
  "",
  "",
  "....dddddd",
];

export const PETS = {
  abuy: {
    name: "Abuy",
    kind: "Grey tabby cat",
    about: "Codes on a laptop while Pal works and stops for coffee when it's quiet.",
    size: { width: 15, height: 12 },
    colors: {
      b: "#aab3c5",
      s: "#6c768c",
      w: "#eef1f6",
      e: "#1a2236",
      p: "#ffb3c1",
      z: "#a1a1aa",
      k: "#3d4250",
      q: "#1c2130",
      l: "#7d8496",
      u: "#9db1e6",
      v: "#93bfa5",
      m: "#e9dfd0",
      n: "#c9bba6",
      c: "#7a5236",
    },
    poses: {
      sit: { label: "Sitting", parts: [[ABUY_SIT], [ABUY_TAIL], [ABUY_OPEN, "open"], [ABUY_SHUT, "shut"]] },
      work: {
        label: "On the laptop",
        beat: 1.2,
        parts: [
          [ABUY_SCREEN],
          [ABUY_CODE_A, "a"],
          [ABUY_CODE_B, "b"],
          [ABUY_BACK],
          [ABUY_BACK_TAIL_A, "a"],
          [ABUY_BACK_TAIL_B, "b"],
        ],
      },
      rest: {
        label: "Coffee break",
        beat: 1.6,
        parts: [[ABUY_SIT], [ABUY_MUG], [ABUY_STEAM_A, "a"], [ABUY_STEAM_B, "b"]],
      },
      nap: { label: "Napping", parts: [[ABUY_NAP]] },
    },
  },
  oyen: {
    name: "Oyen",
    kind: "Orange cat",
    about: "A round loaf who plays with yarn while Pal works and never misses a snack.",
    size: { width: 16, height: 12 },
    colors: {
      b: "#ef9a4a",
      s: "#c4672b",
      w: "#fde3c4",
      e: "#2b2118",
      p: "#ff8fa3",
      z: "#a1a1aa",
      i: "#fffaf2",
      k: "#9a5b2e",
      y: "#6f8fd6",
      Y: "#93aee8",
    },
    poses: {
      sit: { label: "Loafing", parts: [[OYEN_LOAF], [OYEN_OPEN, "open"], [OYEN_SHUT, "shut"]] },
      work: {
        label: "Playing with yarn",
        beat: 0.8,
        parts: [[OYEN_LOAF], [OYEN_OPEN], [OYEN_YARN_A, "a"], [OYEN_YARN_B, "b"]],
      },
      rest: {
        label: "Snack time",
        beat: 0.9,
        parts: [[OYEN_LOAF], [OYEN_BOWL], [OYEN_BITE_A, "a"], [OYEN_BITE_B, "b"]],
      },
      nap: { label: "Napping", parts: [[OYEN_LOAF], [OYEN_NAP]] },
    },
  },
  kuro: {
    name: "Kuro",
    kind: "Black cat",
    about: "Slim and sharp-eyed. Conjures a little light while Pal works, grooms when it's quiet.",
    size: { width: 13, height: 14 },
    colors: {
      b: "#33363f",
      l: "#5d6273",
      p: "#e58a9b",
      e: "#f5c542",
      i: "#1a1b20",
      r: "#d9485b",
      g: "#f5c542",
      v: "#b49cf0",
      V: "#efe7ff",
      z: "#a1a1aa",
    },
    poses: {
      sit: { label: "Sitting", parts: [[KURO_SIT], [KURO_TAIL], [KURO_OPEN, "open"], [KURO_SHUT, "shut"]] },
      work: {
        label: "Casting a spell",
        beat: 1,
        parts: [[KURO_SIT], [KURO_PAW], [KURO_OPEN], [KURO_ORB_A, "a"], [KURO_ORB_B, "b"]],
      },
      rest: { label: "Grooming", parts: [[KURO_SIT], [KURO_TAIL], [KURO_LICK]] },
      nap: { label: "Curled up", parts: [[KURO_CURL]] },
    },
  },
  kalong: {
    name: "Kalong",
    kind: "Fruit bat",
    about: "Flaps along while Pal works and snacks on mango between runs.",
    size: { width: 16, height: 13 },
    colors: {
      b: "#8b5a3c",
      n: "#c58f5f",
      d: "#3d2c26",
      D: "#64483a",
      e: "#140f0d",
      p: "#2a1e1a",
      m: "#f2b33d",
      M: "#e2703a",
      g: "#6aa84f",
      z: "#a1a1aa",
    },
    poses: {
      sit: { label: "Perched", parts: [[KALONG_FOLDED], [KALONG_OPEN, "open"], [KALONG_SHUT, "shut"]] },
      work: {
        label: "Flying",
        beat: 0.5,
        parts: [[KALONG_UP, "a"], [KALONG_DOWN, "b"], [KALONG_BODY]],
      },
      rest: { label: "Mango snack", beat: 1.2, parts: [[KALONG_FOLDED], [KALONG_MANGO], [KALONG_BITE_A, "a"]] },
      nap: { label: "Wrapped up", parts: [[KALONG_FOLDED], [KALONG_NAP]] },
    },
  },
  jelok: {
    name: "Jelok",
    kind: "Pumpkin",
    about: "A lantern pumpkin. Hops while Pal works and puts on shades to rest.",
    size: { width: 14, height: 13 },
    colors: {
      o: "#e8833a",
      r: "#b8571f",
      h: "#f6a35e",
      g: "#ffd36b",
      G: "#f2a541",
      s: "#4f7a35",
      l: "#79ad57",
      k: "#1d1d22",
      w: "#f4f4f5",
      d: "#5a2d14",
      z: "#a1a1aa",
    },
    poses: {
      sit: { label: "Glowing", parts: [[JELOK], [JELOK_FACE, "open"], [JELOK_DIM, "shut"]] },
      work: {
        label: "Hopping",
        beat: 0.6,
        parts: [
          [JELOK, "a"],
          [JELOK_FACE, "a"],
          [up(JELOK, 2), "b"],
          [up(JELOK_FACE, 2), "b"],
        ],
      },
      rest: { label: "In shades", parts: [[JELOK], [JELOK_SHADES], [JELOK_GLINT, "shut"]] },
      nap: { label: "Candle out", parts: [[JELOK], [JELOK_OUT]] },
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
