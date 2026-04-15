import { recordLinearRequest } from "./stats.js";

const LINEAR_GQL_URL = "https://api.linear.app/graphql";

type GraphQLErrorShape = { message?: string };

export async function linearGraphQL<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  recordLinearRequest("graphql");
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

  const payload = (await response.json()) as {
    data?: T;
    errors?: GraphQLErrorShape[];
  };

  if (!response.ok) {
    throw new Error(`Linear GraphQL HTTP ${response.status}`);
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; "));
  }
  if (typeof payload.data === "undefined") {
    throw new Error("Linear GraphQL returned no data");
  }

  return payload.data;
}
