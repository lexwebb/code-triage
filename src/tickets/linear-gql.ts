import { recordLinearRequest, shouldLogLinearRequests } from "./stats.js";

const LINEAR_GQL_URL = "https://api.linear.app/graphql";

type GraphQLErrorShape = { message?: string };

export async function linearGraphQL<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  recordLinearRequest("graphql");
  const log = shouldLogLinearRequests();
  const t0 = log ? performance.now() : 0;
  const response = await fetch(LINEAR_GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Keep this raw (no "Bearer ") to match current Linear SDK usage in this project.
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query,
      variables: variables ?? {},
    }),
  });
  if (log) {
    const ms = Math.round(performance.now() - t0);
    console.error(`[linear-api] POST ${LINEAR_GQL_URL} → ${response.status} ${ms}ms`);
  }

  const rawText = await response.text();
  let payload: { data?: T; errors?: GraphQLErrorShape[] };
  try {
    payload = JSON.parse(rawText) as { data?: T; errors?: GraphQLErrorShape[] };
  } catch {
    throw new Error(
      `Linear GraphQL HTTP ${response.status} (non-JSON body): ${rawText.slice(0, 400)}`,
    );
  }

  const gqlMsg = payload.errors?.length
    ? payload.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ")
    : "";

  if (!response.ok) {
    throw new Error(
      gqlMsg
        ? `Linear GraphQL HTTP ${response.status}: ${gqlMsg}`
        : `Linear GraphQL HTTP ${response.status}: ${rawText.slice(0, 400)}`,
    );
  }
  if (payload.errors?.length) {
    throw new Error(gqlMsg);
  }
  if (typeof payload.data === "undefined") {
    throw new Error("Linear GraphQL returned no data");
  }

  return payload.data;
}
