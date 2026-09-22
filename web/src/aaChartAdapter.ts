import type { QuotaRow, Scope } from "./aaTypes";
import type { Point, Row, SiteData } from "./types";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const methodNames: Record<string, string> = { aa_original_api: "API AA", aa_tokens_quota_rates: "Квота × ставки", empirical_api_calibration: "API-калибровка", empirical_token_proxy: "Токенная оценка" };
export const aaMethodLabel = (value?: string) => value ? methodNames[value] || value : "Метод не указан";
export type EmpiricalMethod = "empirical_api_calibration" | "empirical_token_proxy";

/** Проверяем всю видимую выборку: разные модели не делают допущения совместимыми. */
export function hasMixedEmpiricalMethods(rows: readonly Pick<QuotaRow, "method">[]): boolean {
  return rows.some(row => row.method === "empirical_api_calibration")
    && rows.some(row => row.method === "empirical_token_proxy");
}

/** Быстрое сравнение сохраняет API и расчёты по квотам вместе с выбранной эмпирикой. */
export function methodsWithEmpiricalChoice(available: readonly string[], chosen: EmpiricalMethod): string[] {
  return available.filter(method => method === "aa_original_api" || method === "aa_tokens_quota_rates" || method === chosen);
}

/** Заимствуем только оформление и происхождение модели, а не цену смеси RAP. */
export function aaReferencePoint(row: QuotaRow, data: SiteData): Point | undefined {
  const exact = row.pricing_id && data.points.find(point => point.id === row.pricing_id);
  const sameModel = data.points.filter(point => point.model === row.model_id);
  const reference = exact || sameModel.find(point => row.kind === "api" ? point.billing === "metered" : point.plan_id === row.plan_id)
    || sameModel.find(point => point.billing === "metered") || sameModel[0];
  if (!reference) return undefined;
  const vendor = reference.vendor || vendorFor(row.model_id);
  const planReference = data.points.find(point => point.id === row.pricing_id || point.plan_id === row.plan_id);
  // Канал подписки другой строки не определяет происхождение исходного API AA.
  return { ...reference, vendor, channel: row.kind === "api" ? vendor : planReference?.channel || vendor };
}

function vendorFor(model: string): string {
  if (model.startsWith("gpt-")) return "OpenAI";
  if (model.startsWith("claude-")) return "Anthropic";
  if (model.startsWith("gemini-")) return "Google";
  if (model.startsWith("grok-")) return "xAI";
  if (model.startsWith("deepseek-")) return "DeepSeek";
  if (model.startsWith("mimo-")) return "Xiaomi";
  if (model.startsWith("glm-")) return "Zhipu";
  return "Unknown";
}

/** Поле цены транзитного Point используется только графиком и содержит $/задачу либо $/набор. */
export function adaptAAChart(rows: readonly QuotaRow[], scope: Scope, data: SiteData): {
  rows: Row[];
  sourceRows: Map<string, QuotaRow>;
} {
  const sourceRows = new Map<string, QuotaRow>();
  const chartRows: Row[] = [];
  for (const row of rows) {
    const id = `aa::${row.id}`;
    sourceRows.set(id, row);
    const cost = row[scope]?.cost_usd;
    if (!finite(cost) || cost < 0 || !finite(row.intelligence_index)) continue;
    const reference = aaReferencePoint(row, data);
    const vendor = reference?.vendor || vendorFor(row.model_id);
    const channel = reference?.channel || vendor;
    const point: Point = {
      id, plan_id: row.plan_id, plan: row.plan, model: row.model_id,
      model_display: [row.model, row.effort_label || row.effort].filter(Boolean).join(" · "), vendor, channel,
      label: `${row.model} · ${row.effort_label || row.effort} · ${row.plan}`,
      billing: row.kind === "api" ? "metered" : "subscription",
      confidence: row.confidence, price_usd: row.monthly_usd ?? null,
      original_price: row.monthly_usd ?? null, currency: "USD",
      monthly_yi: null, monthly_tokens: null,
      real_usd_per_mtok: cost, list_blended_usd_per_mtok: null,
      source: (row.sources || []).join("\n"), note: (row.notes || []).join("\n"), decision_note: "",
      evidence: (row.sources || []).map(url => ({ label: url, url })),
    };
    chartRows.push({
      key: id, point, score: row.intelligence_index,
      mapping: {
        point_id: id, configuration_id: `${id}::${scope}`, board: "aa_combined",
        variant: [row.effort_label || row.effort, `Метод: ${aaMethodLabel(row.method)}`].filter(Boolean).join(" · "), score: row.intelligence_index,
        score_is_estimated: row.estimated ?? false,
        agent_harness: "Artificial Analysis", reasoning_effort: row.effort_label || row.effort,
        service_mode: null, score_low: null, score_high: null,
        source: row.sources?.[0] || "https://artificialanalysis.ai/",
        mapping_kind: "aa_cost_profile", mapping_confidence: row.confidence,
        mapping_note: "Стоимость и индекс относятся к одному профилю модели и effort.",
        quota_effort_matched: null,
      },
    });
  }
  return { rows: chartRows, sourceRows };
}
