import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Calculator, CaretDown, DownloadSimple, FunnelSimple } from "@phosphor-icons/react";
import { componentKeys } from "./aaTypes";
import type { AACostData, AATokenReconstruction, ComponentKey, QuotaMetric, QuotaPlan, QuotaRow, Scope } from "./aaTypes";

const componentNames: Record<ComponentKey, string> = {
  non_cache_input: "Вход без кэша", cache_read: "Чтение кэша", cache_write: "Запись кэша", answer: "Ответ", reasoning: "Reasoning",
};
const confidenceNames: Record<string, string> = { documented: "Документировано", assumed: "С допущениями", source: "Исходные данные API", unavailable: "Недоступно" };
const statusNames: Record<string, string> = { consistent: "Согласовано", approximate: "Приближённая оценка", missing: "Нет данных AA", unavailable: "Расчёт недоступен" };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
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

type FilterKey = "model" | "plan" | "effort" | "kind" | "confidence";
type Selections = Record<FilterKey, string[] | null>;
const allSelected = (): Selections => ({ model: null, plan: null, effort: null, kind: null, confidence: null });
const filters: { key: FilterKey; title: string; value: (row: QuotaRow) => string; label?: (value: string) => string }[] = [
  { key: "model", title: "Модели", value: row => row.model_id },
  { key: "plan", title: "Тарифы", value: row => row.plan_id || row.plan },
  { key: "effort", title: "Effort", value: row => row.effort || "Не указан" },
  { key: "kind", title: "Оплата", value: row => row.kind, label: value => value === "api" ? "API" : "Подписка" },
  { key: "confidence", title: "Достоверность ставок", value: row => row.confidence || "unknown", label: confidenceLabel },
];

function Sources({ urls }: { urls?: string[] }) {
  return <span className="aa-sources">{unique(texts(urls)).filter(url => sourceUrl(url)).map((url, index) => (
    <a key={url} href={sourceUrl(url)!} target="_blank" rel="noreferrer" title={url}>{new URL(url).hostname.replace(/^www\./, "")}{index ? ` · ${index + 1}` : ""} ↗</a>
  ))}</span>;
}

