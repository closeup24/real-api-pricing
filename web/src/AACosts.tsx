import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, Calculator, CaretDown, CheckSquare, DownloadSimple, FunnelSimple, Info, MagnifyingGlass, SlidersHorizontal, X } from "@phosphor-icons/react";
import Chart from "./Chart";
import type { ChartHandle } from "./Chart";
import Modal from "./Modal";
import ResizeHandle from "./ResizeHandle";
import { BrandMarks } from "./ProviderLogo";
import { color, defaultState, groups, pareto } from "./domain";
import type { Lang, SiteData, State } from "./types";
import { aaMethodLabel as methodLabel, aaReferencePoint, adaptAAChart, hasMixedEmpiricalMethods, methodsWithEmpiricalChoice } from "./aaChartAdapter";
import type { EmpiricalMethod } from "./aaChartAdapter";
import { componentKeys } from "./aaTypes";
import type { AACostData, AATokenReconstruction, ComponentKey, QuotaMetric, QuotaPlan, QuotaRow, Scope } from "./aaTypes";

const componentNames: Record<ComponentKey, string> = {
  non_cache_input: "Вход без кэша", cache_read: "Чтение кэша", cache_write: "Запись кэша", answer: "Ответ", reasoning: "Reasoning",
};
const confidenceNames: Record<string, string> = { documented: "Документировано", assumed: "С допущениями", source: "Исходные данные API", unavailable: "Недоступно" };
const evidenceNames: Record<string, string> = { direct_measurement: "Прямой замер", plan_extrapolation: "Перенос с другого тарифа", pooled_measurements: "Несколько замеров", calibrated_measurement: "Замер с поправками", published_rates: "Опубликованные квоты и ставки", aa_original_api: "Исходные расходы AA", unknown: "Основание не указано" };
const evidenceKey = (row: QuotaRow) => row.evidence_method || (row.kind === "api" ? "aa_original_api" : row.method === "aa_tokens_quota_rates" ? "published_rates" : "unknown");
const evidenceLabel = (value: string) => evidenceNames[value] || value;
const statusNames: Record<string, string> = { consistent: "Согласовано", approximate: "Приближённая оценка", missing: "Нет данных AA", unavailable: "Расчёт недоступен" };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: unknown, exact = false): string => !finite(value) ? "—" : exact ? String(value) : new Intl.NumberFormat("ru-RU", {
  maximumSignificantDigits: 6, ...(value !== 0 && Math.abs(value) < .00001 ? { notation: "scientific" as const } : {}),
}).format(value);
const money = (value: unknown, exact = false) => finite(value) ? "$" + number(value, exact) : "—";
const percent = (value: unknown) => finite(value) ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value * 100) + "%" : "—";
const errorPercent = (value: unknown) => !finite(value) ? "—" : Math.abs(value) <= .000001 ? "0%" : number(value) + "%";
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : typeof value === "string" && value ? [value] : [];
const unique = <T,>(values: T[]) => [...new Set(values)];
const sourceUrl = (value: string) => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; } };
const hasCost = (metric?: QuotaMetric) => finite(metric?.cost_usd) && metric.cost_usd >= 0;
const effortLabel = (row: QuotaRow) => row.effort_label || row.effort || "Не указан";
const confidenceLabel = (value: string) => confidenceNames[value] || value || "Не указано";
const costLabel = (row: QuotaRow, scope: Scope) => (row[scope]?.status === "approximate" && hasCost(row[scope]) ? "≈ " : "") + money(row[scope]?.cost_usd);
const humanValue = (value: unknown) => typeof value === "string" ? value : value == null ? "—" : JSON.stringify(value, null, 2);

type FilterKey = "model" | "plan" | "effort" | "kind" | "confidence" | "method" | "evidence";
type Selections = Record<FilterKey, string[] | null>;
const allSelected = (): Selections => ({ model: null, plan: null, effort: null, kind: null, confidence: null, method: null, evidence: null });
const filters: { key: FilterKey; title: string; value: (row: QuotaRow) => string; label?: (value: string) => string }[] = [
  { key: "model", title: "Модели", value: row => row.model_id },
  { key: "plan", title: "Тарифы", value: row => row.plan_id || row.plan },
  { key: "effort", title: "Effort", value: row => row.effort || "Не указан" },
  { key: "kind", title: "Оплата", value: row => row.kind, label: value => value === "api" ? "API" : "Подписка" },
  { key: "method", title: "Метод расчёта", value: row => row.method || "unknown", label: methodLabel },
  { key: "evidence", title: "Основание данных", value: evidenceKey, label: evidenceLabel },
  { key: "confidence", title: "Достоверность оценки", value: row => row.confidence || "unknown", label: confidenceLabel },
];

function Sources({ urls }: { urls?: string[] }) {
  return <span className="aa-sources">{unique(texts(urls)).filter(url => sourceUrl(url)).map((url, index) => (
    <a key={url} href={sourceUrl(url)!} target="_blank" rel="noreferrer" title={url}>{new URL(url).hostname.replace(/^www\./, "")}{index ? ` · ${index + 1}` : ""} ↗</a>
  ))}</span>;
}

function Equation({ label, children }: { label: string; children: ReactNode }) {
  return <div className="aa-equation"><small>{label}</small><div>{children}</div></div>;
}

