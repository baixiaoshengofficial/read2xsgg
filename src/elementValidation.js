const DATE_ONLY_METADATA = /^\s*\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*$/;

export function isDateOnlyMetadata(value) {
  return DATE_ONLY_METADATA.test(String(value || ""));
}
