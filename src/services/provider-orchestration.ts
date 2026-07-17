export interface ProviderFailure {
  readonly account: string;
  readonly message: string;
}

export interface PartialProviderResult<T> {
  readonly values: T[];
  readonly failures: ProviderFailure[];
}

/** Runs provider reads concurrently while preserving explicit partial-failure metadata. */
export async function collectProviderResults<C extends { readonly account: string }, T>(
  connectors: readonly C[],
  operation: (connector: C) => Promise<readonly T[]>,
  maxConcurrency = 4,
): Promise<PartialProviderResult<T>> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)
    throw new Error("maxConcurrency must be a positive integer");
  const settled: (PromiseSettledResult<readonly T[]> | undefined)[] = Array.from(
    { length: connectors.length },
    () => undefined,
  );
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < connectors.length) {
      const index = nextIndex++;
      const connector = connectors[index];
      if (!connector) continue;
      try {
        settled[index] = { status: "fulfilled", value: await operation(connector) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, connectors.length) }, async () => worker()),
  );
  const values: T[] = [];
  const failures: ProviderFailure[] = [];
  for (const [index, result] of settled.entries()) {
    const connector = connectors[index];
    if (!connector || !result) continue;
    if (result.status === "fulfilled") values.push(...result.value);
    else
      failures.push({
        account: connector.account,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
  }
  return { values, failures };
}

export function selectConnector<C extends { readonly account: string }>(
  connectors: readonly C[],
  account: string | undefined,
  predicate: (connector: C) => boolean = () => true,
): C | undefined {
  return account
    ? connectors.find((connector) => connector.account === account && predicate(connector))
    : connectors.find(predicate);
}