function TokenReconstruction({ estimate, metric, exact }: { estimate?: AATokenReconstruction; metric: QuotaMetric; exact: boolean }) {
  if (!estimate) return <p>Разбивка исходных расходов AA для восстановления токенов отсутствует. Ниже сохранены опубликованные результаты расчёта.</p>;
  const n = (value: unknown) => number(value, exact);
  return <div className="aa-token-reconstruction"><h4>Исходный профиль: расход AA ÷ API-ставка × 1 000 000</h4><p>Восстанавливаем пять категорий токенов AA по опубликованным расходам и API-ставкам. Дальнейший перенос на подписку зависит от выбранного метода оценки.</p><div className="aa-scroll"><table className="aa-calculation-table"><thead><tr><th>Категория</th><th>Расход AA, $</th><th>API-ставка, $/MTok</th><th>Восстановление токенов</th><th>Токены для расчёта</th></tr></thead><tbody>{componentKeys.map(key => <tr key={key}><th>{componentNames[key]}</th><td>{money(estimate.component_costs_usd?.[key], exact)}</td><td>{money(estimate.rates_usd_per_million?.[key], exact)}</td><td className="aa-operation">{n(estimate.component_costs_usd?.[key])} ÷ {n(estimate.rates_usd_per_million?.[key])} × 1 000 000</td><td>{n(metric.component_tokens?.[key])}</td></tr>)}</tbody></table></div><Equation label="Сумма пяти непересекающихся категорий">{componentKeys.map((key, index) => <span key={key}>{index ? " + " : ""}{n(metric.component_tokens?.[key])}</span>)} = <strong>{n(metric.total_tokens)} токенов</strong></Equation></div>;
}

function EmpiricalCalculation({ row, scope, exact }: { row: QuotaRow; scope: Scope; exact: boolean }) {
  if (!row.method?.startsWith("empirical_")) return null;
  const basis = row.empirical, calibration = basis?.calibration;
  const n = (value: unknown) => number(value, exact);
  const samples = calibration?.sample_components || [];
  const sum = samples.reduce((total, sample) => total + sample.tokens * sample.rate_usd_per_million / 1_000_000, 0) + (calibration?.extra_cost_usd || 0);
  const matches = calibration && Math.abs(sum - calibration.observed_api_usd) <= Math.max(1e-10, Math.abs(calibration.observed_api_usd) * 1e-8);
  return <div className="aa-empirical-basis">
    <h4>{methodLabel(row.method)} · {evidenceLabel(evidenceKey(row))}</h4>
    {basis?.basis_label && <p><strong>{basis.basis_label}</strong></p>}
    {basis?.reason_ru && <p>{basis.reason_ru}</p>}
    {row.method === "empirical_api_calibration" ? <>
      <p>По наблюдаемому расходу токенов восстанавливаем его API-эквивалент. Деление на израсходованную долю лимита даёт оценку ёмкости периода; затем переносим её на месяц и нужный тариф. Предполагаем, что подписка расходует лимит пропорционально API-стоимости. Это допущение о списании, а не опубликованное правило подписки.</p>
      {calibration ? <>
        {samples.length > 0 && <><div className="aa-scroll"><table className="aa-calculation-table"><thead><tr><th>Категория замера</th><th>Токены</th><th>API, $ / MTok</th><th>Операция</th><th>API-эквивалент, $</th></tr></thead><tbody>{samples.map((sample, index) => <tr key={`${sample.label}-${index}`}><th>{sample.label}</th><td>{n(sample.tokens)}</td><td>{money(sample.rate_usd_per_million, exact)}</td><td className="aa-operation">{n(sample.tokens)} × {n(sample.rate_usd_per_million)} ÷ 1 000 000</td><td>{money(sample.tokens * sample.rate_usd_per_million / 1_000_000, exact)}</td></tr>)}</tbody></table></div><Equation label="API-эквивалент исходного замера: сумма категорий и дополнительных расходов">{samples.map((sample, index) => <span key={index}>{index ? " + " : ""}{money(sample.tokens * sample.rate_usd_per_million / 1_000_000, exact)}</span>)}{finite(calibration.extra_cost_usd) && calibration.extra_cost_usd !== 0 && <> + {money(calibration.extra_cost_usd, exact)}</>} {matches ? "=" : "≈"} <strong>{money(calibration.observed_api_usd, exact)}</strong></Equation></>}
        <div className="aa-calculation-givens"><span>API-эквивалент замера: <b>{money(calibration.observed_api_usd, exact)}</b></span><span>Израсходовано лимита: <b>{percent(calibration.quota_fraction)}</b></span><span>Периодов в месяце: <b>{n(calibration.periods_per_month)}</b></span><span>Множитель тарифа: <b>{n(calibration.plan_multiplier)}</b></span></div>
        <Equation label="Оценка месячной ёмкости P = API-эквивалент замера ÷ доля лимита × периодов в месяце × множитель тарифа">{money(calibration.observed_api_usd, exact)} ÷ {n(calibration.quota_fraction)} × {n(calibration.periods_per_month)} × {n(calibration.plan_multiplier)} = <strong>{n(calibration.monthly_api_equivalent_usd)} USD API-экв. / мес.</strong></Equation>
        <p>Далее Q = P. Ставки в таблице ниже измеряют API-эквивалент профиля AA, а не подтверждённое списание подписочных кредитов.</p>
      </> : <p>Подробные исходные величины калибровки отсутствуют. Сохранённая оценка ёмкости и её источники приведены ниже.</p>}
    </> : <>
      <p>Используем месячную ёмкость в токенах, оценённую по замерам, как условный предел для другой смеси AA. Веса чтения кэша, записи, входа и выхода в подписочной квоте неизвестны. Поэтому перенос ёмкости между смесями и effort здесь является допущением.</p>
      <Equation label="Условная месячная ёмкость в миллионах токенов">{n(basis?.observed_monthly_tokens)} ÷ 1 000 000 = <strong>{n(row.monthly_quota)} MTok / мес.</strong></Equation>
      <Equation label="Прямая формула: месячная плата × токены AA ÷ месячная ёмкость по замерам">{money(row.monthly_usd, exact)} × {n(row[scope]?.total_tokens)} ÷ {n(basis?.observed_monthly_tokens)} = <strong>{money(row[scope]?.cost_usd, exact)} / {scope === "task" ? "задачу" : "набор"}</strong></Equation>
      <p>Единицы в колонке весов ниже означают, что миллион любых токенов считается одним MTok. Это условные равные веса для переноса замера, а не известные тарифы списания подписки.</p>
    </>}
  </div>;
}

