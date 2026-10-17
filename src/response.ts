export const MAX_RESPONSE_BYTES = 131072;

/** Include both legacy text and structured output in the wire-result budget. */
export function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string,unknown>,
  };
}

export function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(toolResult(value)),'utf8');
}
