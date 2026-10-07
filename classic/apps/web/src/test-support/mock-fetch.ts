/** Include Bun's fetch.preconnect in test doubles without making network IO. */
export function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
    return Object.assign(implementation, { preconnect: (_url: string | URL, _options?: unknown): void => {} });
}
