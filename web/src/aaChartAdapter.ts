import type { QualityLevel, QuotaRow, RowQuality, Scope } from "./aaTypes";
import type { Point, Row, SiteData } from "./types";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const methodNames: Record<string, string> = { aa_original_api: "API AA", aa_tokens_quota_rates: "Квота × ставки", empirical_api_calibration: "API-калибровка", empirical_api_scenario: "Приблизительный API-сценарий", empirical_model_transfer: "Перенос квоты между моделями", unavailable_quota_weights: "Нет ставок списания" };
export const aaMethodLabel = (value?: string) => value ? methodNames[value] || value : "Метод не указан";
export const aaTransferLabel = "Гипотеза переноса";
export const displayAAPlan = (plan: string): string => plan.replace(/9\/14\+/g, "с 14 сентября 2026");
const qualityNames: Record<QualityLevel, string> = { high: "Высокая", medium: "Средняя", low: "Низкая", unavailable: "Нет данных" };
export const aaQualityLabel = (level: string): string => qualityNames[level as QualityLevel] || qualityNames.unavailable;
export const aaQualityRank = (level: string): number => ["high", "medium", "low", "unavailable"].indexOf(level);

/** Старые срезы без quality остаются совместимыми, новые используют явную оценку backend. */
export function aaQuality(row: QuotaRow): RowQuality {
  const explicit = row.quality && Object.hasOwn(qualityNames, row.quality.level) ? row.quality : undefined;
  let level: QualityLevel;
  if (explicit) level = explicit.level;
  else if (row.method === "unavailable_quota_weights" || row.status === "unavailable" || row.confidence === "unavailable") level = "unavailable";
  else if (row.method === "empirical_api_scenario" || row.confidence === "low") level = "low";
  else if (["documented", "source", "high"].includes(row.confidence)) level = "high";
  else if (["assumed", "medium"].includes(row.confidence)) level = "medium";
  else level = "unavailable";
  const quality = explicit || { level, reasons: ["В старом срезе нет отдельной оценки надёжности; использована исходная метка confidence."] };
  if (row.method === "empirical_model_transfer") {
    const source = row.empirical?.transfer?.source_quality;
    const sourceLevel = source && Object.hasOwn(qualityNames, source.level) ? source.level : "unavailable";
    const limitedLevel = [quality.level, "medium", sourceLevel].sort((a, b) => aaQualityRank(b) - aaQualityRank(a))[0] as QualityLevel;
    if (limitedLevel !== quality.level) return { ...quality, level: limitedLevel, reasons: [...quality.reasons, "Надёжность переноса не выше средней и не выше надёжности исходной квоты.", ...(source?.reasons || [])] };
  }
  return quality;
}

export const aaIsApproximate = (row: QuotaRow, scope: Scope): boolean => finite(row[scope]?.cost_usd)
  && (row[scope]?.status === "approximate" || aaQuality(row).level === "low" || ["empirical_api_scenario", "empirical_model_transfer"].includes(row.method || ""));

/** Общие данные оформления для таблицы и графика; модель и источники всегда принадлежат строке AA. */
export function aaReferencePoint(row: QuotaRow, data: SiteData): Point {
  const exact = row.pricing_id && data.points.find(point => point.id === row.pricing_id);
  const sameModel = data.points.filter(point => point.model === row.model_id);
  const reference = exact || sameModel.find(point => row.kind === "api" ? point.billing === "metered" : point.plan_id === row.plan_id)
    || sameModel.find(point => point.billing === "metered") || sameModel[0];
  const vendor = reference?.vendor || vendorFor(row.model_id);
  const planReference = data.points.find(point => point.id === row.pricing_id || point.plan_id === row.plan_id);
  // Канал подписки другой строки не определяет происхождение исходного API AA.
  const channel = row.kind === "api" ? vendor : planReference?.channel || vendor;
  return {
    id: `aa::${row.id}`, plan_id: row.plan_id, plan: displayAAPlan(row.plan), model: row.model_id,
    model_display: [row.model, row.effort_label || row.effort].filter(Boolean).join(" · "), vendor, channel,
    label: `${row.model} · ${row.effort_label || row.effort} · ${displayAAPlan(row.plan)}`,
    billing: row.kind === "api" ? "metered" : "subscription", confidence: aaQuality(row).level,
    price_usd: row.monthly_usd ?? null, original_price: row.monthly_usd ?? null, currency: "USD",
    monthly_yi: null, monthly_tokens: null,
    // Для оформления цена не нужна; адаптер графика отдельно назначает стоимость выбранного профиля.
    real_usd_per_mtok: Number.NaN, list_blended_usd_per_mtok: null,
    source: (row.sources || []).join("\n"), note: [...(row.notes || []), ...aaQuality(row).reasons].join("\n"), decision_note: "",
    evidence: (row.sources || []).map(url => ({ label: url, url })),
  };
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
    if (row.method === "unavailable_quota_weights" || row[scope]?.status === "unavailable" || !finite(cost) || cost < 0 || !finite(row.intelligence_index)) continue;
    const reference = aaReferencePoint(row, data);
    const quality = aaQuality(row), prefix = aaIsApproximate(row, scope) ? "≈ " : "";
    const point: Point = {
      ...reference, model_display: prefix + reference.model_display, label: prefix + reference.label,
      real_usd_per_mtok: cost,
    };
    chartRows.push({
      key: id, point, score: row.intelligence_index,
      mapping: {
        point_id: id, configuration_id: `${id}::${scope}`, board: "aa_combined",
        variant: [row.effort_label || row.effort, `${prefix}Метод: ${aaMethodLabel(row.method)}`, row.method === "empirical_model_transfer" ? `🟡 ${aaTransferLabel}` : null, `Надёжность: ${aaQualityLabel(quality.level)}`].filter(Boolean).join(" · "), score: row.intelligence_index,
        score_is_estimated: row.estimated ?? false,
        agent_harness: "Artificial Analysis", reasoning_effort: row.effort_label || row.effort,
        service_mode: null, score_low: null, score_high: null,
        source: row.sources?.[0] || "https://artificialanalysis.ai/",
        mapping_kind: "aa_cost_profile", mapping_confidence: quality.level,
        mapping_note: "Стоимость и индекс относятся к одному профилю модели и effort.",
        quota_effort_matched: null,
      },
    });
  }
  return { rows: chartRows, sourceRows };
}
