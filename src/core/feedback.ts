export type ReviewFeedback = Readonly<{
  ids: readonly string[];
  scope: "normal" | "include-ignored";
}>;

export function commentFeedback(comment: {
  path: string;
  revision: string;
  line: number;
  lineText: string;
  body: string;
  outdated?: boolean;
}): string {
  return `${comment.path} (revision ${comment.revision.slice(0, 12)}), line ${comment.line}${comment.outdated ? " (outdated)" : ""}: ${comment.lineText.trim()}\n${comment.body}`;
}
