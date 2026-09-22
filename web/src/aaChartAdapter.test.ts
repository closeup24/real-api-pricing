import assert from "node:assert/strict";
import test from "node:test";
import { aaIsApproximate, aaMethodLabel, aaQuality, aaQualityLabel, aaReferencePoint, adaptAAChart, displayAAPlan } from "./aaChartAdapter";
import type { QuotaRow } from "./aaTypes";
import type { Point, SiteData } from "./types";

const nativePoint = (changes: Partial<Point> = {}): Point => ({
  id: "opencode_go::gpt-5.6-luna", plan_id: "opencode_go", plan: "OpenCode Go",
  model: "gpt-5.6-luna", model_display: "GPT 5.6 Luna", vendor: "OpenAI", channel: "OpenCode",
  label: "GPT 5.6 Luna · OpenCode Go", billing: "subscription", confidence: "high",
  price_usd: 10, original_price: 10, currency: "USD", monthly_yi: 20, monthly_tokens: 2_000_000_000,
  real_usd_per_mtok: .005, list_blended_usd_per_mtok: .012, source: "Исходный RAP", note: "", decision_note: "", evidence: [],
  ...changes,
});
const site = (points: Point[] = [nativePoint()]): SiteData => ({
  version: 1, generatedAt: "2026-09-22", points, configurations: [], mappings: [], boards: {},
  conventions: { usdPerCny: .14, monthWeeks: 4, exchangeRate: { date: "2026-09-22", source: "fixture", labelEn: "USD", labelZh: "USD" }, standardTokenMix: { cache: .975, input: .0215, output: .0035 }, lowCacheTokenMix: { cache: .85, input: .1465, output: .0035 } },
});
const quota = (changes: Partial<QuotaRow> = {}): QuotaRow => ({
  id: "luna-high::opencode_go", model_id: "gpt-5.6-luna", model: "GPT-5.6 Luna", effort: "high", effort_label: "High",
  plan_id: "opencode_go", pricing_id: "opencode_go::gpt-5.6-luna", plan: "OpenCode Go", kind: "subscription", confidence: "assumed",
  monthly_usd: 10, monthly_quota: 15, quota_unit: "USD", intelligence_index: 40,
  task: { cost_usd: .02, total_tokens: 100_000 }, suite: { cost_usd: 180, total_tokens: 50_000_000 },
  notes: ["Reasoning сопоставлен output."], sources: ["https://artificialanalysis.ai/"],
  ...changes,
});

test("разные effort сохраняются как отдельные точки одного тарифа", () => {
  const high = quota(), extra = quota({ id: "luna-extra::opencode_go", effort: "xhigh", effort_label: "Extra high", intelligence_index: 44 });
  const result = adaptAAChart([high, extra], "task", site());
  assert.equal(result.rows.length, 2);
  assert.equal(new Set(result.rows.map(row => row.point.id)).size, 2);
  assert.deepEqual(result.rows.map(row => row.mapping?.reasoning_effort), ["High", "Extra high"]);
  assert.deepEqual(result.rows.map(row => row.point.model_display), ["GPT-5.6 Luna · High", "GPT-5.6 Luna · Extra high"]);
  assert.equal(result.sourceRows.get(result.rows[1].point.id), extra);
  assert.notEqual(result.rows[0].mapping?.configuration_id, result.rows[1].mapping?.configuration_id);
});

test("ось графика использует выбранную стоимость задачи или набора, а не смесь RAP", () => {
  const row = quota(), data = site();
  const task = adaptAAChart([row], "task", data), suite = adaptAAChart([row], "suite", data);
  assert.equal(task.rows[0].point.real_usd_per_mtok, .02);
  assert.equal(suite.rows[0].point.real_usd_per_mtok, 180);
  assert.equal(task.rows[0].point.monthly_tokens, null);
  assert.equal(task.rows[0].point.list_blended_usd_per_mtok, null);
  assert.equal(task.sourceRows.get(task.rows[0].point.id)?.task?.total_tokens, 100_000);
});

test("неизвестные и отрицательные цены, а также неизвестный индекс не превращаются в нулевые точки", () => {
  const rows = [quota({ id: "missing", task: { cost_usd: null } }), quota({ id: "negative", task: { cost_usd: -1 } }), quota({ id: "infinite", task: { cost_usd: Infinity } }), quota({ id: "no-score", intelligence_index: null })];
  const result = adaptAAChart(rows, "task", site());
  assert.equal(result.rows.length, 0);
  assert.equal(result.sourceRows.size, rows.length);
  assert.deepEqual([...result.sourceRows.values()], rows);
});

