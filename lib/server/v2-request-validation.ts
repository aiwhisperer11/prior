import type { ErrorObject } from "ajv/dist/2020.js";

export function mapAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`);
}

export function duplicateSourceIdIssues(items: ReadonlyArray<{ source_id: string }>, fieldLabel: string): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.source_id)) issues.push(`${fieldLabel}: duplicate source_id "${item.source_id}" within a single payload`);
    seen.add(item.source_id);
  }
  return issues;
}
