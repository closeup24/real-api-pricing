import type { QualityLevel, QuotaRow, RowQuality, Scope } from "./aaTypes";

const levels: QualityLevel[] = ["high", "medium", "low", "unavailable"];
const rank = (level: QualityLevel) => levels.indexOf(level);
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export interface AAAssessment {
  category: string;
  score: number | null;
  color: string;
  description: string;
  reasons: string[];
}

export const aaAssessmentScaleNote = "Шкала 0–100 — условная редакционная оценка основания расчёта, а не вероятность, процент точности или доля успешных задач. Баллы назначаются по одной рубрике всем моделям; различия в несколько пунктов не являются измеренным преимуществом.";

const categories: Record<string, {name: string; description: string; base: number}> = {
  aa_original_api: {name: "Расходы API из AA", base: 95, description: "Опубликованная стоимость задачи или набора AA. Не требует восстановления подписочного лимита."},
  aa_tokens_quota_rates: {name: "Квота и ставки списания", base: 85, description: "Известная ёмкость в кредитах или других единицах и ставки по категориям применяются к профилю AA. Неофициальные условия и допущения снижают оценку."},
  empirical_api_calibration: {name: "Калибровка по замеру", base: 60, description: "Практический расход сопоставлен с долей лимита. Перенос на нагрузку AA предполагает, что лимит списывается пропорционально API-стоимости."},
  empirical_api_scenario: {name: "Приблизительный сценарий", base: 35, description: "Неполное наблюдение, смешанная нагрузка или сообщённый денежный пул дают условную оценку. Недостающие сведения заменены явно указанными допущениями."},
  empirical_model_transfer: {name: "Перенос между моделями", base: 55, description: "Денежная квота другой модели переносится на этот тариф. Используется собственный профиль AA новой модели; равенство квот ещё не измерено."},
};

/** Надёжность источника сохраняется отдельно от условного числового балла. */
export function aaQuality(row: QuotaRow): RowQuality {
  const explicit = row.quality && levels.includes(row.quality.level) ? row.quality : undefined;
  let level: QualityLevel;
  if (explicit) level = explicit.level;
  else if (row.method === "unavailable_quota_weights" || row.status === "unavailable" || row.confidence === "unavailable") level = "unavailable";
  else if (row.method === "empirical_api_scenario" || row.confidence === "low") level = "low";
  else if (["documented", "source", "high"].includes(row.confidence)) level = "high";
  else if (["assumed", "medium"].includes(row.confidence)) level = "medium";
  else level = "unavailable";
  const quality = explicit || {level, reasons: ["В старом срезе нет отдельной оценки надёжности; использована исходная метка confidence."]};
  if (row.method === "empirical_model_transfer") {
    const source = row.empirical?.transfer?.source_quality;
    const sourceLevel = source && levels.includes(source.level) ? source.level : "unavailable";
    const limited = [quality.level, "medium" as const, sourceLevel].sort((a, b) => rank(b) - rank(a))[0];
    if (limited !== quality.level) return {...quality, level: limited, reasons: unique([...quality.reasons, "Надёжность переноса не выше средней и не выше надёжности исходной квоты.", ...(source?.reasons || [])])};
  }
  return quality;
}

/** Приглушённый непрерывный градиент: красный 0, жёлтый 50, зелёный 100. */
export function aaAssessmentColor(score: number | null): string {
  return finite(score) ? `hsl(${Math.max(0, Math.min(100, score)) * 1.2} 32% 52%)` : "#858a91";
}

function basisScore(row: QuotaRow): {score: number | null; rules: string[]} {
  const category = Object.hasOwn(categories, row.method || "") ? categories[row.method!] : undefined;
  if (row.quality && !levels.includes(row.quality.level)) return {score: null, rules: ["Неизвестна категория надёжности исходных данных."]};
  const quality = aaQuality(row);
  if (!category || quality.level === "unavailable") return {score: null, rules: ["Недостаточно сведений о методе или надёжности основания."]};
  let score = category.base;
  const rules: string[] = [];
  if (row.method === "empirical_api_calibration") {
    const bases: Record<string, number> = {direct_measurement: 65, pooled_measurements: 70, calibrated_measurement: 60, plan_extrapolation: 45};
    if (!Object.hasOwn(bases, row.evidence_method || "")) return {score: null, rules: ["Тип практического основания не распознан."]};
    score = bases[row.evidence_method!];
    rules.push(`Основание калибровки: ${score}/100. Несколько замеров могут относиться к одному аккаунту; независимость этим не доказана.`);
  } else if (row.method === "empirical_api_scenario") {
    if (row.empirical?.calibration?.input_kind === "reported_monthly_pool" || row.evidence_method === "reported_quota") score = 30;
    rules.push(`Условный сценарий: ${score}/100; точность исходной ёмкости ограничена допущениями.`);
  } else if (row.method === "empirical_model_transfer") {
    const transfer = row.empirical?.transfer;
    if (!transfer || !["empirical_api_calibration", "empirical_api_scenario"].includes(transfer.source_method)) {
      return {score: null, rules: ["Неизвестно исходное основание переноса денежной квоты."]};
    }
    const source = basisScore({...row, method: transfer.source_method, quality: transfer.source_quality,
      evidence_method: transfer.source_evidence_method, empirical: transfer.source_empirical});
    if (source.score === null) return {score: null, rules: source.rules};
    score = Math.min(55, Math.max(0, source.score - 10));
    rules.push(`Исходное основание: ${source.score}/100. За непроверенный перенос между моделями снимается 10 пунктов; верхняя граница — 55/100. Это правило рубрики, а не измеренная погрешность.`);
  } else rules.push(`Базовая оценка метода: ${score}/100.`);
  const cap = {high: 95, medium: 70, low: 40}[quality.level];
  if (score > cap) rules.push(`Надёжность исходных данных ограничивает результат до ${cap}/100.`);
  return {score: Math.min(score, cap), rules};
}

export function aaAssessment(row: QuotaRow, scope: Scope = "task"): AAAssessment {
  const category = Object.hasOwn(categories, row.method || "") ? categories[row.method!] : undefined;
  const metric = row[scope];
  const quality = aaQuality(row);
  const basis = basisScore(row);
  let score = basis.score;
  const reasons = [...quality.reasons, ...basis.rules];
  if (!finite(metric?.cost_usd) || metric.cost_usd < 0 || ["missing", "unavailable"].includes(metric.status || "")) {
    score = null;
    reasons.push(`Для выбранного объёма работы (${scope === "task" ? "задача" : "полный набор"}) нет доступной цены.`);
  } else if (row.method === "aa_original_api" && metric.status === "approximate" && score !== null) {
    score = Math.min(score, 85);
    reasons.push("Стоимость API опубликована AA, но профиль помечен приближённым. Балл ограничен 85/100 из-за условий профиля и восстановления токенов; это не оценка вероятности ошибки в опубликованной сумме.");
  }
  return {
    category: category?.name || "Нет оценки", score, color: aaAssessmentColor(score),
    description: category?.description || "Расчёт не имеет достаточного основания. Отсутствие оценки показано серым и не приравнивается к нулевой стоимости.",
    reasons: unique([...reasons, ...(metric?.notes || [])]),
  };
}
