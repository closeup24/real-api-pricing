import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildExpandedQuotaScenario } from '../scripts/empirical_scenario.mjs';
import { buildQuotaScenario, pricingRowsSha256 } from '../scripts/quota_scenario.mjs';

const close = (actual, expected) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(1e-10, Math.abs(expected) * 1e-10),
  `${actual} != ${expected}`,
);

function variant(sourceId, effort, scale = 1, model = 'sample', rateScale = 1) {
  const components = { nonCacheInput: .2, cacheRead: .1, cacheWrite: .25, answer: .1, reasoning: .4, input: .55, output: .5, total: 1.05 };
  const costs = Object.fromEntries(Object.entries(components).map(([key, value]) => [key, value * scale * rateScale]));
  return {
    model, model_display: 'Тестовая модель', source_id: sourceId, source_name: `Тестовая модель ${effort}`,
    effort, effort_level: effort === 'high' ? 40 : 60,
    source: `https://example.com/aa/${sourceId}`, source_version: 'test', intelligence_index: 50,
    intelligence_index_estimated: false,
    api_price_input_usd_per_million: 2 * rateScale,
    api_price_cache_hit_usd_per_million: .2 * rateScale,
    api_price_cache_write_usd_per_million: 2.5 * rateScale,
    api_price_output_usd_per_million: 10 * rateScale,
    api_price_reasoning_usd_per_million: 10 * rateScale,
    cost_per_task_usd: 1.05 * scale * rateScale, cost_total_usd: 10.5 * scale * rateScale,
    cost_per_task_components_usd: costs,
    cost_total_components_usd: Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, value * 10])),
    intelligence_index_output_tokens_per_task: { answer: 10_000 * scale, reasoning: 40_000 * scale, output: 50_000 * scale },
    canonical_intelligence_index_token_count: { input: 7_000_000 * scale, answer: 100_000 * scale, reasoning: 400_000 * scale, output: 500_000 * scale },
    quality_flags: [],
  };
}

function fixture(method = 'empirical_api_calibration') {
  const aa = { metadata: { intelligence_index_version: 'test', retrieved_at: '2026-09-22' }, rows: [
    variant('sample-high', 'high'), variant('sample-max', 'max', 2),
    variant('other-max', 'max', 3, 'other', 10),
  ] };
  const native = { id: 'native::sample', model: 'sample', model_display: 'Тестовая модель', plan_id: 'native', plan: 'Кредитный тариф', billing: 'subscription', monthly_usd: 10, monthly_tokens: 999_000_000, real_price_usd_per_million: .0001 };
  const observed = { ...native, id: 'observed::sample', plan_id: 'observed', plan: 'Измеренный тариф', monthly_usd: 20, monthly_tokens: 2_000_000, workload: 'measured' };
  const pricing = { revision: 'fixture-revision', retrieved_at_utc: '2026-09-22', standard_token_mix: { cache: .975, input: .0215, output: .0035 }, rows: [native, observed] };
  const metadata = { pricing_revision: pricing.revision, pricing_retrieved_at_utc: pricing.retrieved_at_utc, pricing_rows_sha256: pricingRowsSha256(pricing) };
  const rates = { metadata: { ...metadata }, rows: [{
    id: native.id, model_id: native.model, plan: native.plan, monthly_usd: native.monthly_usd,
    monthly_quota: 100, quota_unit: 'credits', status: 'documented',
    component_rates: { non_cache_input: 3, cache_read: .1, cache_write: 5, answer: 12, reasoning: 20 },
    source_urls: ['https://example.com/native'], assumptions_ru: [], notes_ru: [],
  }] };
  const evidence = { metadata: { ...metadata, source_revision: 'empirical-source' }, additional_plans: [], rows: [{
    id: observed.id, model_id: observed.model, monthly_usd: observed.monthly_usd, monthly_tokens: observed.monthly_tokens,
    method, evidence_method: 'direct_measurement', basis_label: 'Замер токенов и процента квоты',
    reason_ru: 'Наблюдение отделено от условий переноса на AA.', source_urls: ['https://example.com/measurement'], notes_ru: [],
    calibration: { observed_api_usd: 28, quota_fraction: .25, periods_per_month: 4, plan_multiplier: 2 },
  }] };
  return { aa, pricing, rates, evidence };
}

const calculate = data => buildExpandedQuotaScenario(data.aa, data.pricing, data.rates, data.evidence);
const empiricalRows = result => result.rows.filter(row => row.kind === 'subscription' && row.method.startsWith('empirical_'));
const observedRow = (result, effort = 'high') => empiricalRows(result).find(row => row.effort === effort);
function rebind(data) {
  const hash = pricingRowsSha256(data.pricing);
  data.evidence.metadata.pricing_rows_sha256 = hash;
  data.rates.metadata.pricing_rows_sha256 = hash;
}