test("источники AA и RAP остаются неизменными после адаптации", () => {
  const rows = [quota()], data = site(), before = JSON.stringify({ rows, data });
  const result = adaptAAChart(rows, "suite", data);
  result.rows[0].point.real_usd_per_mtok = 999;
  result.rows[0].mapping!.reasoning_effort = "изменено только на графике";
  assert.equal(JSON.stringify({ rows, data }), before);
});

test("сторонняя подписка использует канал OpenCode и производителя OpenAI", () => {
  const result = adaptAAChart([quota()], "task", site());
  assert.equal(result.rows[0].point.channel, "OpenCode");
  assert.equal(result.rows[0].point.vendor, "OpenAI");
  assert.equal(result.rows[0].point.billing, "subscription");
});

test("API не наследует канал сторонней подписки при отсутствии API в RAP", () => {
  const row = quota({ id: "api-luna", pricing_id: undefined, kind: "api", plan_id: "api-aa", plan: "API AA", monthly_usd: null });
  assert.equal(aaReferencePoint(row, site())?.channel, "OpenAI");
  const result = adaptAAChart([row], "task", site());
  assert.equal(result.rows[0].point.channel, "OpenAI");
  assert.equal(result.rows[0].point.vendor, "OpenAI");
  assert.equal(result.rows[0].point.billing, "metered");
});

test("без точного pricing_id оформление канала берётся по тарифу, а производитель по модели", () => {
  const row = quota({ model_id: "gpt-6-astra", model: "GPT-6 Astra", pricing_id: "missing" });
  const data = site([nativePoint(), nativePoint({ id: "astra-api", model: "gpt-6-astra", plan_id: "openai_api", vendor: "OpenAI", channel: "OpenAI", billing: "metered" })]);
  const result = adaptAAChart([row], "task", data);
  assert.equal(result.rows[0].point.channel, "OpenCode");
  assert.equal(result.rows[0].point.vendor, "OpenAI");
  assert.equal(aaReferencePoint(row, data)?.channel, "OpenCode");
});

test("тариф без ставок остаётся доступным для таблицы, но не становится точкой", () => {
  const missing = quota({ id: "unknown-rates", method: "unavailable_quota_weights", status: "unavailable", task: { status: "unavailable", cost_usd: null, component_tokens: { answer: 1000 } }, suite: { status: "unavailable", cost_usd: null } });
  const priced = quota({ method: "aa_tokens_quota_rates" });
  for (const scope of ["task", "suite"] as const) {
    const result = adaptAAChart([missing, priced], scope, site());
    assert.equal(result.rows.length, 1);
    assert.equal(result.sourceRows.size, 2);
    assert.equal(result.sourceRows.get("aa::unknown-rates"), missing);
    assert.equal(result.rows[0].point.id, `aa::${priced.id}`);
  }
  assert.equal(aaMethodLabel(missing.method), "Нет ставок списания");
  assert.equal(missing.task?.component_tokens?.answer, 1000);
});

test("недоступный статус защищает график даже от случайно сохранённой числовой цены", () => {
  const unknown = quota({ method: "unavailable_quota_weights" });
  const unavailable = quota({ id: "unavailable", method: "aa_tokens_quota_rates", task: { status: "unavailable", cost_usd: .1 } });
  const result = adaptAAChart([unknown, unavailable], "task", site());
  assert.equal(result.rows.length, 0);
  assert.equal(result.sourceRows.size, 2);
});

test("подсказка AA называет основание расчёта и сохраняет effort", () => {
  const calibration = quota({ id: "calibration", method: "empirical_api_calibration", evidence_method: "direct_measurement" });
  const native = quota({ id: "native", method: "aa_tokens_quota_rates" });
  const result = adaptAAChart([calibration, native], "task", site());
  assert.equal(result.rows[0].mapping?.variant, "High");
  assert.equal(result.rows[0].point.cost_assessment?.category, "Калибровка по замеру");
  assert.equal(result.rows[0].point.cost_assessment?.score, 65);
  assert.equal(result.rows[1].point.cost_assessment?.category, "Квота и ставки списания");
  assert.equal(result.rows[1].point.cost_assessment?.score, 70);
  assert.equal(result.rows[0].mapping?.reasoning_effort, "High");
  assert.equal(result.rows[0].point.real_usd_per_mtok, calibration.task?.cost_usd);
  assert.equal(result.rows[1].point.real_usd_per_mtok, native.task?.cost_usd);
});

