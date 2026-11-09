// Limits the server enforces that the web composer and settings also check or show, from one source. Caps that exist
// only in the browser, such as how many drafts a tab keeps, stay with the UI.

/** Characters in one chat input. */
export const MAX_INPUT_CHARS = 100_000;
/** Uploads one chat input may attach. */
export const MAX_INPUT_ATTACHMENTS = 10;
/** Immutable releases the supervisor keeps; another needs a reviewed retention change first. */
export const MAX_RETAINED_RELEASES = 8;
/** Candidate check attempts whose logs are kept. */
export const MAX_CHECK_ATTEMPTS = 8;