function MultiFilter({ title, options, selected, onChange }: {
  title: string; options: { value: string; label: string }[]; selected: string[] | null; onChange: (value: string[] | null) => void;
}) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDetailsElement>(null);
  const checked = selected ?? options.map(option => option.value);
  const matching = options.filter(option => option.label.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")));
  const isAll = selected === null || checked.length === options.length;
  useEffect(() => {
    const close = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <details ref={ref} className={`aa-filter ${isAll ? "" : "aa-filter-active"}`} onKeyDown={event => {
    if (event.key === "Escape" && ref.current) { ref.current.open = false; ref.current.querySelector("summary")?.focus(); }
  }}>
    <summary><span>{title}</span><b>{isAll ? "Все" : checked.length === 0 ? "Ничего" : `${checked.length} из ${options.length}`}</b><CaretDown size={13} /></summary>
    <div className="aa-filter-panel">
      <input aria-label={`Поиск: ${title}`} placeholder="Найти вариант" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="aa-filter-actions"><button type="button" onClick={() => onChange(null)}>Все</button><button type="button" onClick={() => onChange([])}>Снять</button></div>
      <div className="aa-filter-options">{matching.map(option => <label key={option.value}>
        <input type="checkbox" checked={checked.includes(option.value)} onChange={event => onChange(event.target.checked ? unique([...checked, option.value]) : checked.filter(value => value !== option.value))} />
        <span>{option.label}</span>
      </label>)}{!matching.length && <small>Ничего не найдено.</small>}</div>
    </div>
  </details>;
}

function PriceChart({ rows, scope, selectedId, onSelect }: { rows: QuotaRow[]; scope: Scope; selectedId: string; onSelect: (row: QuotaRow) => void }) {
  const priced = useMemo(() => rows.filter(row => positive(row[scope]?.cost_usd)).sort((a, b) => a[scope]!.cost_usd! - b[scope]!.cost_usd!), [rows, scope]);
  if (!priced.length) return <div className="aa-empty">Нет положительных цен для графика. Пустые и нулевые значения остаются в таблице.</div>;
  const minimum = Math.log10(priced[0][scope]!.cost_usd!), maximum = Math.log10(priced.at(-1)![scope]!.cost_usd!);
  const padding = Math.max(.12, (maximum - minimum) * .05), lower = minimum - padding, upper = maximum + padding;
  const position = (value: number) => 100 * (Math.log10(value) - lower) / (upper - lower);
  const ticks = [0, .5, 1].map(fraction => 10 ** (lower + (upper - lower) * fraction));
  return <>
    <div className="aa-chart-axis"><span>Модель · effort · тариф</span><div>{ticks.map((value, index) => <span key={index} style={{ left: `${index * 50}%` }}>{money(value)}</span>)}</div><span>Стоимость</span></div>
    <div className="aa-chart-list" role="list" aria-label={`Стоимость ${scope === "task" ? "задачи" : "набора"} по возрастанию`}>
      {priced.map(row => {
        const hash = [...row.model_id].reduce((sum, letter) => sum + letter.charCodeAt(0), 0);
        return <button key={row.id} type="button" role="listitem" className={`aa-price-row ${selectedId === row.id ? "aa-price-selected" : ""}`}
          onClick={() => onSelect(row)} title={`${row.model} · ${effortLabel(row)} · ${row.plan}: ${costLabel(row, scope)}. Нажмите для расчёта.`}>
          <span className="aa-price-name"><strong>{row.model} <em>{effortLabel(row)}</em></strong><small>{row.plan}</small></span>
          <span className="aa-price-track"><i className={row.kind === "api" ? "aa-dot-api" : "aa-dot-subscription"} style={{ left: `${position(row[scope]!.cost_usd!)}%`, "--aa-point": `hsl(${hash % 360} 48% 45%)` } as CSSProperties} /></span>
          <span className="aa-price-value">{costLabel(row, scope)}</span>
        </button>;
      })}
    </div>
    <p className="aa-chart-note">Логарифмическая шкала · ● API · ◇ подписка. Нажмите строку для разбора. {rows.length - priced.length > 0 && `Без положительной цены: ${rows.length - priced.length}.`}</p>
  </>;
}

function Equation({ label, children }: { label: string; children: ReactNode }) {
  return <div className="aa-equation"><small>{label}</small><div>{children}</div></div>;
}

function TokenReconstruction({ estimate, metric, exact }: { estimate?: AATokenReconstruction; metric: QuotaMetric; exact: boolean }) {
  if (!estimate) return <p>Разбивка исходных расходов AA для восстановления токенов отсутствует. Ниже сохранены опубликованные результаты расчёта.</p>;
  const n = (value: unknown) => number(value, exact);
  return <div className="aa-token-reconstruction"><h4>Исходный профиль: расход AA ÷ API-ставка × 1 000 000</h4><p>API-ставки здесь используются только для восстановления токенов AA. Далее эти токены расходуют квоту подписки по её собственным ставкам.</p><div className="aa-scroll"><table className="aa-calculation-table"><thead><tr><th>Категория</th><th>Расход AA, $</th><th>API-ставка, $/MTok</th><th>Восстановление токенов</th><th>Токены для расчёта</th></tr></thead><tbody>{componentKeys.map(key => <tr key={key}><th>{componentNames[key]}</th><td>{money(estimate.component_costs_usd?.[key], exact)}</td><td>{money(estimate.rates_usd_per_million?.[key], exact)}</td><td className="aa-operation">{n(estimate.component_costs_usd?.[key])} ÷ {n(estimate.rates_usd_per_million?.[key])} × 1 000 000</td><td>{n(metric.component_tokens?.[key])}</td></tr>)}</tbody></table></div><Equation label="Сумма пяти непересекающихся категорий">{componentKeys.map((key, index) => <span key={key}>{index ? " + " : ""}{n(metric.component_tokens?.[key])}</span>)} = <strong>{n(metric.total_tokens)} токенов</strong></Equation></div>;
}

function Calculation({ row, scope, exact, estimate }: { row: QuotaRow; scope: Scope; exact: boolean; estimate?: AATokenReconstruction }) {
  const metric = row[scope] ?? {};
  const n = (value: unknown) => number(value, exact);
  const unit = row.quota_unit || "ед. квоты";
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
    <div className="aa-calculation-givens"><span>Плата F: <b>{money(row.monthly_usd, exact)} / мес.</b></span><span>Квота Q: <b>{n(row.monthly_quota)} {unit} / мес.</b></span><span>Ставки: <b>{confidenceLabel(row.confidence)}</b></span></div>
    <TokenReconstruction estimate={estimate} metric={metric} exact={exact} />
    <p>Берём пять непересекающихся категорий токенов AA. Для каждой умножаем количество токенов на ставку расхода квоты за миллион. Ставки ниже уже включают применённые коэффициенты канала.</p>
    <div className="aa-scroll"><table className="aa-calculation-table"><thead><tr><th>Категория</th><th>Токены AA</th><th>Ставка: {unit} / MTok</th><th>Операция</th><th>Списание, {unit}</th></tr></thead><tbody>
      {componentKeys.map(key => <tr key={key}><th>{componentNames[key]}</th><td>{n(metric.component_tokens?.[key])}</td><td>{n(row.component_rates?.[key])}</td><td className="aa-operation">{n(metric.component_tokens?.[key])} × {n(row.component_rates?.[key])} ÷ 1 000 000</td><td>{n(metric.component_quota?.[key])}</td></tr>)}
    </tbody></table></div>
    {!hasCost(metric) && <div className="aa-notice">Не хватает согласованных данных для этого профиля. Неизвестные значения не заменяются нулями.</div>}
    <Equation label="1. Складываем расход квоты по пяти категориям">{componentKeys.map((key, index) => <span key={key}>{index > 0 ? " + " : ""}{n(metric.component_quota?.[key])}</span>)} = <strong>{n(metric.quota_per_unit)} {unit}</strong></Equation>
    <Equation label="2. Выделяем долю месячной платы: F × списание / Q">{money(row.monthly_usd, exact)} × {n(metric.quota_per_unit)} ÷ {n(row.monthly_quota)} = <strong>{money(metric.cost_usd, exact)} / {scope === "task" ? "задачу" : "набор"}</strong></Equation>
    <Equation label="3. Делим месячную квоту на расход одной единицы работы">{n(row.monthly_quota)} ÷ {n(metric.quota_per_unit)} = <strong>{n(metric.units_per_month)} {scope === "task" ? "задач" : "наборов"} / мес.</strong></Equation>
    <Equation label="4. Нормируем стоимость на $100">$100 ÷ {money(metric.cost_usd, exact)} = <strong>{n(metric.units_per_100_usd)} {scope === "task" ? "задач" : "наборов"} / $100</strong></Equation>
    <Equation label="5. Цена миллиона токенов на этом составе AA">{money(metric.cost_usd, exact)} ÷ {n(metric.total_tokens)} × 1 000 000 = <strong>{money(metric.effective_price_usd_per_million, exact)} / MTok</strong></Equation>
    <div className="aa-calculation-givens"><span>Всего токенов в расчёте: <b>{n(metric.total_tokens)}</b></span>{scope === "suite" && <span>Опубликованный AA total: <b>{n(metric.reported_total_tokens)}</b></span>}<span>Отклонение {scope === "suite" ? "total" : "output"}: <b>{errorPercent(scope === "suite" ? metric.total_relative_error_pct : metric.output_relative_error_pct)}</b></span></div>
    <p>Число токенов здесь — сумма восстановленных категорий. Для полного набора опубликованный AA total показан отдельно для сверки; его нельзя незаметно подставлять вместо суммы при списании квоты.</p>
    {row.original_quota != null && <details className="aa-source-detail"><summary>Исходная квота и основание ставок</summary><pre>{humanValue(row.original_quota)}</pre>{row.rate_basis != null && <pre>{humanValue(row.rate_basis)}</pre>}</details>}
    <h4>Допущения и источники</h4>
    <ul className="aa-notes"><li>Плата распределена на полностью использованную месячную квоту, только на эту модель и профиль AA. Общая квота, временные ограничения и доступность effort могут уменьшить объём.</li><li>«На $100» — нормировка, а не покупка части тарифа. Оплаченная попытка не означает успешно решённую задачу.</li>{combinedNotes.map(note => <li key={note}>{note}</li>)}</ul>
    <Sources urls={row.sources} />
  </div>;
}

function ExcludedPlans({ plans }: { plans: QuotaPlan[] }) {
  return <details className="aa-excluded"><summary>Исключённые тарифы и причины <span>{plans.length}</span></summary>
    {plans.length ? <div className="aa-scroll"><table className="aa-data-table"><thead><tr><th>Модель / тариф</th><th>Причина</th><th>Источники</th></tr></thead><tbody>{plans.map((plan, index) => <tr key={plan.id || index}><td><b>{plan.model_id}</b><small>{plan.plan}</small></td><td className="aa-wrap">{unique([...texts(plan.reasons), ...texts(plan.notes)]).map(note => <p key={note}>{note}</p>)}</td><td><Sources urls={plan.sources} /></td></tr>)}</tbody></table></div> : <p>Исключённых тарифов в срезе нет.</p>}
  </details>;
}

function downloadCsv(rows: QuotaRow[], scope: Scope) {
  const fields = ["id", "model", "model_id", "effort", "intelligence_index", "plan", "plan_id", "kind", "confidence", "monthly_usd", "monthly_quota", "quota_unit", "status", "method", "sources", "notes", "component_rates"];
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

export default function AACosts() {
  const [data, setData] = useState<AACostData | null>(null), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<Selections>(allSelected), [query, setQuery] = useState(""), [scope, setScope] = useState<Scope>("task");
  const [selectedId, setSelectedId] = useState(""), [detailOpen, setDetailOpen] = useState(false), [exact, setExact] = useState(false);
  const detailRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const abort = new AbortController();setError("");setData(null);
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
  const rows = data?.quota_scenario.rows ?? [];
  const options = useMemo(() => Object.fromEntries(filters.map(filter => [filter.key, unique(rows.map(filter.value)).map(value => ({
    value, label: filter.key === "model" ? rows.find(row => row.model_id === value)?.model || value : filter.key === "plan" ? rows.find(row => (row.plan_id || row.plan) === value)?.plan || value : filter.label ? filter.label(value) : value,
  })).sort((a, b) => a.label.localeCompare(b.label, "ru", { numeric: true }))])) as Record<FilterKey, { value: string; label: string }[]>, [rows]);
  const visible = useMemo(() => {
    const terms = query.toLocaleLowerCase("ru").trim().split(/\s+/).filter(Boolean);
    return rows.filter(row => filters.every(filter => selection[filter.key] === null || selection[filter.key]!.includes(filter.value(row))) && terms.every(term => `${row.model} ${row.plan} ${row.effort}`.toLocaleLowerCase("ru").includes(term)));
  }, [rows, selection, query]);
  const sorted = useMemo(() => [...visible].sort((a, b) => {
    const av = a[scope]?.cost_usd, bv = b[scope]?.cost_usd;
    return !finite(av) ? finite(bv) ? 1 : 0 : !finite(bv) ? -1 : av - bv;
  }), [visible, scope]);
  useEffect(() => { if (!visible.some(row => row.id === selectedId)) setSelectedId((visible.find(row => row.kind === "subscription" && hasCost(row[scope])) || visible[0])?.id || ""); }, [visible, scope, selectedId]);
  const example = visible.find(row => row.id === selectedId);
  const reconstruction = example?.source_id ? data?.api_estimate?.rows?.find(row => row.source_id === example.source_id)?.[scope] : undefined;
  const chooseExample = (row: QuotaRow) => { setSelectedId(row.id);setDetailOpen(true);requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  if (error) return <main className="aa-page"><div className="aa-empty"><Calculator size={30} /><h1>Не удалось загрузить расчёты AA</h1><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Повторить загрузку</button><a href="/aa-archive/report.html">Открыть предыдущий отчёт ↗</a></div></main>;
  if (!data) return <main className="aa-page"><div className="aa-empty"><Calculator size={30} /><h1>Задачи AA</h1><p>Загружаем исходные данные и ставки квоты…</p></div></main>;
  const metadata = data.quota_scenario.metadata || {};
  const assumed = rows.filter(row => row.kind === "subscription").every(row => row.confidence === "assumed");
  const countSubscriptions = visible.filter(row => row.kind === "subscription").length;
  const unitName = scope === "task" ? "задача" : "набор";
  return <main className="aa-page">
    <header className="aa-heading"><div><div className="aa-kicker">Real API Pricing / Artificial Analysis</div><h1>Сколько стоит задача</h1><p>Токены AA → расход квоты тарифа → стоимость работы. Пять категорий учитываются по отдельным ставкам; фиксированная смесь RAP в расчёте не используется.</p></div><a className="aa-archive" href="/aa-archive/report.html">Предыдущие расчёты и оценка API ↗</a></header>
    <div className="aa-meta"><span>{metadata.aa_version ? `AA ${metadata.aa_version}` : "Данные Artificial Analysis"}</span>{metadata.aa_retrieved_at && <span>Срез AA: {metadata.aa_retrieved_at}</span>}{metadata.pricing_retrieved_at_utc && <span>Срез тарифов: {metadata.pricing_retrieved_at_utc}</span>}{metadata.pricing_revision && /^[a-f0-9]{7,40}$/i.test(metadata.pricing_revision) && <a href={`https://github.com/FeiZhuLulu/real-api-pricing/tree/${metadata.pricing_revision}`} target="_blank" rel="noreferrer">RAP {metadata.pricing_revision.slice(0, 8)} ↗</a>}<span>Включено пар модель × тариф: {number(metadata.included_plans)}</span></div>
    <div className="aa-notice"><b>Оценка при полном использовании месячной квоты.</b> {assumed && rows.some(row => row.kind === "subscription") ? "Все включённые подписки сейчас содержат допущения о ставках, в том числе для reasoning; они отмечены знаком ≈." : "Ставки с допущениями и приближённые профили AA отмечены знаком ≈."} Временные лимиты, общая квота и доступность effort могут уменьшить объём. Количество попыток не равно количеству успешно решённых задач.</div>
    {metadata.status && metadata.status !== "ok" && <div className="aa-notice aa-notice-error"><b>Пересчёт подписок ограничен проверкой данных.</b> {texts(metadata.notes).join(" ")} Исходные API-стоимости остаются доступны.</div>}
    <section className="aa-filters" aria-label="Фильтры задач AA">
      <div className="aa-filter-grid">{filters.map(filter => <MultiFilter key={filter.key} title={filter.title} options={options[filter.key]} selected={selection[filter.key]} onChange={value => setSelection(previous => ({ ...previous, [filter.key]: value }))} />)}</div>
      <div className="aa-toolbar"><label className="aa-search"><FunnelSimple size={16} /><input aria-label="Поиск модели, тарифа или effort" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти модель, тариф или effort" /></label><label className="aa-scope">Профиль<select id="aa-scope" value={scope} onChange={event => setScope(event.target.value as Scope)}><option value="task">Одна задача AA</option><option value="suite">Полный набор AA</option></select></label><button type="button" onClick={() => { setSelection(allSelected());setQuery("");setScope("task"); }}>Сбросить</button></div>
      <small>Внутри фильтра — любой выбранный вариант; между фильтрами — все условия. «Снять» оставляет группу пустой.</small>
    </section>
    <div className="aa-section-heading"><div><h2>Стоимость: {scope === "task" ? "задача AA" : "полный набор AA"}</h2><p aria-live="polite">{visible.length} из {rows.length} вариантов · {countSubscriptions} подписок · {visible.length - countSubscriptions} API</p></div><button type="button" onClick={() => downloadCsv(sorted, scope)} disabled={!visible.length}><DownloadSimple size={17} />CSV выборки</button></div>
    <section className="aa-chart" aria-label="График стоимости"><PriceChart rows={visible} scope={scope} selectedId={selectedId} onSelect={chooseExample} /></section>
    <details ref={detailRef} className="aa-calculation" open={detailOpen} onToggle={event => setDetailOpen(event.currentTarget.open)}>
      <summary><Calculator size={19} /><span>Пошаговый расчёт выбранного варианта</span><CaretDown size={16} /></summary>
      <div className="aa-calculation-controls"><label>Модель · effort · тариф<select id="aa-example" value={selectedId} onChange={event => setSelectedId(event.target.value)}>{visible.map(row => <option key={row.id} value={row.id}>{row.model} · {effortLabel(row)} · {row.plan}</option>)}</select></label><label className="aa-exact"><input type="checkbox" checked={exact} onChange={event => setExact(event.target.checked)} />Полная точность</label></div>
      {example ? <Calculation row={example} scope={scope} exact={exact} estimate={reconstruction} /> : <p className="aa-empty">Нет варианта для расчёта. Измените фильтры.</p>}
    </details>
    <div className="aa-section-heading"><div><h2>Состав токенов и стоимость</h2><p>Доли и цены за миллион относятся к выбранному профилю: {scope === "task" ? "задача AA" : "полный набор AA"}.</p></div></div>
    <div className="aa-scroll aa-data-scroll"><table className="aa-data-table"><thead><tr><th>Модель / effort</th><th>Тариф / достоверность</th><th>Чтение кэша</th><th>Вход + запись кэша</th><th>Выход</th><th>API, $/MTok</th><th>Подписка, $/MTok</th><th>Квота / {unitName}</th><th>$ / {unitName}</th><th>Единиц / мес.</th><th>Единиц / $100</th><th>Подробности</th></tr></thead><tbody>{sorted.map(row => {
      const metric = row[scope] || {},approximate = metric.status === "approximate";
      return <tr key={row.id} className={row.id === selectedId ? "aa-selected-row" : ""}><td><b>{row.model}</b><small>{effortLabel(row)}</small><small title="Балл интеллекта показан для сравнения качества и не входит в формулу стоимости">Индекс AA: {row.estimated ? "≈ " : ""}{number(row.intelligence_index)}</small></td><td className="aa-plan-cell"><b>{row.plan}</b><small>{confidenceLabel(row.confidence)}</small>{!hasCost(metric) && <small>{statusNames[metric.status || "missing"]}</small>}</td>
        {[metric.cache_read_share, metric.input_without_cache_read_share, metric.output_share].map((value, index) => <td key={index} className="aa-numeric">{percent(value)}</td>)}
        <td className="aa-numeric">{money(metric.api_price_usd_per_million)}</td><td className="aa-numeric">{row.kind === "subscription" ? (approximate && finite(metric.effective_price_usd_per_million) ? "≈ " : "") + money(metric.effective_price_usd_per_million) : "—"}</td><td className="aa-numeric">{number(metric.quota_per_unit)}{row.quota_unit && <small>{row.quota_unit}</small>}</td><td className="aa-numeric"><b>{costLabel(row, scope)}</b></td><td className="aa-numeric">{number(metric.units_per_month)}</td><td className="aa-numeric">{number(metric.units_per_100_usd)}</td><td><button type="button" className="aa-detail-button" onClick={() => chooseExample(row)}>Разбор ↗</button><Sources urls={row.sources} /></td></tr>;
    })}{!sorted.length && <tr><td colSpan={12} className="aa-empty">Нет строк, соответствующих фильтрам.</td></tr>}</tbody></table></div>
    <p className="aa-footnote">Вход без чтения кэша включает обычный вход и запись кэша; выход — ответ и reasoning. Три доли суммируются в 100% до округления. API-цена и цена подписки рассчитаны на одной смеси AA. «Единиц / $100» — нормированная оценка; для подписки с месячной оплатой она не означает покупку доли тарифа.</p>
    <ExcludedPlans plans={data.quota_scenario.excluded || []} />
    <footer className="aa-footer"><span>Исходные числа и операции доступны в каждом разборе. CSV сохраняет числовую точность.</span><a href="/aa-archive/report.html">Предыдущие расчёты и оценка API ↗</a></footer>
  </main>;
}