test("явная надёжность AA имеет приоритет над исторической confidence", () => {
  const row = quota({ confidence: "source", quality: { level: "low", reasons: ["Неполный смешанный замер."], label: "Условный сценарий" } });
  const result = adaptAAChart([row], "task", site());
  assert.deepEqual(aaQuality(row), row.quality);
  assert.equal(result.rows[0].point.confidence, "low");
  assert.equal(result.rows[0].mapping?.mapping_confidence, "low");
  assert.match(result.rows[0].point.note, /Неполный смешанный замер/);
  assert.ok(result.rows[0].point.cost_assessment?.reasons.includes("Неполный смешанный замер."));
  assert.equal(row.confidence, "source");
});

test("старые срезы сохраняют четыре уровня надёжности через confidence", () => {
  for (const [confidence, level, label] of [["source", "high", "Высокая"], ["documented", "high", "Высокая"], ["assumed", "medium", "Средняя"], ["low", "low", "Низкая"], ["unavailable", "unavailable", "Нет данных"]]) {
    assert.equal(aaQuality(quota({ confidence })).level, level);
    assert.equal(aaQualityLabel(level), label);
  }
  assert.equal(aaQuality(quota({ confidence: "documented", method: "unavailable_quota_weights" })).level, "unavailable");
});

test("приблизительный сценарий с низкой надёжностью остаётся на обоих графиках с явной отметкой", () => {
  const row = quota({ method: "empirical_api_scenario", quality: { level: "low", reasons: ["API-веса списания предположены."] } });
  for (const scope of ["task", "suite"] as const) {
    const result = adaptAAChart([row], scope, site());
    assert.equal(result.rows.length, 1);
    assert.equal(result.sourceRows.get(`aa::${row.id}`), row);
    assert.equal(result.rows[0].point.real_usd_per_mtok, row[scope]?.cost_usd);
    assert.match(result.rows[0].point.model_display, /^≈ /);
    assert.equal(result.rows[0].point.cost_assessment?.category, "Приблизительный сценарий");
    assert.equal(result.rows[0].point.cost_assessment?.score, 35);
    assert.equal(aaIsApproximate(row, scope), true);
  }
  assert.equal(aaIsApproximate(quota({ task: { cost_usd: null }, quality: row.quality }), "task"), false);
});

const transferRow = (): QuotaRow => quota({
  id: "opus55-max::claude_max_20x", model_id: "claude-opus-5.5", model: "Claude Opus 5.5", effort: "max", effort_label: "Max",
  aa_retrieved_at: "2026-09-23T08:00:00Z",
  method: "empirical_model_transfer", evidence_method: "model_transfer", plan: "Claude Max 20x (9/14+)",
  plan_id: "claude_max_20x", pricing_id: "claude_max_20x::claude-opus-5.5", monthly_quota: 4000,
  quality: { level: "medium", reasons: ["Ёмкость перенесена с Opus 5."] },
  empirical: {
    basis_label: "Гипотеза равной ёмкости", reason_ru: "Токены и API-ставки AA относятся к Opus 5.5.",
    transfer: {
      source_pricing_id: "claude_max_20x::claude-opus-5", source_model_id: "claude-opus-5", source_model_name: "Claude Opus 5",
      source_plan: "Claude Max 20x (9/14+)", monthly_api_equivalent_usd: 4000,
      source_quality: { level: "low", reasons: ["Неполная разбивка исходного замера."] }, assumption_ru: "P(Opus 5.5) = P(Opus 5).", confidence: "medium",
      source_method: "empirical_api_scenario", source_empirical: { basis_label: "Замер Opus 5", reason_ru: "Исходный сценарий.", calibration: { observed_api_usd: 200, quota_fraction: .2, periods_per_month: 4, plan_multiplier: 1, monthly_api_equivalent_usd: 4000 } },
    },
  },
});

