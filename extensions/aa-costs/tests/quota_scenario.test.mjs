import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildQuotaScenario, pricingRowsSha256 } from '../scripts/quota_scenario.mjs';
import { buildExpandedQuotaScenario } from '../scripts/empirical_scenario.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

function fixture() {
  const task = {nonCacheInput: 0.2, cacheRead: 0.1, cacheWrite: 0.25, answer: 0.1, reasoning: 0.4, input: 0.55, output: 0.5, total: 1.05};
  const variant = {
    model: 'sample', model_display: 'Модель', source_id: 'sample-max', source_name: 'Модель max', effort: 'max', effort_level: 60,
    source: 'https://example.com/aa/sample', source_version: 'test', intelligence_index: 50, intelligence_index_estimated: false,
    api_price_input_usd_per_million: 2, api_price_cache_hit_usd_per_million: 0.2,
    api_price_cache_write_usd_per_million: 2.5, api_price_output_usd_per_million: 10,
    api_price_reasoning_usd_per_million: 10,
    cost_per_task_usd: 1.05, cost_total_usd: 10.5, cost_per_task_components_usd: task,
    cost_total_components_usd: Object.fromEntries(Object.entries(task).map(([key, value]) => [key, value * 10])),
    intelligence_index_output_tokens_per_task: {answer: 10000, reasoning: 40000, output: 50000},
    canonical_intelligence_index_token_count: {input: 7000000, answer: 100000, reasoning: 400000, output: 500000},
    quality_flags: [],
  };
  const aa = {metadata: {intelligence_index_version: 'test', retrieved_at: '2026-09-22'}, rows: [variant]};
  const pricing = {
    revision: 'test-revision', retrieved_at_utc: '2026-09-22', standard_token_mix: {cache: 0.975, input: 0.0215, output: 0.0035},
    rows: [{id: 'plan::sample', model: 'sample', plan: 'Подписка', plan_id: 'plan', billing: 'subscription', monthly_usd: 20, monthly_tokens: 999999999, real_price_usd_per_million: 0.01}],
  };
  const rates = {
    metadata: {pricing_revision: pricing.revision, pricing_retrieved_at_utc: pricing.retrieved_at_utc, pricing_rows_sha256: pricingRowsSha256(pricing)},
    rows: [{id: 'plan::sample', model_id: 'sample', plan: 'Подписка', monthly_usd: 20, monthly_quota: 100, quota_unit: 'credits', status: 'documented',
      component_rates: {non_cache_input: 3, cache_read: 0.1, cache_write: 5, answer: 12, reasoning: 20},
      source_urls: ['https://example.com/plan'], assumptions_ru: [], notes_ru: [], original_quota: {period: 'month', amount: 100, periods_per_month: 1}}],
  };
  return {aa, pricing, rates};
}

function calculate(data) { return buildQuotaScenario(data.aa, data.pricing, data.rates); }
function subscription(data) { return calculate(data).rows.find(row => row.kind === 'subscription'); }
function rebind(data) { data.rates.metadata.pricing_rows_sha256 = pricingRowsSha256(data.pricing); }

test('Кредиты оплачивают пять категорий AA: запись кеша и reasoning учитываются отдельно', () => {
  const data = fixture();
  const row = subscription(data);
  assert.equal(row.status, 'consistent');
  assert.equal(row.task.total_tokens, 750000);
  assert.deepEqual(row.task.component_tokens, {non_cache_input: 100000, cache_read: 500000, cache_write: 100000, answer: 10000, reasoning: 40000});
  close(row.task.component_quota.cache_write, 0.5);
  close(row.task.component_quota.reasoning, 0.8);
  close(row.task.quota_per_unit, 1.77);
  close(row.task.cost_usd, 0.354);
  close(row.task.effective_price_usd_per_million, 0.472);
  close(row.task.units_per_month, 100 / 1.77);
  close(row.task.units_per_100_usd, 100 / 0.354);
  close(row.task.cache_read_share + row.task.input_without_cache_read_share + row.task.output_share, 1);
  assert.equal(row.suite.total_tokens, 7500000);
  close(row.suite.quota_per_unit, 17.7);
  close(row.suite.cost_usd, 3.54);
});

test('Изменение платы меняет цену, но не расход кредитов и месячную ёмкость', () => {
  const data = fixture();
  const before = subscription(data);
  data.pricing.rows[0].monthly_usd = data.rates.rows[0].monthly_usd = 40;
  rebind(data);
  const after = subscription(data);
  close(after.task.cost_usd, before.task.cost_usd * 2);
  close(after.task.quota_per_unit, before.task.quota_per_unit);
  close(after.task.units_per_month, before.task.units_per_month);
});