test('API-калибровка: полный образец, доля квоты, четыре недели и множитель тарифа дают стоимость задачи', () => {
  const data = fixture();
  // Образец: 2M входа, 10M чтения, 4M записи, 0.5M ответа и 0.7M reasoning.
  const observedApiUsd = 2 * 2 + 10 * .2 + 4 * 2.5 + .5 * 10 + .7 * 10;
  assert.equal(observedApiUsd, data.evidence.rows[0].calibration.observed_api_usd);
  const row = observedRow(calculate(data));
  const monthlyApiEquivalent = observedApiUsd / .25 * 4 * 2;
  assert.equal(monthlyApiEquivalent, 896);
  close(row.monthly_quota, monthlyApiEquivalent);
  assert.equal(row.method, 'empirical_api_calibration');
  assert.equal(row.evidence_method, 'direct_measurement');
  assert.equal(row.confidence, 'assumed');
  assert.equal(row.task.status, 'approximate');
  assert.deepEqual(row.task.component_tokens, { non_cache_input: 100_000, cache_read: 500_000, cache_write: 100_000, answer: 10_000, reasoning: 40_000 });
  close(row.task.quota_per_unit, .2 + .1 + .25 + .1 + .4);
  close(row.task.cost_usd, 20 * .25 * 1.05 / (observedApiUsd * 4 * 2));
  close(row.task.units_per_month, monthlyApiEquivalent / 1.05);
  close(row.task.units_per_100_usd, 100 / row.task.cost_usd);
  close(row.task.effective_price_usd_per_million, row.task.cost_usd / 750_000 * 1e6);
  close(row.suite.cost_usd, row.task.cost_usd * 10);
});

test('Наблюдённая токенная ёмкость переносится без скрытых API-весов и применяется ко всем effort своей модели', () => {
  const result = calculate(fixture('empirical_token_proxy'));
  const high = observedRow(result), max = observedRow(result, 'max');
  assert.equal(empiricalRows(result).length, 2);
  assert.ok(empiricalRows(result).every(row => row.model_id === 'sample'));
  assert.equal(high.quota_unit, 'MTok');
  assert.equal(high.monthly_quota, 2);
  assert.deepEqual(high.component_rates, { non_cache_input: 1, cache_read: 1, cache_write: 1, answer: 1, reasoning: 1 });
  close(high.task.cost_usd, 20 * 750_000 / 2_000_000);
  close(high.task.units_per_month, 2_000_000 / 750_000);
  close(max.task.cost_usd, high.task.cost_usd * 2);
  close(max.task.units_per_month, high.task.units_per_month / 2);
  close(max.task.effective_price_usd_per_million, high.task.effective_price_usd_per_million);
  assert.equal(result.rows.filter(row => row.kind === 'api' && row.model_id === 'other').length, 1);
});

test('Калибровка берёт AA-ставки только своей модели; конфликт ставок между её effort запрещает перенос', () => {
  const data = fixture();
  assert.equal(empiricalRows(calculate(data)).length, 2);
  data.aa.rows[2].api_price_input_usd_per_million = 999;
  assert.equal(empiricalRows(calculate(data)).length, 2);
  data.aa.rows[1].api_price_input_usd_per_million *= 2;
  const result = calculate(data);
  assert.equal(empiricalRows(result).length, 0);
  assert.equal(result.plans.find(plan => plan.id === 'native::sample').included, true);
  assert.match(result.excluded.find(plan => plan.id === 'observed::sample').reasons.join(' '), /различаются/);
});

test('Синтетическая смесь и неизвестное происхождение запрещены даже при положительных числах и флаге usable', () => {
  for (const origin of ['synthetic_budget_using_fixed_mix', 'budget_conversion', 'unknown', 'request_only', undefined]) {
    const data = fixture('empirical_token_proxy');
    data.evidence.rows[0].evidence_method = origin;
    data.evidence.rows[0].usable_for_observed_scenario = true;
    const result = calculate(data);
    assert.equal(empiricalRows(result).length, 0, String(origin));
    assert.equal(result.metadata.included_plans, 1);
    assert.equal(result.rows.filter(row => row.kind === 'api').length, data.aa.rows.length);
    assert.match(result.excluded.find(plan => plan.id === 'observed::sample').reasons.join(' '), /практического основания/);
  }
});