function Calculation({ row, scope, exact, estimate }: { row: QuotaRow; scope: Scope; exact: boolean; estimate?: AATokenReconstruction }) {
  const metric = row[scope] ?? {};
  const n = (value: unknown) => number(value, exact);
  const unit = row.quota_unit || "ед. квоты";
  const empirical = row.method?.startsWith("empirical_") || false;
  const proxy = row.method === "empirical_token_proxy";
  const combinedNotes = unique([...texts(row.notes), ...texts(metric.notes), ...texts(row.shared_pool_note)]);
  if (row.kind === "api") return <div className="aa-calculation-body">
    <h3>{row.model} · {effortLabel(row)} · исходный API AA</h3>
    <p>Стоимость {scope === "task" ? "взвешенной задачи" : "полного набора"} взята из Artificial Analysis. Месячная квота к API не применяется.</p>
    <TokenReconstruction estimate={estimate} metric={metric} exact={exact} />
    <Equation label="API-цена миллиона токенов">{money(metric.cost_usd, exact)} ÷ {n(metric.total_tokens)} × 1 000 000 = <strong>{money(metric.api_price_usd_per_million, exact)} / MTok</strong></Equation>
    <Equation label="Нормированный объём на $100">$100 ÷ {money(metric.cost_usd, exact)} = <strong>{n(metric.units_per_100_usd)} {scope === "task" ? "задач" : "наборов"}</strong></Equation>
    {combinedNotes.length > 0 && <ul className="aa-notes">{combinedNotes.map(note => <li key={note}>{note}</li>)}</ul>}
    <Sources urls={row.sources} />
  </div>;
  return <div className="aa-calculation-body">
    <h3>{row.model} · {effortLabel(row)} · {row.plan}</h3>
    <p className="aa-comparison-note">Месячная плата — цена тарифа. Цена задачи — доля этой платы с учётом оценённого доступного объёма работы. Сравнивайте тарифы для одной модели, одного effort и одинакового метода расчёта: различие методов может выглядеть как выгода тарифа.</p>
    <div className="aa-calculation-givens"><span>Плата F: <b>{money(row.monthly_usd, exact)} / мес.</b></span><span>{empirical ? "Оценка ёмкости Q" : "Квота Q"}: <b>{n(row.monthly_quota)} {unit} / мес.</b></span><span>Метод: <b>{methodLabel(row.method)}</b></span><span>Основание: <b>{evidenceLabel(evidenceKey(row))}</b></span></div>
    <TokenReconstruction estimate={estimate} metric={metric} exact={exact} />
    <EmpiricalCalculation row={row} scope={scope} exact={exact} />
    <p>{proxy ? "Складываем пять непересекающихся категорий AA с условным равным весом. Единицы ниже не являются подтверждёнными ставками подписки." : empirical ? "Умножаем токены AA на API-ставки по категориям. Результат — оценка расхода API-эквивалентной ёмкости, предполагающая пропорциональное API-стоимости списание лимита." : "Берём пять непересекающихся категорий токенов AA. Для каждой умножаем количество токенов на ставку расхода квоты за миллион. Ставки уже включают применённые коэффициенты канала."}</p>
    <div className="aa-scroll"><table className="aa-calculation-table"><thead><tr><th>Категория</th><th>Токены AA</th><th>{proxy ? "Условный вес" : empirical ? "API-ставка" : "Ставка"}: {unit} / MTok</th><th>Операция</th><th>{proxy ? "Объём" : empirical ? "API-эквивалент" : "Списание"}, {unit}</th></tr></thead><tbody>
      {componentKeys.map(key => <tr key={key}><th>{componentNames[key]}</th><td>{n(metric.component_tokens?.[key])}</td><td>{n(row.component_rates?.[key])}</td><td className="aa-operation">{n(metric.component_tokens?.[key])} × {n(row.component_rates?.[key])} ÷ 1 000 000</td><td>{n(metric.component_quota?.[key])}</td></tr>)}
    </tbody></table></div>
    {!hasCost(metric) && <div className="aa-notice">Не хватает согласованных данных для этого профиля. Неизвестные значения не заменяются нулями.</div>}
    <Equation label={proxy ? "1. Складываем условный объём пяти категорий в MTok" : empirical ? "1. Складываем API-эквивалент пяти категорий" : "1. Складываем расход квоты по пяти категориям"}>{componentKeys.map((key, index) => <span key={key}>{index > 0 ? " + " : ""}{n(metric.component_quota?.[key])}</span>)} = <strong>{n(metric.quota_per_unit)} {unit}</strong></Equation>
    <Equation label="2. Выделяем долю месячной платы: F × расход профиля / Q">{money(row.monthly_usd, exact)} × {n(metric.quota_per_unit)} ÷ {n(row.monthly_quota)} = <strong>{money(metric.cost_usd, exact)} / {scope === "task" ? "задачу" : "набор"}</strong></Equation>
    <Equation label="3. Делим месячную ёмкость на расход одной единицы работы">{n(row.monthly_quota)} ÷ {n(metric.quota_per_unit)} = <strong>{n(metric.units_per_month)} {scope === "task" ? "задач" : "наборов"} / мес.</strong></Equation>
    <Equation label="4. Нормируем стоимость на $100">$100 ÷ {money(metric.cost_usd, exact)} = <strong>{n(metric.units_per_100_usd)} {scope === "task" ? "задач" : "наборов"} / $100</strong></Equation>
    <Equation label="5. Цена миллиона токенов на этом составе AA">{money(metric.cost_usd, exact)} ÷ {n(metric.total_tokens)} × 1 000 000 = <strong>{money(metric.effective_price_usd_per_million, exact)} / MTok</strong></Equation>
    <div className="aa-calculation-givens"><span>Всего токенов в расчёте: <b>{n(metric.total_tokens)}</b></span>{scope === "suite" && <span>Опубликованный AA total: <b>{n(metric.reported_total_tokens)}</b></span>}<span>Отклонение {scope === "suite" ? "total" : "output"}: <b>{errorPercent(scope === "suite" ? metric.total_relative_error_pct : metric.output_relative_error_pct)}</b></span></div>
    <p>Число токенов здесь — сумма восстановленных категорий. Для полного набора опубликованный AA total показан отдельно для сверки; его нельзя незаметно подставлять вместо суммы при расчёте расхода.</p>
    {row.original_quota != null && <details className="aa-source-detail"><summary>Исходные данные ёмкости и основание весов</summary><pre>{humanValue(row.original_quota)}</pre>{row.rate_basis != null && <pre>{humanValue(row.rate_basis)}</pre>}</details>}
    <h4>Допущения и источники</h4>
    <ul className="aa-notes"><li>Плата распределена на полностью использованную месячную ёмкость, только на эту модель и профиль AA. Для оценок по замерам сама ёмкость и её перенос на профиль AA являются допущениями. Общая квота, временные ограничения и доступность effort могут уменьшить объём.</li><li>«На $100» — нормировка, а не покупка части тарифа. Оплаченная попытка не означает успешно решённую задачу.</li>{combinedNotes.map(note => <li key={note}>{note}</li>)}</ul>
    <Sources urls={row.sources} />
  </div>;
}