test('Смесь RAP, готовая token-ёмкость и смешанные цены не участвуют в формулах', () => {
  const data = fixture();
  const before = subscription(data);
  data.pricing.standard_token_mix = {cache: 0, input: 0, output: 1};
  data.pricing.rows[0].monthly_tokens = 1;
  data.pricing.rows[0].real_price_usd_per_million = 999;
  data.pricing.rows[0].api_price_usd_per_million = 999;
  rebind(data);
  const after = subscription(data);
  assert.deepEqual(after.task, before.task);
  assert.deepEqual(after.suite, before.suite);
});

test('Отсутствующий и устаревший снимки закрывают только пересчёт подписок', () => {
  for (const field of ['pricing_revision', 'pricing_retrieved_at_utc', 'pricing_rows_sha256']) {
    const data = fixture();
    data.rates.metadata[field] = 'stale';
    const result = calculate(data);
    assert.equal(result.metadata.status, 'stale_snapshot');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].kind, 'api');
    assert.equal(result.rows[0].task.cost_usd, 1.05);
    assert.equal(result.plans[0].included, false);
    assert.equal(result.excluded.length, 1);
  }
  const data = fixture();
  data.rates = null;
  assert.equal(calculate(data).metadata.status, 'missing_rates');
  assert.equal(calculate(data).rows.length, 1);
});

test('Неизвестные ставки не становятся нулём; документированная нулевая ставка допустима', () => {
  for (const value of [null, undefined, -1, NaN, Infinity]) {
    const data = fixture();
    data.rates.rows[0].component_rates.cache_read = value;
    const result = calculate(data);
    assert.equal(result.rows.filter(row => row.kind === 'subscription').length, 0);
    assert.equal(result.plans[0].component_rates.cache_read, null);
    assert.ok(result.excluded[0].reasons.some(reason => reason.includes('cache_read')));
  }
  const freeRead = fixture();
  freeRead.rates.rows[0].component_rates.cache_read = 0;
  assert.equal(subscription(freeRead).task.component_tokens.cache_read, 500000);
  assert.equal(subscription(freeRead).task.component_quota.cache_read, 0);
  close(subscription(freeRead).task.quota_per_unit, 1.72);
  freeRead.rates.rows[0].status = 'assumed';
  assert.equal(calculate(freeRead).metadata.included_plans, 0);
});

test('Нулевой тариф AA не позволяет восстановить токены через 0/0', () => {
  const data = fixture();
  data.aa.rows[0].api_price_cache_hit_usd_per_million = 0;
  data.aa.rows[0].cost_per_task_components_usd.cacheRead = 0;
  const row = subscription(data);
  assert.equal(row.task.status, 'unavailable');
  assert.equal(row.task.component_tokens.cache_read, null);
  assert.equal(row.task.cost_usd, null);
  assert.equal(row.task.units_per_month, null);
  assert.equal(calculate(data).rows.find(row => row.kind === 'api').task.cost_usd, 1.05);
});

test('При отсутствии AA расходов effort остаётся в таблице с неизвестными результатами', () => {
  const data = fixture();
  Object.assign(data.aa.rows[0], {cost_per_task_usd: null, cost_total_usd: null, cost_per_task_components_usd: null, cost_total_components_usd: null});
  const result = calculate(data);
  assert.equal(result.rows.length, 2);
  const row = result.rows.find(row => row.kind === 'subscription');
  assert.equal(row.status, 'missing');
  for (const scope of ['task', 'suite']) {
    assert.equal(row[scope].cost_usd, null);
    assert.equal(row[scope].quota_per_unit, null);
    assert.equal(row[scope].total_tokens, null);
  }
});

test('Нулевая исходная API-стоимость сохраняется и не превращается в бесплатную бесконечную подписку', () => {
  const data = fixture();
  const variant = data.aa.rows[0];
  variant.cost_per_task_usd = 0;
  variant.cost_per_task_components_usd = Object.fromEntries(Object.keys(variant.cost_per_task_components_usd).map(key => [key, 0]));
  variant.intelligence_index_output_tokens_per_task = {answer: 0, reasoning: 0, output: 0};
  const result = calculate(data);
  const api = result.rows.find(row => row.kind === 'api');
  const plan = result.rows.find(row => row.kind === 'subscription');
  assert.equal(api.task.cost_usd, 0);
  assert.equal(api.task.units_per_100_usd, null);
  assert.equal(plan.task.cost_usd, null);
  assert.equal(plan.task.quota_per_unit, null);
  assert.equal(plan.task.units_per_month, null);
});

