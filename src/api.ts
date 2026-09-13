export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body.detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail
              .map((x) => `${x.loc?.slice(1).join(".")}: ${x.msg}`)
              .join("; ")
          : `Request failed (${response.status}).`,
    );
  }
  return response.json();
}
export const json = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
export async function streamChat(
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: Record<string, unknown>) => void,
) {
  const response = await fetch("/api/chat", { ...json(body), signal });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Check your question and advanced settings.",
    );
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    completed = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") completed = true;
    onEvent(event);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      lines.forEach(consume);
      if (done) {
        consume(buffer);
        break;
      }
    }
    if (!completed)
      throw new Error(
        "The connection ended before the answer completed. Please try again.",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