function ExcludedPlans({ plans }: { plans: QuotaPlan[] }) {
  return <details className="aa-excluded"><summary>Исключённые тарифы и причины <span>{plans.length}</span></summary>
    {plans.length ? <div className="aa-scroll"><table className="aa-data-table"><thead><tr><th>Модель / тариф</th><th>Причина</th><th>Источники</th></tr></thead><tbody>{plans.map((plan, index) => <tr key={plan.id || index}><td><b>{plan.model_id}</b><small>{plan.plan}</small></td><td className="aa-wrap">{unique([...texts(plan.reasons), ...texts(plan.notes)]).map(note => <p key={note}>{note}</p>)}</td><td><Sources urls={plan.sources} /></td></tr>)}</tbody></table></div> : <p>Исключённых тарифов в срезе нет.</p>}
  </details>;
}

function downloadCsv(rows: QuotaRow[], scope: Scope) {
  const fields = ["id", "model", "model_id", "effort", "intelligence_index", "plan", "plan_id", "kind", "confidence", "monthly_usd", "monthly_quota", "quota_unit", "status", "method", "evidence_method", "empirical", "sources", "notes", "component_rates"];
  const metricFields = ["status", "total_tokens", "quota_per_unit", "cost_usd", "effective_price_usd_per_million", "api_price_usd_per_million", "units_per_month", "units_per_100_usd", "cache_read_share", "input_without_cache_read_share", "output_share", "component_tokens", "component_quota", "reported_total_tokens", "total_relative_error_pct", "notes"];
  const cell = (value: unknown) => { let content = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value); if (typeof value !== "number" && /^[=+@\-\t\r]/.test(content)) content = "'" + content; return '"' + content.replace(/"/g, '""') + '"'; };
  const header = ["profile", ...fields, ...metricFields.map(field => `${scope}.${field}`)];
  const records = rows.map(row => {
    const record = row as unknown as Record<string, unknown>, metric = (row[scope] || {}) as Record<string, unknown>;
    return [scope, ...fields.map(field => record[field]), ...metricFields.map(field => metric[field])].map(cell).join(";");
  });
  const url = URL.createObjectURL(new Blob(["\ufeff", header.map(cell).join(";"), "\r\n", records.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `aa-quota-${scope}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface AACostsProps {
  navigation: ReactNode;
  baseData: SiteData;
  theme: "light" | "dark";
  lang: Lang;
}

type SortKey = "model" | "plan" | "cost" | "score" | "fee" | "cache" | "input" | "output" | "api" | "subscription" | "quota" | "month" | "budget" | "confidence" | "method";
const sortValue = (row: QuotaRow, scope: Scope, key: SortKey): number | string | null | undefined => {
  const metric = row[scope] || {};
  switch (key) {
    case "model": return `${row.model} ${row.effort}`;
    case "plan": return row.plan;
    case "cost": return metric.cost_usd;
    case "score": return row.intelligence_index;
    case "fee": return row.monthly_usd;
    case "cache": return metric.cache_read_share;
    case "input": return metric.input_without_cache_read_share;
    case "output": return metric.output_share;
    case "api": return metric.api_price_usd_per_million;
    case "subscription": return row.kind === "subscription" ? metric.effective_price_usd_per_million : null;
    case "quota": return metric.quota_per_unit;
    case "month": return metric.units_per_month;
    case "budget": return metric.units_per_100_usd;
    case "confidence": return confidenceLabel(row.confidence);
    case "method": return `${methodLabel(row.method)} ${evidenceLabel(evidenceKey(row))}`;
  }
};

export default function AACosts({ navigation, baseData, theme, lang }: AACostsProps) {
  const [data, setData] = useState<AACostData | null>(null), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<Selections>(allSelected), [query, setQuery] = useState(""), [scope, setScope] = useState<Scope>("task");
  const [selectedId, setSelectedId] = useState(""), [detailOpen, setDetailOpen] = useState(false), [exact, setExact] = useState(false);
  const [panel, setPanel] = useState<"models" | "filters" | "display" | "download" | null>(null), [filterSearch, setFilterSearch] = useState("");
  const [chartState, setChartState] = useState(defaultState), [sort, setSort] = useState<SortKey>("cost"), [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [exportError, setExportError] = useState("");
  const tableScroll = useRef<HTMLDivElement>(null), chart = useRef<ChartHandle | null>(null);
  useEffect(() => {
    const abort = new AbortController(); setError(""); setData(null);
    fetch("/data/aa-costs.json", { signal: abort.signal }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }).then((value: unknown) => {
      const parsed = value as AACostData;
      if (!parsed?.quota_scenario || !Array.isArray(parsed.quota_scenario.rows)) throw new Error("В файле нет массива quota_scenario.rows.");
      if (parsed.quota_scenario.rows.some(row => !row || typeof row.id !== "string" || typeof row.model_id !== "string" || !["api", "subscription"].includes(row.kind))) throw new Error("Формат строк сценария не соответствует ожидаемой схеме.");
      setData(parsed);
    }).catch((reason: Error) => { if (reason.name !== "AbortError") setError(reason.message || String(reason)); });
    return () => abort.abort();
  }, [attempt]);
  const rows = useMemo(() => data?.quota_scenario.rows ?? [], [data]);
  const options = useMemo(() => Object.fromEntries(filters.map(filter => [filter.key, unique(rows.map(filter.value)).map(value => ({
    value, label: filter.key === "model" ? rows.find(row => row.model_id === value)?.model || value : filter.key === "plan" ? rows.find(row => (row.plan_id || row.plan) === value)?.plan || value : filter.label ? filter.label(value) : value,
  })).sort((a, b) => a.label.localeCompare(b.label, "ru", { numeric: true }))])) as Record<FilterKey, { value: string; label: string }[]>, [rows]);
  const visible = useMemo(() => rows.filter(row => filters.every(filter => selection[filter.key] === null || selection[filter.key]!.includes(filter.value(row)))), [rows, selection]);
  const sorted = useMemo(() => {
    const terms = query.toLocaleLowerCase("ru").trim().split(/\s+/).filter(Boolean);
    return visible.filter(row => terms.every(term => `${row.model} ${row.plan} ${row.effort} ${methodLabel(row.method)} ${evidenceLabel(evidenceKey(row))}`.toLocaleLowerCase("ru").includes(term))).sort((a, b) => {
      const av = sortValue(a, scope, sort), bv = sortValue(b, scope, sort);
      if (av == null) return bv == null ? a.id.localeCompare(b.id) : 1;
      if (bv == null) return -1;
      const comparison = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "ru", { numeric: true });
      return (direction === "asc" ? comparison : -comparison) || a.id.localeCompare(b.id);
    });
  }, [visible, query, scope, sort, direction]);
  const adapted = useMemo(() => adaptAAChart(visible, scope, baseData), [visible, scope, baseData]);
  const mixedMethods = hasMixedEmpiricalMethods(visible);
  const state: State = { ...chartState, frontier: chartState.frontier && !mixedMethods, labels: mixedMethods && chartState.labels === "frontier" ? "none" : chartState.labels, view: "pareto", board: "aa_combined", configuration: "all", lang };
  const chartData = useMemo(() => ({ ...baseData, boards: { ...baseData.boards, aa_combined: {
    name: "AA + подписки", metric: "Artificial Analysis Intelligence Index", url: "https://artificialanalysis.ai/#price-and-cost", snapshot: String(data?.quota_scenario.metadata?.aa_retrieved_at || "").slice(0, 10),
  } } }), [baseData, data]);
  const plotted = groups(adapted.rows), frontier = mixedMethods ? [] : pareto(plotted);
  const frontIds = new Set(frontier.flatMap(group => group.rows.map(row => row.point.id)));
  const channels = unique(adapted.rows.map(row => row.point.channel)).sort();
  const activeFilters = filters.filter(filter => selection[filter.key] !== null);
  const example = rows.find(row => row.id === selectedId);
  const reconstruction = example?.source_id ? data?.api_estimate?.rows?.find(row => row.source_id === example.source_id)?.[scope] : undefined;
  const chooseExample = (row: QuotaRow) => { setSelectedId(row.id); setDetailOpen(true); };
  const reset = () => { setSelection(allSelected()); setQuery(""); setChartState(defaultState()); };
  const setFilter = (key: FilterKey, value: string[] | null) => setSelection(previous => ({ ...previous, [key]: value }));
  const chooseEmpiricalMethod = (method: EmpiricalMethod) => {
    setFilter("method", methodsWithEmpiricalChoice(options.method.map(option => option.value), method));
    setChartState(previous => ({ ...previous, find: "", lock: null }));
  };
  const toggleFilter = (key: FilterKey, value: string) => {
    const checked = selection[key] ?? options[key].map(option => option.value);
    const next = checked.includes(value) ? checked.filter(item => item !== value) : [...checked, value];
    setFilter(key, next.length === options[key].length ? null : next);
  };
  const sortHead = (key: SortKey, label: string, title?: string) => <th key={key} aria-sort={sort === key ? direction === "asc" ? "ascending" : "descending" : "none"} title={title}><button onClick={() => { setSort(key); setDirection(sort === key && direction === "asc" ? "desc" : "asc"); }}>{label}{sort === key && (direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>;
  const renderFilters = (keys: FilterKey[]) => <div className="filter-grid aa-filter-fields">{filters.filter(filter => keys.includes(filter.key)).map(filter => {
    const selected = selection[filter.key] ?? options[filter.key].map(option => option.value);
    return <fieldset key={filter.key}><legend>{filter.title} <button onClick={() => setFilter(filter.key, null)}>Все</button><button onClick={() => setFilter(filter.key, [])}>Снять</button></legend><div className="filter-options">{options[filter.key].filter(option => !filterSearch || option.label.toLocaleLowerCase("ru").includes(filterSearch.toLocaleLowerCase("ru"))).map(option => <label key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggleFilter(filter.key, option.value)} />{option.label}</label>)}</div></fieldset>;
  })}</div>;
  const unitName = scope === "task" ? "задача" : "набор";
  const exportChart = async (format: "png" | "svg") => { setExportError(""); try { await chart.current?.download(format); } catch (reason) { setExportError(reason instanceof Error ? reason.message : String(reason)); } };
  if (!data) return <section className="workspace aa-combined">{navigation}<div className="empty"><Calculator size={35} /><h3>{error ? "Не удалось загрузить расчёты AA" : "Загружаем расчёты AA…"}</h3><p>{error || "Профили токенов AA, квоты и практические замеры подписок."}</p>{error && <button onClick={() => setAttempt(value => value + 1)}>Повторить загрузку</button>}</div></section>;
  const metadata = data.quota_scenario.metadata || {};
  const countSubscriptions = visible.filter(row => row.kind === "subscription").length;
  return <>
    <section className="workspace aa-combined" aria-label="Совместная оценка AA и подписок">
      {navigation}
      <div className="chart-heading"><div><h2>Стоимость задачи и интеллект</h2><p>Artificial Analysis Intelligence Index · {scope === "task" ? "взвешенная задача AA" : "полный набор AA"} · <a href="https://artificialanalysis.ai/#price-and-cost" target="_blank" rel="noreferrer">Источник AA <ArrowUpRight size={14} /></a></p></div><div className="chart-actions"><button className="icon-button" title="Скачать график или данные" aria-label="Скачать график или данные" onClick={() => setPanel("download")}><DownloadSimple size={19} /></button><button className="icon-button" title="Настройки графика" aria-label="Настройки графика" onClick={() => setPanel("display")}><SlidersHorizontal size={19} /></button></div></div>
      <div className="toolbar"><button className="select-models" onClick={() => { setFilterSearch(""); setPanel("models"); }}><CheckSquare size={18} /><span>Модели и тарифы</span><span className="count">{visible.length} / {rows.length}</span><CaretDown size={14} /></button><button className={activeFilters.some(filter => !["model", "plan"].includes(filter.key)) ? "filter-button has-filters" : "filter-button"} onClick={() => { setFilterSearch(""); setPanel("filters"); }}><FunnelSimple size={17} />Фильтры</button><label className="config-select"><span className="sr-only">Объём работы AA</span><select id="aa-scope" value={scope} onChange={event => { setScope(event.target.value as Scope); setChartState(previous => ({ ...previous, find: "", lock: null })); }}><option value="task">Одна задача AA</option><option value="suite">Полный набор AA</option></select></label><span className="toolbar-space" /><span className="results-count">{adapted.rows.length} точек · {countSubscriptions} подписок</span></div>
      {activeFilters.length > 0 && <div className="chips">{activeFilters.map(filter => <button key={filter.key} onClick={() => setFilter(filter.key, null)}>{filter.title}: {selection[filter.key]!.length} из {options[filter.key].length}<X size={12} /></button>)}<button className="clear-all" onClick={reset}>Сбросить всё</button></div>}
      {mixedMethods && <aside className="aa-comparison-warning" aria-labelledby="aa-comparison-warning-title"><Info size={17} /><div><strong id="aa-comparison-warning-title">В выборке разные допущения о расходе подписки</strong><p>API-калибровка предполагает расход лимита пропорционально API-стоимости. Токенная оценка переносит ёмкость с равным весом всех токенов. Их разница может создавать мнимую выгоду тарифа, поэтому общая Pareto-граница отключена. Все точки сохранены.</p><div className="aa-comparison-actions"><button onClick={() => chooseEmpiricalMethod("empirical_api_calibration")}>Оставить API-калибровку</button><button onClick={() => chooseEmpiricalMethod("empirical_token_proxy")}>Оставить токенную оценку</button></div><small>API AA и расчёты «Квота × ставки» сохраняются; остальные фильтры продолжают действовать.</small></div></aside>}
      <div className="legend">{channels.map(channel => <span key={channel}><i style={{ background: color(adapted.rows.find(row => row.point.channel === channel)!.point) }} />{channel}</span>)}{state.frontier && <span className="frontier-legend"><i />Граница текущей выборки</span>}</div>
      {adapted.rows.length ? <Chart rows={adapted.rows} suppressFrontier={mixedMethods} state={state} data={chartData} theme={theme} handle={chart} metricLabels={{ axisTitle: scope === "task" ? "Стоимость задачи AA · $ / задача" : "Стоимость полного набора AA · $ / набор", priceLabel: scope === "task" ? "Стоимость задачи AA" : "Стоимость набора AA", priceUnit: scope === "task" ? "задача" : "набор" }} onSearch={(find, lock) => setChartState(previous => ({ ...previous, find, lock }))} onSelect={selected => { const original = selected.map(row => adapted.sourceRows.get(row.point.id)).find(Boolean); if (original) chooseExample(original); }} /> : <div className="empty"><Calculator size={35} /><h3>Нет точек для графика</h3><p>Строки без стоимости или индекса сохраняются в таблице. Неизвестные значения не заменяются нулями.</p><button onClick={reset}>Сбросить фильтры</button></div>}
      <div className="chart-foot"><div><Info size={15} /><span>Правее — дешевле. Выше — больше индекс AA. Нажмите точку для расчёта и источников.</span></div><span>{plotted.length} координат · {mixedMethods ? "общая граница отключена: разные методы" : `${frontier.length} на границе`}</span></div>
      {visible.length > adapted.rows.length && <details className="unscored"><summary>{visible.length - adapted.rows.length} строк без стоимости или индекса</summary><p>Все они остаются в таблице; цену и индекс не достраиваем.</p><div>{visible.filter(row => !adapted.rows.some(point => point.point.id === `aa::${row.id}`)).map(row => <button key={row.id} onClick={() => chooseExample(row)}>{row.model} · {effortLabel(row)} · {row.plan}<ArrowUpRight size={12} /></button>)}</div></details>}
    </section>
    <div className="method-note aa-method-note"><Info size={16} /><p>Три способа оценить подписку на профиле AA: квота × ставки; API-калибровка по доле израсходованного лимита; условная токенная ёмкость по замерам. Фиксированная смесь RAP не используется. API-калибровка предполагает пропорциональное API-стоимости списание, токенная оценка — перенос ёмкости между смесями. Методы и происхождение замеров видны в таблице и фильтрах. ≈ обозначает допущения; оценка предполагает полное использование месячной ёмкости. «На $100» — нормировка, попытки не равны успешным решениям. <button onClick={() => { const row = visible.find(item => item.kind === "subscription" && hasCost(item[scope])) || visible[0]; if (row) chooseExample(row); }}>Показать арифметику <ArrowUpRight size={13} /></button>{metadata.status && metadata.status !== "ok" && <span> Проверка данных: {texts(metadata.notes).join(" ")}</span>}</p></div>
    <section className="data-section aa-data-section" id="all-data" tabIndex={-1}>
      <div className="table-heading"><div><h2>Данные и расчёты.</h2><p>Каждый тариф и effort · {scope === "task" ? "одна взвешенная задача AA" : "полный набор AA"} · исходная точность доступна в разборе.</p></div><button className="text-button" onClick={() => downloadCsv(sorted, scope)} disabled={!sorted.length}><DownloadSimple size={16} />Экспорт CSV</button></div>
      <div className="table-tools"><label className="search"><MagnifyingGlass size={17} /><input aria-label="Поиск в таблице AA" placeholder="Найти модель, тариф или effort…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" onClick={() => setQuery("")} aria-label="Очистить поиск"><X size={14} /></button>}</label><span>{sorted.length} строк</span></div>
      <div className="table-scroll" ref={tableScroll} role="region" tabIndex={0} aria-label="Таблица стоимости задач AA"><table><thead><tr><th className="row-number">#</th>{sortHead("model", "Модель / effort")}{sortHead("plan", "Тариф / канал")}{sortHead("method", "Метод / основание")}{sortHead("cost", `$ / ${unitName}`)}{sortHead("score", "Индекс AA", "Индекс показан для сравнения качества и не входит в формулу стоимости.")}{sortHead("fee", "$ / месяц")}{sortHead("cache", "Чтение кэша")}{sortHead("input", "Вход + запись кэша")}{sortHead("output", "Выход")}{sortHead("api", "API, $ / MTok")}{sortHead("subscription", "Подписка, $ / MTok")}{sortHead("quota", `Квота / ${unitName}`)}{sortHead("month", "Единиц / месяц")}{sortHead("budget", "Единиц / $100")}{sortHead("confidence", "Достоверность")}<th><span className="sr-only">Разбор</span></th></tr></thead><tbody>{sorted.map((row, index) => {
        const metric = row[scope] || {}, point = aaReferencePoint(row, baseData), approximate = metric.status === "approximate";
        return <tr key={row.id} onClick={() => chooseExample(row)} className={state.frontier && frontIds.has(`aa::${row.id}`) ? "frontier-row" : ""}><td className="row-number">{index + 1}</td><td><button className="model-cell" onClick={event => { event.stopPropagation(); chooseExample(row); }}><i className="vendor-dot" style={{ background: point ? color(point) : "var(--muted)" }} /><span><strong className="model-with-logo">{point && <BrandMarks point={point} />}{row.model}</strong><small>{effortLabel(row)}</small></span></button></td><td><strong className="plan-name">{row.plan}</strong><small>{point?.channel || "—"} · {row.kind === "api" ? "API" : "Подписка"}</small></td><td className="aa-method-cell"><strong>{methodLabel(row.method)}</strong><small>{evidenceLabel(evidenceKey(row))}</small></td><td className="numeric real-price">{costLabel(row, scope)}{!hasCost(metric) && <small>{statusNames[metric.status || "missing"]}</small>}</td><td className="numeric">{row.estimated ? "≈ " : ""}{number(row.intelligence_index)}</td><td className="numeric">{money(row.monthly_usd)}</td>{[metric.cache_read_share, metric.input_without_cache_read_share, metric.output_share].map((value, item) => <td key={item} className="numeric">{percent(value)}</td>)}<td className="numeric">{money(metric.api_price_usd_per_million)}</td><td className="numeric">{row.kind === "subscription" ? (approximate && finite(metric.effective_price_usd_per_million) ? "≈ " : "") + money(metric.effective_price_usd_per_million) : "—"}</td><td className="numeric">{number(metric.quota_per_unit)}{row.quota_unit && <small>{row.quota_unit}</small>}</td><td className="numeric">{number(metric.units_per_month)}</td><td className="numeric">{number(metric.units_per_100_usd)}</td><td><span className={`confidence ${row.confidence === "source" || row.confidence === "documented" ? "high" : "medium"}`}><i />{confidenceLabel(row.confidence)}</span></td><td><ArrowUpRight size={15} /></td></tr>;
      })}</tbody></table>{!sorted.length && <div className="empty table-empty">Нет строк, соответствующих фильтрам и поиску.</div>}</div>
      <ResizeHandle target={tableScroll} label="Потяните для изменения высоты таблицы · двойной щелчок для сброса" /><p className="ranking-status">{sorted.length} строк · прокрутка внутри таблицы · три доли токенов суммируются в 100% до округления. Выход включает ответ и reasoning.</p>
      <details className="aa-data-notes"><summary>Метод, срезы данных и ограничения</summary><p>Для каждого тарифа показан применённый метод и происхождение данных: прямой замер, перенос с другого тарифа, несколько замеров или замер с поправками. Практический замер не означает фиксированный официальный токенный лимит. Квота × ставки использует известный бюджет и веса категорий; API-калибровка оценивает бюджет по наблюдаемой доле лимита; токенная оценка условно переносит ёмкость по замерам без известных весов списания.</p><p>Цена API и цена подписки за миллион относятся к одному профилю AA. Стоимость задачи — взвешенное среднее расходов по бенчмаркам, без деления на индекс интеллекта. Стоимость набора — суммарный расход полного прогона; пропорции между моделями могут отличаться.</p><p>AA {metadata.aa_version || "—"} · срез AA: {metadata.aa_retrieved_at || "—"} · срез тарифов: {metadata.pricing_retrieved_at_utc || "—"} · включено пар модель × тариф: {number(metadata.included_plans)}.</p>{metadata.pricing_revision && /^[a-f0-9]{7,40}$/i.test(metadata.pricing_revision) && <p><a href={`https://github.com/FeiZhuLulu/real-api-pricing/tree/${metadata.pricing_revision}`} target="_blank" rel="noreferrer">Исходный срез RAP {metadata.pricing_revision.slice(0, 8)} ↗</a></p>}{typeof metadata.supplemental_source_revision === "string" && /^[a-f0-9]{7,40}$/i.test(metadata.supplemental_source_revision) && <p>Дополнительные практические данные: <a href={`https://github.com/FeiZhuLulu/real-api-pricing/tree/${metadata.supplemental_source_revision}`} target="_blank" rel="noreferrer">срез RAP {metadata.supplemental_source_revision.slice(0, 8)} ↗</a>. API-калибровка: {number(metadata.empirical_api_calibration_plans)} пар; перенос токенной ёмкости: {number(metadata.empirical_token_proxy_plans)} пар.</p>}<p><a href="/aa-archive/report.html">Предыдущие расчёты и оценка API ↗</a></p></details>
      <ExcludedPlans plans={data.quota_scenario.excluded || []} />
    </section>
    {panel && <Modal title={panel === "models" ? "Выберите модели и тарифы" : panel === "filters" ? "Фильтры расчёта" : panel === "display" ? "Настройки графика" : "Скачать график и данные"} onClose={() => setPanel(null)} wide={panel === "models" || panel === "filters"} closeLabel="Закрыть">
      {(panel === "models" || panel === "filters") && <><p className="panel-description">Выбор внутри группы объединяется; разные группы применяются совместно. Пустая группа исключает все строки. График и таблица обновляются сразу.</p><label className="search"><MagnifyingGlass size={18} /><input autoFocus aria-label="Поиск вариантов фильтра" placeholder="Найти вариант…" value={filterSearch} onChange={event => setFilterSearch(event.target.value)} /></label>{renderFilters(panel === "models" ? ["model", "plan"] : ["effort", "kind", "method", "evidence", "confidence"])}<div className="panel-bottom"><button onClick={() => { setSelection(allSelected()); setFilterSearch(""); }}>Сбросить фильтры</button><button className="primary" onClick={() => setPanel(null)}>Показать · {visible.length}<ArrowUpRight size={16} /></button></div></>}
      {panel === "display" && <div className="settings"><label><span>Граница текущей выборки</span><input type="checkbox" disabled={mixedMethods} checked={state.frontier} onChange={event => setChartState(previous => ({ ...previous, frontier: event.target.checked }))} /></label><label><span>Подписи точек</span><select value={state.labels} onChange={event => setChartState(previous => ({ ...previous, labels: event.target.value as State["labels"] }))}><option value="frontier" disabled={mixedMethods}>На границе</option><option value="all">Все</option><option value="none">Без подписей</option></select></label>{mixedMethods && <p className="panel-description">Общая граница и её подписи отключены, пока вместе показаны API-калибровка и токенная оценка. Выберите один эмпирический метод кнопками над графиком или в фильтрах.</p>}</div>}
      {panel === "download" && <div className="download-list"><p className="panel-description">График использует текущие фильтры и единицы стоимости. CSV содержит строки таблицы с исходной числовой точностью.</p><button onClick={() => void exportChart("png")} disabled={!adapted.rows.length}><DownloadSimple size={17} />График PNG</button><button onClick={() => void exportChart("svg")} disabled={!adapted.rows.length}><DownloadSimple size={17} />График SVG</button><button onClick={() => downloadCsv(sorted, scope)} disabled={!sorted.length}><DownloadSimple size={17} />Таблица CSV</button>{exportError && <p role="alert">Не удалось экспортировать график: {exportError}</p>}</div>}
    </Modal>}
    {detailOpen && example && <Modal title="Пошаговый расчёт" onClose={() => setDetailOpen(false)} wide closeLabel="Закрыть"><div className="aa-calculation-controls"><label>Модель · effort · тариф<select id="aa-example" value={selectedId} onChange={event => setSelectedId(event.target.value)}>{rows.map(row => <option key={row.id} value={row.id}>{row.model} · {effortLabel(row)} · {row.plan}</option>)}</select></label><label className="aa-exact"><input type="checkbox" checked={exact} onChange={event => setExact(event.target.checked)} />Полная точность</label></div><Calculation row={example} scope={scope} exact={exact} estimate={reconstruction} /></Modal>}
  </>;
}