test('Fable: квота использует инвертированные категории, а не принудительную нормировку по опубликованной сумме', async () => {
  const aa = JSON.parse(await readFile(new URL('../data/aa/aa.json', import.meta.url), 'utf8'));
  const variant = aa.rows.find(row => row.model === 'claude-fable-5.1' && row.effort === 'max');
  const data = fixture();
  data.aa.rows = [variant];
  data.pricing.rows[0].model = data.rates.rows[0].model_id = variant.model;
  rebind(data);
  const result = calculate(data);
  const row = result.rows.find(row => row.kind === 'subscription');
  assert.equal(row.task.status, 'approximate');
  assert.equal(row.suite.status, 'approximate');
  assert.notEqual(row.suite.total_tokens, row.suite.reported_total_tokens);
  close(row.suite.total_tokens, Object.values(row.suite.component_tokens).reduce((sum, value) => sum + value, 0));
  const expectedUsage = Object.entries(row.suite.component_tokens).reduce((sum, [key, tokens]) => sum + tokens * data.rates.rows[0].component_rates[key] / 1e6, 0);
  close(row.suite.quota_per_unit, expectedUsage);
  assert.equal(result.rows.find(row => row.kind === 'api').suite.cost_usd, variant.cost_total_usd);
});

test('GLM peak/offpeak: тот же пул и вдвое меньшие ставки дают вдвое больше задач', () => {
  const data = fixture();
  const peak = data.pricing.rows[0];
  peak.model = data.aa.rows[0].model = data.rates.rows[0].model_id = 'glm-5.3-flash';
  peak.id = 'glm_peak::glm-5.3-flash';
  data.rates.rows[0].id = peak.id;
  data.rates.rows[0].monthly_quota = 16000;
  data.rates.rows[0].component_rates = {non_cache_input: 230, cache_read: 56, cache_write: 230, answer: 800, reasoning: 800};
  data.rates.rows[0].status = 'assumed';
  const offpeak = {...peak, id: 'glm_offpeak::glm-5.3-flash', plan: 'GLM offpeak'};
  data.pricing.rows.push(offpeak);
  data.rates.rows.push({...data.rates.rows[0], id: offpeak.id, plan: offpeak.plan, component_rates: Object.fromEntries(Object.entries(data.rates.rows[0].component_rates).map(([key, rate]) => [key, rate / 2]))});
  rebind(data);
  const rows = calculate(data).rows.filter(row => row.kind === 'subscription');
  assert.equal(rows[0].monthly_quota, rows[1].monthly_quota);
  close(rows[1].task.quota_per_unit, rows[0].task.quota_per_unit / 2);
  close(rows[1].task.cost_usd, rows[0].task.cost_usd / 2);
  close(rows[1].task.units_per_month, rows[0].task.units_per_month * 2);
  assert.equal(rows[0].confidence, 'assumed');
  assert.equal(rows[0].task.status, 'approximate');
});

test('GLM V2: девять старых тарифов сохраняются без цены, подтверждённые квоты V3 не меняются', async () => {
  const [aa, pricing, rates] = await Promise.all(['aa/aa.json', 'pricing/pricing.json', 'pricing/quota-rates.json'].map(async path => JSON.parse(await readFile(new URL(`../data/${path}`, import.meta.url), 'utf8'))));
  const oldRates = rates.rows.filter(rate => rate.id.includes('_old_'));
  const newRates = rates.rows.filter(rate => rate.id.includes('_new_'));
  assert.equal(oldRates.length, 9);
  assert.equal(newRates.length, 9);
  const result = buildQuotaScenario(aa, pricing, rates);
  for (const rate of oldRates) {
    assert.equal(rate.status, 'unavailable');
    assert.equal(rate.monthly_quota, null);
    assert.equal(rate.original_quota, null);
    assert.ok(Object.values(rate.component_rates).every(value => value === null));
    assert.match(rate.unavailable_reason_ru, /V2.*V3/);
    assert.equal(result.plans.find(plan => plan.id === rate.id).included, false);
    assert.match(result.excluded.find(plan => plan.id === rate.id).reasons.join(' '), /V2.*V3/);
    assert.ok(!result.rows.some(row => row.pricing_id === rate.id));
  }
  for (const rate of newRates) {
    const tier = rate.id.match(/glm_coding_(lite|pro|max)_/)[1];
    assert.equal(rate.monthly_quota, {lite: 40000, pro: 240000, max: 560000}[tier]);
    assert.equal(rate.status, 'assumed');
    const row = result.rows.find(item => item.pricing_id === rate.id);
    assert.ok(row.task.cost_usd > 0);
    const expectedQuota = Object.entries(row.task.component_tokens).reduce((sum, [key, tokens]) => sum + tokens * rate.component_rates[key] / 1e6, 0);
    close(row.task.cost_usd, rate.monthly_usd * expectedQuota / rate.monthly_quota);
  }
  const retained = buildExpandedQuotaScenario(aa, pricing, rates, null).rows.filter(row => row.pricing_id?.includes('_old_'));
  assert.equal(retained.length, oldRates.length * aa.rows.filter(row => row.model === 'glm-5.3-flash').length);
  for (const row of retained) {
    assert.equal(row.status, 'unavailable');
    assert.equal(row.monthly_quota, null);
    for (const scope of ['task', 'suite']) {
      assert.equal(row[scope].cost_usd, null);
      assert.equal(row[scope].units_per_month, null);
      assert.equal(row[scope].units_per_100_usd, null);
    }
  }
});

