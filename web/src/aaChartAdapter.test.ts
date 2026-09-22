import assert from "node:assert/strict";
import test from "node:test";
import { aaMethodLabel, aaReferencePoint, adaptAAChart } from "./aaChartAdapter";
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
  const calibration = quota({ id: "calibration", method: "empirical_api_calibration" });
  const native = quota({ id: "native", method: "aa_tokens_quota_rates" });
  const result = adaptAAChart([calibration, native], "task", site());
  assert.equal(result.rows[0].mapping?.variant, "High · Метод: API-калибровка");
  assert.equal(result.rows[1].mapping?.variant, "High · Метод: Квота × ставки");
  assert.equal(result.rows[0].mapping?.reasoning_effort, "High");
  assert.equal(result.rows[0].point.real_usd_per_mtok, calibration.task?.cost_usd);
  assert.equal(result.rows[1].point.real_usd_per_mtok, native.task?.cost_usd);
});
