export const componentKeys = ["non_cache_input", "cache_read", "cache_write", "answer", "reasoning"] as const;
export type ComponentKey = typeof componentKeys[number];
export type Components = Partial<Record<ComponentKey, number | null>>;
export type Scope = "task" | "suite";
export type MetricStatus = "consistent" | "approximate" | "missing" | "unavailable";

export interface EmpiricalBasis {
  basis_label: string;
  calibration?: {
    observed_api_usd: number;
    quota_fraction: number;
    periods_per_month: number;
    plan_multiplier: number;
    monthly_api_equivalent_usd: number;
    sample_components?: { label: string; tokens: number; rate_usd_per_million: number }[];
    extra_cost_usd?: number;
  };
  reason_ru: string;
}

export interface QuotaMetric {
  status?: MetricStatus;
  total_tokens?: number | null;
  component_tokens?: Components;
  component_quota?: Components;
  quota_per_unit?: number | null;
  cost_usd?: number | null;
  api_cost_usd?: number | null;
  effective_price_usd_per_million?: number | null;
  api_price_usd_per_million?: number | null;
  units_per_month?: number | null;
  units_per_100_usd?: number | null;
  cache_read_share?: number | null;
  non_cache_input_share?: number | null;
  cache_write_share?: number | null;
  input_without_cache_read_share?: number | null;
  output_share?: number | null;
  reported_total_tokens?: number | null;
  reported_output_tokens?: number | null;
  published_effective_price_usd_per_million?: number | null;
  output_relative_error_pct?: number | null;
  total_relative_error_pct?: number | null;
  notes?: string[];
}

export interface QuotaRow {
  id: string;
  model_id: string;
  model: string;
  effort: string;
  effort_label?: string;
  effort_level?: number;
  kind: "api" | "subscription";
  plan: string;
  plan_id: string;
  pricing_id?: string;
  confidence: "documented" | "assumed" | "source" | string;
  monthly_usd?: number | null;
  monthly_quota?: number | null;
  quota_unit?: string | null;
  component_rates?: Components;
  original_quota?: unknown;
  rate_basis?: unknown;
  shared_pool_note?: string | string[] | null;
  method?: string;
  evidence_method?: string;
  empirical?: EmpiricalBasis;
  status?: MetricStatus;
  notes?: string[];
  sources?: string[];
  task?: QuotaMetric;
  suite?: QuotaMetric;
  intelligence_index?: number | null;
  estimated?: boolean;
  source_id?: string;
}

export interface AATokenReconstruction {
  component_costs_usd?: Components;
  rates_usd_per_million?: Components;
  component_tokens?: Components;
}

export interface QuotaPlan {
  id?: string;
  model_id?: string;
  plan?: string;
  included?: boolean;
  status?: string;
  confidence?: string;
  monthly_usd?: number | null;
  monthly_quota?: number | null;
  quota_unit?: string | null;
  notes?: string[];
  reasons?: string[];
  sources?: string[];
}

export interface AACostData {
  metadata?: Record<string, unknown>;
  api_estimate?: { rows?: { source_id?: string; task?: AATokenReconstruction; suite?: AATokenReconstruction }[] };
  quota_scenario: {
    metadata?: {
      status?: string;
      notes?: string[];
      aa_version?: string;
      aa_retrieved_at?: string;
      pricing_retrieved_at_utc?: string;
      pricing_revision?: string;
      included_plans?: number;
      excluded_plans?: number;
      subscription_rows?: number;
      api_rows?: number;
      [key: string]: unknown;
    };
    rows: QuotaRow[];
    plans?: QuotaPlan[];
    excluded?: QuotaPlan[];
  };
}