test('Дубли ставок, чужая модель и несогласованная плата не проходят соединение', () => {
  const duplicate = fixture();
  duplicate.rates.rows.push(structuredClone(duplicate.rates.rows[0]));
  assert.equal(calculate(duplicate).metadata.status, 'invalid_rates');
  assert.equal(calculate(duplicate).metadata.included_plans, 0);
  for (const [key, value] of [['model_id', 'other-model'], ['monthly_usd', 0]]) {
    const data = fixture();
    data.rates.rows[0][key] = value;
    assert.equal(calculate(data).metadata.included_plans, 0);
  }
});

test('Нулевой расход не превращается в бесконечную ёмкость, входные объекты не меняются', () => {
  const data = fixture();
  data.rates.rows[0].component_rates = Object.fromEntries(Object.keys(data.rates.rows[0].component_rates).map(key => [key, 0]));
  const before = structuredClone(data);
  const row = subscription(data);
  assert.equal(row.task.quota_per_unit, 0);
  assert.equal(row.task.cost_usd, 0);
  assert.equal(row.task.units_per_month, null);
  assert.equal(row.task.units_per_100_usd, null);
  assert.deepEqual(data, before);
  assert.ok(!JSON.stringify(calculate(data)).includes('Infinity'));
});

test('Реальный снимок: каждый допущенный тариф соединён только со своей моделью, API расходы сохранены', async () => {
  const [aa, pricing, rates] = await Promise.all(['aa/aa.json', 'pricing/pricing.json', 'pricing/quota-rates.json'].map(async path => JSON.parse(await readFile(new URL(`../data/${path}`, import.meta.url), 'utf8'))));
  const result = buildQuotaScenario(aa, pricing, rates);
  assert.equal(result.metadata.status, 'ok');
  assert.equal(result.metadata.included_plans, rates.rows.filter(rate => ['documented', 'assumed'].includes(rate.status)).length);
  const subscriptionRows = result.rows.filter(row => row.kind === 'subscription');
  assert.equal(subscriptionRows.length, rates.rows.filter(rate => ['documented', 'assumed'].includes(rate.status)).reduce((count, rate) => count + aa.rows.filter(variant => variant.model === rate.model_id).length, 0));
  for (const row of subscriptionRows) {
    const rate = rates.rows.find(rate => rate.id === row.pricing_id);
    assert.equal(row.model_id, rate.model_id);
    for (const scope of ['task', 'suite']) {
      const metric = row[scope];
      if (metric.cost_usd === null) continue;
      const quota = Object.entries(metric.component_tokens).reduce((sum, [key, count]) => sum + count * rate.component_rates[key] / 1e6, 0);
      close(metric.quota_per_unit, quota);
      close(metric.cost_usd, rate.monthly_usd * quota / rate.monthly_quota);
      assert.ok(Number.isFinite(metric.effective_price_usd_per_million));
    }
  }
  for (const row of result.rows.filter(row => row.kind === 'api')) {
    const variant = aa.rows.find(variant => variant.source_id === row.source_id);
    assert.equal(row.task.cost_usd, variant.cost_per_task_usd);
    assert.equal(row.suite.cost_usd, variant.cost_total_usd);
  }
});