test('Неполная, отрицательная, бесконечная и невозможная API-калибровка не становится бесплатной подпиской', () => {
  for (const key of ['observed_api_usd', 'quota_fraction', 'periods_per_month', 'plan_multiplier']) {
    for (const value of [undefined, null, 0, -1, NaN, Infinity, '1']) {
      const data = fixture();
      data.evidence.rows[0].calibration[key] = value;
      const result = calculate(data);
      assert.equal(empiricalRows(result).length, 0, `${key}=${String(value)}`);
      assert.equal(result.metadata.included_plans, 1);
    }
  }
  for (const calibration of [null, undefined, { observed_api_usd: 28, quota_fraction: 1.01, periods_per_month: 4, plan_multiplier: 2 },
    { observed_api_usd: Number.MAX_VALUE, quota_fraction: .01, periods_per_month: 4, plan_multiplier: 2 }]) {
    const data = fixture();
    data.evidence.rows[0].calibration = calibration;
    assert.equal(empiricalRows(calculate(data)).length, 0);
  }
});

test('Чужая модель, несовпадающие плата или токенная ёмкость и отсутствие источника не проходят аудит', () => {
  for (const change of [{ model_id: 'other' }, { monthly_usd: 21 }, { monthly_tokens: 1 }, { source_urls: [] }, { method: 'invented_method' }]) {
    const data = fixture('empirical_token_proxy');
    Object.assign(data.evidence.rows[0], change);
    assert.equal(empiricalRows(calculate(data)).length, 0, JSON.stringify(change));
  }
});

test('Изменение выдуманной смеси и готовых смешанных цен не влияет на оба эмпирических метода', () => {
  for (const method of ['empirical_api_calibration', 'empirical_token_proxy']) {
    const data = fixture(method);
    const before = empiricalRows(calculate(data));
    data.pricing.standard_token_mix = { cache: 0, input: 0, output: 1 };
    for (const plan of data.pricing.rows) {
      plan.real_price_usd_per_million = 99_999;
      plan.api_price_usd_per_million = 99_999;
      plan.api_price_components = { cache: 99_999, input: 99_999, output: 99_999 };
      if (method === 'empirical_api_calibration') plan.monthly_tokens = 1;
    }
    rebind(data);
    const after = empiricalRows(calculate(data));
    assert.deepEqual(after.map(row => [row.task, row.suite]), before.map(row => [row.task, row.suite]));
  }
});

test('Неактуальный или отсутствующий эмпирический аудит сохраняет исходные API и native-тарифы', () => {
  for (const key of ['pricing_revision', 'pricing_retrieved_at_utc', 'pricing_rows_sha256', null]) {
    const data = fixture();
    const baseline = buildQuotaScenario(data.aa, data.pricing, data.rates);
    if (key) data.evidence.metadata[key] = 'stale';
    else data.evidence = null;
    const result = calculate(data);
    assert.deepEqual(result.rows, baseline.rows);
    assert.deepEqual(result.plans, baseline.plans);
    assert.equal(result.metadata.empirical_status, key ? 'stale_or_invalid' : 'missing');
  }
});

test('Отсутствующие расходы AA оставляют effort в таблице с пустыми результатами; API не изменяется', () => {
  const data = fixture();
  Object.assign(data.aa.rows[0], { cost_per_task_usd: null, cost_total_usd: null, cost_per_task_components_usd: null, cost_total_components_usd: null });
  const baseline = buildQuotaScenario(data.aa, data.pricing, data.rates);
  const result = calculate(data);
  const row = observedRow(result);
  assert.equal(row.effort, 'high');
  assert.equal(row.task.cost_usd, null);
  assert.equal(row.suite.cost_usd, null);
  assert.deepEqual(result.rows.filter(item => item.kind === 'api'), baseline.rows.filter(item => item.kind === 'api'));
});

test('Расчёт не мутирует AA, тарифы, native-ставки и исходные наблюдения', () => {
  for (const method of ['empirical_api_calibration', 'empirical_token_proxy']) {
    const data = fixture(method), before = structuredClone(data);
    calculate(data);
    assert.deepEqual(data, before);
  }
});

async function snapshot() {
  const [aa, pricing, rates, evidence] = await Promise.all(['aa/aa.json', 'pricing/pricing.json', 'pricing/quota-rates.json', 'pricing/empirical-evidence.json'].map(async path => JSON.parse(await readFile(new URL(`../data/${path}`, import.meta.url), 'utf8'))));
  return { aa, pricing, rates, evidence };
}

