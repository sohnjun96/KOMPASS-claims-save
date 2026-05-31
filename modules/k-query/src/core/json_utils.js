function tryParseJson(text) {
  return JSON.parse(text);
}

export function parseJsonFromText(text, label = "JSON") {
  if (typeof text !== "string") {
    throw new Error(`${label} parse error: response is not a string`);
  }

  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} parse error: empty response`);

  try {
    return tryParseJson(trimmed);
  } catch {
    // Continue to extraction attempts.
  }

  const fenced = trimmed.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);
  if (fenced) {
    try {
      return tryParseJson(fenced[1].trim());
    } catch {
      // Continue to extraction attempts.
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return tryParseJson(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue to array attempt.
    }
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try {
      return tryParseJson(trimmed.slice(firstBracket, lastBracket + 1));
    } catch {
      // Fall through.
    }
  }

  throw new Error(`${label} parse error: invalid JSON`);
}