test("перенос между моделями получает общую метку надёжности и сохраняет собственную цену AA", () => {
  const row = transferRow(), before = JSON.stringify(row);
  assert.equal(aaMethodLabel(row.method), "Перенос квоты между моделями");
  assert.equal(row.empirical?.calibration, undefined);
  for (const scope of ["task", "suite"] as const) {
    const result = adaptAAChart([row], scope, site([]));
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].point.real_usd_per_mtok, row[scope]?.cost_usd);
    assert.equal(result.rows[0].point.vendor, "Anthropic");
    assert.equal(result.rows[0].point.confidence, "low");
    assert.equal(result.rows[0].point.cost_assessment?.category, "Перенос между моделями");
    assert.equal(result.rows[0].point.cost_assessment?.score, 25);
    assert.equal(result.rows[0].mapping?.variant, "Max");
    assert.match(result.rows[0].point.model_display, /^≈ Claude Opus 5\.5 · Max$/);
    assert.equal(result.sourceRows.get(`aa::${row.id}`), row);
  }
  assert.equal(JSON.stringify(row), before);
});

test("надёжность переноса не повышает слабый источник и ограничена средней", () => {
  for (const [sourceLevel, expected] of [["high", "medium"], ["medium", "medium"], ["low", "low"], ["unavailable", "unavailable"]] as const) {
    const row = transferRow();
    row.quality = { level: "high", reasons: [] };
    row.empirical!.transfer!.source_quality = { level: sourceLevel, reasons: ["Основание исходной квоты."] };
    assert.equal(aaQuality(row).level, expected);
  }
  const alreadyLow = transferRow();
  alreadyLow.quality = { level: "low", reasons: ["Дополнительное ограничение AA."] };
  alreadyLow.empirical!.transfer!.source_quality.level = "high";
  assert.equal(aaQuality(alreadyLow).level, "low");
});

test("дата тарифа AA читаема на графике, исходные имена и связи сохраняются", () => {
  assert.equal(displayAAPlan("Claude Max 20x (9/14+)"), "Claude Max 20x (с 14 сентября 2026)");
  assert.equal(displayAAPlan("Claude Max 5x (9/14+)"), "Claude Max 5x (с 14 сентября 2026)");
  assert.equal(displayAAPlan("Claude Pro"), "Claude Pro");
  const row = transferRow(), result = adaptAAChart([row], "task", site([]));
  assert.equal(result.rows[0].point.plan, "Claude Max 20x (с 14 сентября 2026)");
  assert.match(result.rows[0].point.label, /с 14 сентября 2026/);
  assert.equal(result.rows[0].point.plan_id, "claude_max_20x");
  assert.equal(row.plan, "Claude Max 20x (9/14+)");
  assert.equal(row.empirical?.transfer?.source_plan, "Claude Max 20x (9/14+)");
  assert.equal(result.sourceRows.get(`aa::${row.id}`)?.pricing_id, row.pricing_id);
  assert.equal(result.sourceRows.get(`aa::${row.id}`)?.aa_retrieved_at, "2026-09-23T08:00:00Z");
});

test("новая модель вне RAP получает производителя и канал в таблице без подмены моделью источника", () => {
  const source = nativePoint({ id: "claude_max_20x::claude-opus-5", model: "claude-opus-5", model_display: "Claude Opus 5", vendor: "Anthropic", channel: "Anthropic", plan_id: "claude_max_20x" });
  const upstream = site([source]);
  const subscription = transferRow();
  const api = { ...subscription, id: "opus55-api", pricing_id: undefined, kind: "api" as const, plan_id: "api-aa", plan: "API AA" };
  for (const row of [subscription, api]) {
    for (const data of [upstream, site([])]) {
      const display = aaReferencePoint(row, data), chart = adaptAAChart([row], "task", data).rows[0].point;
      assert.equal(display.vendor, "Anthropic");
      assert.equal(display.channel, "Anthropic");
      assert.equal(display.vendor, chart.vendor);
      assert.equal(display.channel, chart.channel);
      assert.equal(display.model, "claude-opus-5.5");
      assert.equal(display.model_display, "Claude Opus 5.5 · Max");
      assert.equal(display.id, `aa::${row.id}`);
      assert.equal(display.source, row.sources?.join("\n"));
      assert.equal(Number.isNaN(display.real_usd_per_mtok), true);
      assert.equal(display.monthly_tokens, null);
      assert.notEqual(display.id, source.id);
    }
  }
});
