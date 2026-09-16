export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path = "",
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/workspace${path}`, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text || `Server returned ${response.status}`);
  }
  if (!response.ok)
    throw new ApiError(
      data.error || `Server returned ${response.status}`,
      response.status,
    );
  return data as T;
}
