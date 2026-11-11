export interface ForensicsConfig {
  /** Fetch wrapper that settles x402 402s, e.g. wrapFetchWithPayment(fetch, wallet) from x402-fetch. */
  payFetch?: typeof fetch;
  /** Credit key for the paid tiers, sent as X-Credit-Key. */
  creditKey?: string;
  /** Ask for the free daily trial call first (default true). */
  trial?: boolean;
}

export interface ForensicsChallenge {
  price_usd: number | null;
  network?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  x402Version?: number;
}

export interface RouteResult {
  status: number;
  ms: number;
  data: Record<string, unknown> | null;
  envelope: Record<string, unknown> | null;
  challenge: ForensicsChallenge | null;
}

export interface ElizaAction {
  name: string;
  similes: string[];
  description: string;
  examples: Array<Array<{ user: string; content: { text: string; action?: string } }>>;
  validate: (runtime: unknown, message: { content?: { text?: string } }, state?: unknown) => Promise<boolean>;
  handler: (
    runtime: unknown,
    message: { content?: { text?: string } },
    state?: unknown,
    options?: unknown,
    callback?: (response: { text: string; action?: string; content?: Record<string, unknown> }) => Promise<void>,
  ) => Promise<{ success: boolean; text: string; data: Record<string, unknown> }>;
}

export interface ElizaPlugin {
  name: string;
  description: string;
  actions: ElizaAction[];
  providers: Array<Record<string, unknown>>;
  evaluators: unknown[];
  services: unknown[];
}

export declare const SERVICE = "onchain-forensics";
export declare const CATALOG: string;
export declare function callRoute(
  routeKey: "verdict" | "settlesafe" | "mints" | "wallet",
  params?: Record<string, string | number | undefined>,
  opts?: ForensicsConfig,
): Promise<RouteResult>;
export declare function createForensicsPlugin(config?: ForensicsConfig): ElizaPlugin;
export declare const plugin: ElizaPlugin;
export default plugin;
