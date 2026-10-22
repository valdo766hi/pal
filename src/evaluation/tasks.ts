// Versioned evaluation tasks. Each names its frozen starting snapshot under test/fixtures/evaluation and the checks
// its independent grader runs; held-out tasks are never used while developing Pal's prompts or tools.
export type Continuation = {
  readonly prompt: string;
  readonly owner: boolean;
  /** Request compaction before this input; native history without an old prefix needs no summary request. */
  readonly compact?: boolean;
};
type Common = {
  readonly id: string;
  readonly version: number;
  readonly split: "development" | "held-out";
  readonly categories: readonly string[];
  /** Directory under test/fixtures/evaluation holding the starting repository. */
  readonly snapshot: string;
  readonly prompt: string;
  readonly continuations?: readonly Continuation[];
};
/** Graded by running the candidate's program on each case's JSON input. */
export type ProgramTask = Common & {
  readonly kind: "program";
  readonly entrypoint: string;
  readonly cases: readonly { readonly id: string; readonly input: unknown; readonly expected: unknown }[];
};
/** Graded by the candidate's answer file, with the listed paths required to stay byte-identical. */
export type AnswerTask = Common & {
  readonly kind: "answer";
  readonly answer: { readonly file: string; readonly expected: unknown };
  readonly unchanged: readonly string[];
};
export type Task = ProgramTask | AnswerTask;

export const checkout = {
  kind: "program",
  id: "checkout-rounding",
  version: 1,
  split: "development",
  categories: ["bug-fix", "multi-file"],
  snapshot: "buggy",
  entrypoint: "src/main.mjs",
  prompt:
    "Fix the checkout receipt's inconsistent rounding in src/prices.mjs and src/receipt.mjs. " +
    "Prices are nonnegative decimal strings with up to three decimal places; quantities are positive integers. " +
    "Round each unit price to cents, halfway up, before multiplying by quantity and summing. " +
    "Keep the CLI's JSON shape: {unitCents: number[], totalCents: number}. Run node test.mjs.",
  cases: [
    {
      id: "ordinary",
      input: [{ price: "12.34", quantity: 2 }],
      expected: { unitCents: [1234], totalCents: 2468 },
    },
    {
      id: "binary-rounding",
      input: [{ price: "1.005", quantity: 2 }],
      expected: { unitCents: [101], totalCents: 202 },
    },
    {
      id: "unit-before-quantity",
      input: [{ price: "0.105", quantity: 3 }],
      expected: { unitCents: [11], totalCents: 33 },
    },
    {
      id: "multiple-lines",
      input: [
        { price: "2.675", quantity: 3 },
        { price: "0.004", quantity: 100 },
        { price: "4", quantity: 1 },
      ],
      expected: { unitCents: [268, 0, 400], totalCents: 1204 },
    },
  ],
} as const satisfies ProgramTask;

export const inventory = {
  kind: "answer",
  id: "module-inventory",
  version: 1,
  split: "development",
  categories: ["repository-understanding"],
  snapshot: "inventory",
  prompt:
    "Do not change any existing file. Create inventory.json in the project folder containing " +
    '{"importers": [...]}: the sorted relative paths of every module under src/ that imports src/config.mjs ' +
    "directly or through other modules, excluding src/config.mjs itself.",
  answer: { file: "inventory.json", expected: { importers: ["src/api.mjs", "src/cli.mjs", "src/db.mjs"] } },
  unchanged: ["README.md", "src"],
} as const satisfies AnswerTask;

export const slug = {
  kind: "program",
  id: "slug-test-repair",
  version: 1,
  split: "held-out",
  categories: ["test-repair"],
  snapshot: "slug",
  entrypoint: "src/main.mjs",
  prompt:
    "node test.mjs fails. Fix src/slug.mjs, not the test: a slug is lowercase ASCII letters and digits in words " +
    "joined by single hyphens. Remove accents from letters, treat every other character as a separator, and " +
    "drop leading and trailing hyphens.",
  cases: [
    { id: "public", input: { text: "Crème Brûlée!" }, expected: "creme-brulee" },
    { id: "repeated-separators", input: { text: "  Multiple   spaces " }, expected: "multiple-spaces" },
    { id: "accents-and-dash", input: { text: "Ünïcödé — dash" }, expected: "unicode-dash" },
    { id: "already-slug", input: { text: "already-slugged-2" }, expected: "already-slugged-2" },
    { id: "no-words", input: { text: "!!!" }, expected: "" },
  ],
} as const satisfies ProgramTask;

export const continuedCheckout = {
  ...checkout,
  id: "checkout-owner-correction",
  categories: ["multi-file", "continuation", "owner-intervention"],
  continuations: [
    {
      prompt:
        "Owner correction: omit lines with cancelled: true from both arrays and totals. " +
        "Keep the earlier rounding and CLI requirements. Check the combined behavior before finishing.",
      owner: true,
    },
  ],
  cases: [
    ...checkout.cases,
    {
      id: "cancelled-between-rounded-lines",
      input: [
        { price: "1.005", quantity: 2 },
        { price: "20", quantity: 3, cancelled: true },
        { price: "0.105", quantity: 3 },
      ],
      expected: { unitCents: [101, 11], totalCents: 235 },
    },
    {
      id: "all-cancelled",
      input: [{ price: "2.675", quantity: 3, cancelled: true }],
      expected: { unitCents: [], totalCents: 0 },
    },
  ],
} as const satisfies ProgramTask;

export const checkpointCheckout = {
  ...continuedCheckout,
  id: "checkout-context-checkpoint",
  categories: [...continuedCheckout.categories, "compaction-checkpoint"],
  continuations: continuedCheckout.continuations.map((next) => ({ ...next, compact: true })),
} as const satisfies ProgramTask;

export const TASKS: readonly Task[] = [checkout, inventory, slug, continuedCheckout, checkpointCheckout];
