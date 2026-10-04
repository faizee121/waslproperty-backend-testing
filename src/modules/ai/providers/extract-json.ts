/** Strips an optional ```json fenced block before parsing — both the
 * text interpreter (nsw-strata-plan/interpreter.ts) and the vision
 * fallback (nsw-strata-plan/vision-fallback.ts) ask a model for "ONLY a
 * JSON object" but some models wrap it in markdown anyway. */
export function extractJsonFromModelResponse(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
