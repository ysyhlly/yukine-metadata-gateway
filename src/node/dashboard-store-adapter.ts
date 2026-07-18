import type {
  AdminRecord,
  NewSession,
  ProviderHealthSampleRow,
  ProviderMetricRow,
  RequestMetricRow,
  RuntimeSampleRow,
  SessionRecord,
  StoredRequestMetric,
  StoredProviderMetric,
  StoredUpstreamSummary,
  UpstreamMetricRow
} from "./dashboard-store.js";

export type Awaitable<T> = T | Promise<T>;

export interface DashboardStoreAdapter {
  hasAdmin(): Awaitable<boolean>;
  getAdmin(): Awaitable<AdminRecord | null>;
  createAdmin(username: string, passwordHash: string, now: number): Awaitable<boolean>;
  createSession(session: NewSession): Awaitable<void>;
  resolveSession(tokenHash: string, now: number): Awaitable<SessionRecord | null>;
  revokeSession(tokenHash: string, now: number): Awaitable<void>;
  writeMetrics(
    requests: RequestMetricRow[],
    upstream: UpstreamMetricRow[]
  ): Awaitable<void>;
  readRequestMetrics(since: number): Awaitable<StoredRequestMetric[]>;
  readUpstreamSummary(since: number): Awaitable<StoredUpstreamSummary[]>;
  writeProviderMetrics(rows: ProviderMetricRow[]): Awaitable<void>;
  readProviderMetrics(since: number): Awaitable<StoredProviderMetric[]>;
  writeRuntimeSamples(
    runtime: RuntimeSampleRow,
    providers: ProviderHealthSampleRow[]
  ): Awaitable<void>;
  readRuntimeSamples(since: number): Awaitable<RuntimeSampleRow[]>;
  readProviderHealth(since: number): Awaitable<ProviderHealthSampleRow[]>;
  cleanup(now: number): Awaitable<void>;
  close(): Awaitable<void>;
  ready?(): Awaitable<boolean>;
}