test('Реальный снимок: 36 native + 28 практических тарифов включены, исключён только неизвестный SuperGrok Lite', async () => {
  const data = await snapshot();
  const result = calculate(data);
  assert.equal(result.metadata.status, 'ok');
  assert.equal(result.metadata.empirical_status, 'ok');
  assert.equal(result.metadata.native_rates_status, 'ok');
  assert.equal(result.metadata.included_plans, 64);
  assert.equal(result.plans.length, 65);
  assert.equal(result.metadata.empirical_plans, 28);
  assert.equal(result.metadata.empirical_api_calibration_plans, 10);
  assert.equal(result.metadata.empirical_token_proxy_plans, 18);
  assert.deepEqual(result.excluded.map(plan => plan.id), ['supergrok_lite::grok-4.6']);
  assert.equal(result.rows.filter(row => row.pricing_id === 'supergrok_lite::grok-4.6').length, 0);
  assert.equal(result.plans.filter(plan => plan.included && !plan.method.startsWith('empirical_')).length, 36);
});

test('Реальный снимок: девять обычных OpenAI и пять Anthropic сохранены со всеми точными AA effort', async () => {
  const data = await snapshot();
  const result = calculate(data);
  const expected = [
    ...['chatgpt_plus', 'chatgpt_pro_5x', 'chatgpt_pro_20x'].flatMap(plan => ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra'].map(model => `${plan}::${model}`)),
    'claude_pro::claude-opus-5', 'claude_max_5x::claude-opus-5', 'claude_max_20x::claude-opus-5',
    'claude_max_5x::claude-fable-5.1', 'claude_max_20x::claude-fable-5.1',
  ];
  for (const id of expected) {
    const plan = result.plans.find(item => item.id === id);
    assert.equal(plan?.included, true, id);
    const variants = data.aa.rows.filter(row => row.model === plan.model_id);
    const rows = result.rows.filter(row => row.pricing_id === id);
    assert.deepEqual(rows.map(row => [row.source_id, row.effort]), variants.map(row => [row.source_id, row.effort]), id);
    assert.ok(rows.every(row => row.model_id === plan.model_id && row.confidence === 'assumed'), id);
  }
});

test('Реальный снимок: дополнительные Grok 4.7 имеют точные ID, отдельные квоты и свою модель', async () => {
  const data = await snapshot();
  const result = calculate(data);
  const expected = ['supergrok::grok-4.7', 'supergrok_plus::grok-4.7', 'supergrok_heavy::grok-4.7'];
  assert.deepEqual(data.evidence.additional_plans.map(plan => plan.id).sort(), [...expected].sort());
  assert.equal(result.metadata.additional_plans, 3);
  const capacities = [672_000_000, 2_690_000_000, 6_720_000_000];
  for (const [index, id] of expected.entries()) {
    const added = data.evidence.additional_plans.find(plan => plan.id === id);
    assert.equal(added.monthly_tokens, capacities[index]);
    const rows = result.rows.filter(row => row.pricing_id === id);
    assert.ok(rows.length > 0, id);
    assert.equal(rows.length, data.aa.rows.filter(row => row.model === 'grok-4.7').length);
    assert.ok(rows.every(row => row.model_id === 'grok-4.7' && row.method === 'empirical_token_proxy'));
    close(rows[0].monthly_quota, capacities[index] / 1e6);
  }
});

test('Реальный снимок: расширение не меняет ни одну исходную API-строку или native-подписку', async () => {
  const data = await snapshot(), before = structuredClone(data);
  const baseline = buildQuotaScenario(data.aa, data.pricing, data.rates);
  const result = calculate(data);
  assert.deepEqual(result.rows.filter(row => row.kind === 'api'), baseline.rows.filter(row => row.kind === 'api'));
  const nativeIds = new Set(data.rates.rows.map(row => row.id));
  assert.deepEqual(result.rows.filter(row => nativeIds.has(row.pricing_id)), baseline.rows.filter(row => row.kind === 'subscription'));
  assert.deepEqual(data, before);
  assert.equal(new Set(result.rows.map(row => row.id)).size, result.rows.length);
});

test('Реальный снимок: устаревший эмпирический fingerprint оставляет все 36 native-пар', async () => {
  const data = await snapshot();
  data.evidence.metadata.pricing_rows_sha256 = 'stale';
  const result = calculate(data);
  assert.equal(result.metadata.empirical_status, 'stale_or_invalid');
  assert.equal(result.metadata.included_plans, 36);
  assert.equal(result.rows.filter(row => row.kind === 'api').length, data.aa.rows.length);
  assert.equal(empiricalRows(result).length, 0);
});
