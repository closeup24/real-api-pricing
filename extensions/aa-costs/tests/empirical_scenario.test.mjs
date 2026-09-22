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
    quality: { level: method === 'empirical_api_scenario' ? 'low' : 'medium', reasons: ['Условия переноса замера на другую нагрузку не проверены.'] },
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

function transferFixture() {
  const data = fixture();
  const source = data.pricing.rows.find(row => row.id === 'observed::sample');
  data.evidence.additional_plans.push({...source, id: 'observed::other', model: 'other', monthly_tokens: undefined});
  data.evidence.rows.unshift({
    id: 'observed::other', model_id: 'other', monthly_usd: source.monthly_usd,
    method: 'empirical_model_transfer', evidence_method: 'model_transfer',
    source_urls: ['https://example.com/new-model'],
    transfer: {source_pricing_id: source.id, source_model_id: source.model, confidence: 'medium', assumption_ru: 'Одинаковый денежный пул двух моделей — гипотеза.'},
  });
  return data;
}

test('Перенос сохраняет денежную квоту, но использует собственные ставки и объёмы новой модели', () => {
  const data = transferFixture();
  const result = calculate(data);
  const source = result.rows.find(row => row.pricing_id === 'observed::sample');
  const target = result.rows.find(row => row.pricing_id === 'observed::other');
  const api = result.rows.find(row => row.kind === 'api' && row.model_id === 'other');
  assert.equal(target.method, 'empirical_model_transfer');
  assert.equal(target.monthly_quota, source.monthly_quota);
  assert.equal(target.component_rates.answer / source.component_rates.answer, 10);
  assert.equal(target.quality.level, 'medium');
  assert.equal(target.empirical.transfer.source_pricing_id, source.pricing_id);
  assert.deepEqual(target.empirical.transfer.source_empirical, source.empirical);
  assert.equal(target.empirical.calibration, undefined);
  for (const scope of ['task', 'suite']) {
    assert.deepEqual(target[scope].component_tokens, api[scope].component_tokens);
    close(target[scope].cost_usd, target.monthly_usd * api[scope].cost_usd / source.monthly_quota);
  }
  data.evidence.rows.find(row => row.id === 'observed::sample').calibration.observed_api_usd *= 2;
  const updated = calculate(data).rows.find(row => row.pricing_id === 'observed::other');
  close(updated.monthly_quota, target.monthly_quota * 2);
  close(updated.task.cost_usd, target.task.cost_usd / 2);
});

test('Гипотеза переноса не повышает низкую надёжность исходного лимита', () => {
  const data = transferFixture();
  data.evidence.rows.find(row => row.id === 'observed::sample').quality.level = 'low';
  const target = calculate(data).rows.find(row => row.pricing_id === 'observed::other');
  assert.equal(target.quality.level, 'low');
  assert.equal(target.empirical.transfer.confidence, 'medium');
  assert.equal(target.empirical.transfer.source_quality.level, 'low');
});

test('Несовместимый, отсутствующий или циклический источник переноса оставляет цену неизвестной', () => {
  const invalidations = [
    data => { data.evidence.rows[0].transfer.source_pricing_id = 'missing'; },
    data => { data.evidence.rows[0].transfer.source_pricing_id = 'observed::other'; },
    data => { data.evidence.rows[0].transfer.source_model_id = 'other'; },
    data => { data.evidence.additional_plans[0].plan_id = 'another-tier'; },
    data => { data.evidence.additional_plans[0].monthly_usd = 100; },
    data => { data.evidence.rows[0].transfer.assumption_ru = ''; },
    data => { data.evidence.rows[0].transfer.confidence = 'high'; },
    data => { data.evidence.rows[1].calibration = null; },
  ];
  for (const invalidate of invalidations) {
    const data = transferFixture();
    invalidate(data);
    const result = calculate(data);
    const target = result.rows.find(row => row.pricing_id === 'observed::other');
    assert.equal(target.task.cost_usd, null);
    assert.equal(target.method, 'unavailable_quota_weights');
    assert.equal(result.plans.find(row => row.id === 'native::sample').included, true);
  }
});

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

test('Равное число токенов при другом составе AA меняет цену по ставкам категорий', () => {
  const data = fixture();
  const second = data.aa.rows[1];
  second.cost_per_task_components_usd = { nonCacheInput: .2, cacheRead: .08, cacheWrite: .25, answer: 1.1, reasoning: .4, input: .53, output: 1.5, total: 2.03 };
  second.cost_per_task_usd = 2.03;
  second.intelligence_index_output_tokens_per_task = { answer: 110_000, reasoning: 40_000, output: 150_000 };
  const result = calculate(data), high = observedRow(result), max = observedRow(result, 'max');
  close(high.task.total_tokens, max.task.total_tokens);
  close(max.task.cost_usd / high.task.cost_usd, 2.03 / 1.05);
  assert.notEqual(high.task.cache_read_share, max.task.cache_read_share);
  assert.notEqual(high.task.effective_price_usd_per_million, max.task.effective_price_usd_per_million);
});

test('Приблизительный сценарий требует низкой надёжности и непустого объяснения', () => {
  const accepted = observedRow(calculate(fixture('empirical_api_scenario')));
  assert.equal(accepted.method, 'empirical_api_scenario');
  assert.equal(accepted.quality.level, 'low');
  for (const quality of [undefined, null, { level: 'medium', reasons: ['Допущение'] },
    { level: 'high', reasons: ['Допущение'] }, { level: 'low' }, { level: 'low', reasons: [] },
    { level: 'low', reasons: [''] }, { level: 'low', reasons: ['  '] },
    { level: 'low', reasons: [null] }, { level: 'low', reasons: 'Допущение' }]) {
    const data = fixture('empirical_api_scenario');
    data.evidence.rows[0].quality = quality;
    const result = calculate(data);
    assert.equal(empiricalRows(result).length, 0, JSON.stringify(quality));
    const unavailable = result.rows.filter(row => row.pricing_id === 'observed::sample');
    assert.equal(unavailable.length, 2);
    assert.ok(unavailable.every(row => row.task.cost_usd === null && row.suite.cost_usd === null));
  }
});

test('Поправки промопериода и модельного лимита меняют квоту, а не токены AA или API-цену', () => {
  const data = fixture('empirical_api_scenario');
  const before = calculate(data), base = observedRow(before);
  data.evidence.rows[0].calibration.corrections = [
    { label: 'Удаление временного увеличения', factor: 2 / 3 },
    { label: 'Постоянное увеличение', factor: 1.25 },
    { label: 'Половина общего пула для модели', factor: .5 },
  ];
  const corrected = calculate(data), row = observedRow(corrected);
  close(row.monthly_quota, 896 * (2 / 3) * 1.25 * .5);
  for (const scope of ['task', 'suite']) {
    assert.deepEqual(row[scope].component_tokens, base[scope].component_tokens);
    close(row[scope].quota_per_unit, base[scope].quota_per_unit);
    close(row[scope].cost_usd, base[scope].cost_usd / ((2 / 3) * 1.25 * .5));
  }
  assert.deepEqual(corrected.rows.filter(item => item.kind === 'api'), before.rows.filter(item => item.kind === 'api'));
  // Изменение условия должно менять результат, а не только подпись в разборе.
  data.evidence.rows[0].calibration.corrections[2].factor = 1;
  const sensitivity = observedRow(calculate(data));
  close(sensitivity.monthly_quota, row.monthly_quota * 2);
  close(sensitivity.task.cost_usd, row.task.cost_usd / 2);
});

test('Поправка без положительного множителя или объяснения не создаёт цену', () => {
  const invalid = [null, {}, 'поправка', [null], [{}], [{ factor: 1 }],
    ...[undefined, null, '', '  ', 1].map(label => [{ label, factor: 1 }]),
    ...[undefined, null, 0, -1, NaN, Infinity, '2'].map(factor => [{ label: 'Поправка', factor }]),
    [{ label: 'Переполнение', factor: Number.MAX_VALUE }]];
  for (const corrections of invalid) {
    const data = fixture('empirical_api_scenario');
    data.evidence.rows[0].calibration.corrections = corrections;
    const result = calculate(data);
    assert.equal(empiricalRows(result).length, 0, JSON.stringify(corrections));
    assert.equal(result.plans.find(plan => plan.id === 'native::sample').included, true);
  }
});

test('Сообщённый месячный пул не превращается в выдуманный замер расхода 100% квоты', () => {
  const data = fixture('empirical_api_scenario');
  data.evidence.rows[0].evidence_method = 'reported_quota';
  data.evidence.rows[0].calibration = { input_kind: 'reported_monthly_pool', reported_monthly_pool_usd: 300, plan_multiplier: 1 };
  const row = observedRow(calculate(data));
  close(row.monthly_quota, 300);
  close(row.task.cost_usd, 20 * 1.05 / 300);
  assert.equal(row.empirical.calibration.input_kind, 'reported_monthly_pool');
  assert.equal('observed_api_usd' in row.empirical.calibration, false);
  assert.equal('quota_fraction' in row.empirical.calibration, false);
  for (const key of ['reported_monthly_pool_usd', 'plan_multiplier']) {
    for (const value of [undefined, null, 0, -1, NaN, Infinity, '300']) {
      const invalid = structuredClone(data);
      invalid.evidence.rows[0].calibration[key] = value;
      assert.equal(empiricalRows(calculate(invalid)).length, 0, `${key}=${String(value)}`);
    }
  }
  data.evidence.rows[0].calibration.corrections = [{ label: 'Чувствительность ёмкости', factor: .5 }];
  const corrected = observedRow(calculate(data));
  close(corrected.monthly_quota, 150);
  close(corrected.task.cost_usd, row.task.cost_usd * 2);
});

test('Fast удваивает только списание после инверсии AA: цена ×2, тот же пул и те же токены', () => {
  const data = fixture('empirical_api_scenario');
  data.evidence.rows[0].calibration = { input_kind: 'reported_monthly_pool', reported_monthly_pool_usd: 3000, plan_multiplier: 1 };
  const before = calculate(data), regular = observedRow(before);
  data.evidence.rows[0].quota_rate_multiplier = 2;
  const after = calculate(data), fast = observedRow(after);
  assert.equal(fast.monthly_quota, regular.monthly_quota);
  for (const scope of ['task', 'suite']) {
    assert.deepEqual(fast[scope].component_tokens, regular[scope].component_tokens);
    close(fast[scope].api_price_usd_per_million, regular[scope].api_price_usd_per_million);
    close(fast[scope].quota_per_unit, regular[scope].quota_per_unit * 2);
    close(fast[scope].cost_usd, regular[scope].cost_usd * 2);
    close(fast[scope].units_per_month, regular[scope].units_per_month / 2);
  }
  assert.deepEqual(after.rows.filter(row => row.kind === 'api'), before.rows.filter(row => row.kind === 'api'));
  for (const value of [0, -1, NaN, Infinity, '2']) {
    data.evidence.rows[0].quota_rate_multiplier = value;
    assert.equal(empiricalRows(calculate(data)).length, 0);
  }
});

test('Старый token proxy не создаёт цену: каждый effort остаётся в таблице с профилем AA и причиной', () => {
  const result = calculate(fixture('empirical_token_proxy'));
  const rows = result.rows.filter(row => row.pricing_id === 'observed::sample');
  assert.equal(rows.length, 2);
  assert.equal(empiricalRows(result).length, 0);
  for (const row of rows) {
    assert.equal(row.method, 'unavailable_quota_weights');
    assert.equal(row.monthly_usd, 20);
    assert.equal(row.monthly_quota, null);
    assert.ok(Object.values(row.component_rates).every(value => value === null));
    assert.match(row.notes.join(' '), /равные веса категорий не используются/);
    for (const scope of ['task', 'suite']) {
      const api = result.rows.find(item => item.kind === 'api' && item.source_id === row.source_id);
      assert.deepEqual(row[scope].component_tokens, api[scope].component_tokens);
      assert.equal(row[scope].api_cost_usd, api[scope].cost_usd);
      for (const field of ['cost_usd', 'effective_price_usd_per_million', 'quota_per_unit', 'units_per_month', 'units_per_100_usd']) assert.equal(row[scope][field], null);
    }
  }
  assert.equal(result.metadata.uses_rap_monthly_tokens, false);
  assert.equal(result.metadata.uses_equal_token_weights_fallback, false);
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
  assert.equal(result.metadata.status, 'partial');
  assert.match(result.metadata.notes.join(' '), /различаются/);
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

test('Чужая модель, несовпадающая плата, отсутствие источника и неизвестный метод не проходят аудит', () => {
  for (const change of [{ model_id: 'other' }, { monthly_usd: 21 }, { source_urls: [] }, { method: 'invented_method' }]) {
    const data = fixture();
    Object.assign(data.evidence.rows[0], change);
    assert.equal(empiricalRows(calculate(data)).length, 0, JSON.stringify(change));
  }
});

test('Смесь RAP, её готовые цены и месячные токены не влияют на расчёт и не возвращают цену неподдержанного тарифа', () => {
  for (const method of ['empirical_api_calibration', 'empirical_api_scenario', 'unavailable_quota_weights']) {
    const data = fixture(method);
    const before = calculate(data).rows;
    data.pricing.standard_token_mix = { cache: 0, input: 0, output: 1 };
    for (const plan of data.pricing.rows) {
      plan.real_price_usd_per_million = 99_999;
      plan.api_price_usd_per_million = 99_999;
      plan.api_price_components = { cache: 99_999, input: 99_999, output: 99_999 };
      plan.monthly_tokens = 1;
    }
    data.evidence.rows[0].monthly_tokens = 999_999_999_999;
    rebind(data);
    const after = calculate(data).rows;
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
    assert.deepEqual(result.rows.filter(row => row.kind === 'api' || row.pricing_id === 'native::sample'), baseline.rows);
    assert.equal(result.rows.filter(row => row.method === 'unavailable_quota_weights').length, 2);
    assert.deepEqual(result.plans, baseline.plans);
    assert.equal(result.metadata.empirical_status, key ? 'stale_or_invalid' : 'missing');
    assert.equal(result.metadata.status, 'partial');
    assert.match(result.metadata.notes.join(' '), /аудит отсутствует или не соответствует/);
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
  for (const method of ['empirical_api_calibration', 'empirical_api_scenario', 'empirical_token_proxy']) {
    const data = fixture(method), before = structuredClone(data);
    calculate(data);
    assert.deepEqual(data, before);
  }
});

async function snapshot() {
  const [aa, pricing, rates, evidence] = await Promise.all(['aa/aa.json', 'pricing/pricing.json', 'pricing/quota-rates.json', 'pricing/empirical-evidence.json'].map(async path => JSON.parse(await readFile(new URL(`../data/${path}`, import.meta.url), 'utf8'))));
  return { aa, pricing, rates, evidence };
}

test('Sol и Devin используют категории практического замера, а не месячный total RAP', async () => {
  const result = calculate(await snapshot());
  const solCosts = (40_729_910 * 4 + 856_859_776 * .4 + 3_755_512 * 20
    + 5_481_179 * .2 + 23_369_216 * .02 + 65_577 * 1.2) / 1e6;
  for (const [plan, multiplier] of [['chatgpt_plus', 1 / 20], ['chatgpt_pro_5x', 1 / 4], ['chatgpt_pro_20x', 1]]) {
    const row = result.rows.find(row => row.pricing_id === `${plan}::gpt-5.6-sol`);
    assert.equal(row.method, 'empirical_api_calibration');
    close(row.monthly_quota, solCosts / .27 * 4 * multiplier);
    assert.equal(row.evidence_method, multiplier === 1 ? 'pooled_measurements' : 'plan_extrapolation');
    assert.equal(row.empirical.calibration.sample_components.length, 6);
    assert.match(row.notes.join(' '), /Luna составляет/);
  }
  const devin = result.rows.find(row => row.pricing_id === 'devin_max::gpt-6-astra');
  assert.equal(devin.method, 'empirical_api_calibration');
  close(devin.monthly_quota, (1998 * 10 + 300_944_710 + 3_708_954 * 12.5 + 369_918 * 50) / 1e6 / .87 * 4);
  assert.match(devin.notes.join(' '), /CacheCreate сопоставлен/);
  const cursor = result.rows.find(row => row.pricing_id === 'cursor_pro_plus::grok-4.6');
  assert.equal(cursor.method, 'empirical_api_scenario');
  assert.equal(cursor.quality.level, 'low');
  close(cursor.monthly_quota, 214.74 / .268);
});

test('Реальный снимок: 27 native, 14 калибровок, 14 сценариев и 9 переносов; десять тарифов без цены', async () => {
  const data = await snapshot();
  const result = calculate(data);
  assert.equal(result.metadata.status, 'ok');
  assert.equal(result.metadata.empirical_status, 'ok');
  assert.equal(result.metadata.native_rates_status, 'ok');
  assert.equal(result.metadata.included_plans, 64);
  assert.equal(result.plans.length, 74);
  assert.equal(result.metadata.empirical_plans, 37);
  assert.equal(result.metadata.empirical_model_transfer_plans, 9);
  assert.equal(result.metadata.empirical_api_calibration_plans, 14);
  assert.equal(result.plans.filter(plan => plan.included && plan.method === 'empirical_api_scenario').length, 14);
  assert.equal(result.metadata.empirical_token_proxy_plans, 0);
  assert.equal(result.excluded.length, 10);
  assert.equal(result.rows.length, 299);
  assert.ok(result.rows.filter(row => row.pricing_id === 'supergrok_lite::grok-4.6').length > 0);
  assert.equal(result.plans.filter(plan => plan.included && !plan.method.startsWith('empirical_')).length, 27);
  const oldGlm = result.rows.filter(row => row.plan_id?.startsWith('glm_coding_') && row.plan_id.includes('_old_'));
  assert.equal(oldGlm.length, 9);
  assert.ok(oldGlm.every(row => row.task.cost_usd === null && row.suite.cost_usd === null && row.monthly_quota === null));
  assert.ok(oldGlm.every(row => row.notes.join(' ').includes('V2') && row.notes.join(' ').includes('V3')));
  for (const row of result.rows) {
    assert.equal(typeof row.quality?.level, 'string', row.id);
    assert.ok(Array.isArray(row.quality.reasons) && row.quality.reasons.length > 0, row.id);
    assert.ok(row.quality.reasons.every(reason => typeof reason === 'string' && reason.trim()), row.id);
  }
  const lite = result.rows.filter(row => row.pricing_id === 'supergrok_lite::grok-4.6');
  assert.ok(lite.every(row => row.task.cost_usd === null && row.suite.cost_usd === null));
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
    assert.ok(plan, id);
    const variants = data.aa.rows.filter(row => row.model === plan.model_id);
    const rows = result.rows.filter(row => row.pricing_id === id);
    assert.deepEqual(rows.map(row => [row.source_id, row.effort]), variants.map(row => [row.source_id, row.effort]), id);
    assert.ok(rows.every(row => row.model_id === plan.model_id && row.confidence === (plan.included ? 'assumed' : 'unavailable')), id);
    if (!plan.included) assert.ok(rows.every(row => row.task.cost_usd === null && row.suite.cost_usd === null && row.sources.length > 0), id);
  }
});

test('Реальный снимок: Grok 4.7 сохраняет ID и свою модель, получая явно условную денежную калибровку', async () => {
  const data = await snapshot();
  const result = calculate(data);
  const expected = ['supergrok::grok-4.7', 'supergrok_plus::grok-4.7', 'supergrok_heavy::grok-4.7'];
  assert.deepEqual(data.evidence.additional_plans.filter(plan => plan.model === 'grok-4.7').map(plan => plan.id).sort(), [...expected].sort());
  assert.equal(result.metadata.additional_plans, 12);
  const capacities = [672_000_000, 2_690_000_000, 6_720_000_000];
  for (const [index, id] of expected.entries()) {
    const added = data.evidence.additional_plans.find(plan => plan.id === id);
    assert.equal(added.monthly_tokens, capacities[index]);
    const rows = result.rows.filter(row => row.pricing_id === id);
    assert.ok(rows.length > 0, id);
    assert.equal(rows.length, data.aa.rows.filter(row => row.model === 'grok-4.7').length);
    assert.ok(rows.every(row => row.model_id === 'grok-4.7' && row.method === 'empirical_api_scenario' && row.quality.level === 'low'));
    for (const row of rows) close(row.monthly_quota, 9.948764 / .08 * 4 * [1, 4, 10][index]);
  }
});

test('Fable и Opus Max используют частичные наблюдения и явные поправки, а не raw-token ёмкость', async () => {
  const result = calculate(await snapshot());
  const fablePartial = (283_000_000 * .25 + 2_600_000 * 50) / 1e6;
  const opusPartial = 2_100_000_000 * .5 / 1e6;
  for (const [model, pool] of [
    ['claude-fable-5.1', fablePartial / .19 * 4 * (2 / 3) * 1.25 * .5],
    ['claude-opus-5', opusPartial / .52 * 4],
  ]) {
    const max20 = result.rows.filter(row => row.pricing_id === `claude_max_20x::${model}`);
    const max5 = result.rows.filter(row => row.pricing_id === `claude_max_5x::${model}`);
    assert.equal(max20.length, 5);
    assert.equal(max5.length, 5);
    for (const row of [...max20, ...max5]) {
      assert.equal(row.method, 'empirical_api_scenario');
      assert.equal(row.quality.level, 'low');
      close(row.empirical.calibration.observed_api_usd, model === 'claude-fable-5.1' ? fablePartial : opusPartial);
      close(row.monthly_quota, pool * (row.plan_id === 'claude_max_5x' ? .5 : 1));
      const api = result.rows.find(item => item.kind === 'api' && item.source_id === row.source_id);
      for (const scope of ['task', 'suite']) {
        assert.deepEqual(row[scope].component_tokens, api[scope].component_tokens);
        close(row[scope].cost_usd, row.monthly_usd * api[scope].cost_usd / row.monthly_quota);
      }
    }
    for (const row of max20) close(row.task.cost_usd, max5.find(item => item.source_id === row.source_id).task.cost_usd);
  }
});

test('Opus 5.5: пять effort и три тарифа получают прежние денежные пулы с собственной нагрузкой AA', async () => {
  const data = await snapshot();
  const result = calculate(data);
  const variants = data.aa.rows.filter(row => row.model === 'claude-opus-5.5');
  assert.equal(variants.length, 5);
  for (const planId of ['claude_pro', 'claude_max_5x', 'claude_max_20x']) {
    const source = result.rows.find(row => row.pricing_id === `${planId}::claude-opus-5`);
    const rows = result.rows.filter(row => row.pricing_id === `${planId}::claude-opus-5.5`);
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.method, 'empirical_model_transfer');
      assert.equal(row.monthly_quota, source.monthly_quota);
      assert.equal(row.quality.level, source.quality.level);
      assert.equal(row.empirical.transfer.confidence, 'medium');
      assert.deepEqual(row.component_rates, {non_cache_input: 4, cache_read: .2, cache_write: 5, answer: 20, reasoning: 20});
      const api = result.rows.find(item => item.kind === 'api' && item.source_id === row.source_id);
      for (const scope of ['task', 'suite']) {
        assert.deepEqual(row[scope].component_tokens, api[scope].component_tokens);
        close(row[scope].cost_usd, row.monthly_usd * api[scope].cost_usd / source.monthly_quota);
      }
    }
  }
});

test('GPT-6 Sol/Luna: шесть родных тарифов наследуют пулы соответствующей GPT-5.6 и используют собственные шесть effort', async () => {
  const data = await snapshot();
  const result = calculate(data);
  for (const family of ['sol', 'luna']) {
    const model = `gpt-6-${family}`;
    const sourceModel = `gpt-5.6-${family}`;
    const variants = data.aa.rows.filter(row => row.model === model);
    assert.deepEqual(variants.map(row => row.effort).sort(), ['non-reasoning', 'low', 'medium', 'high', 'xhigh', 'max'].sort());
    for (const planId of ['chatgpt_plus', 'chatgpt_pro_5x', 'chatgpt_pro_20x']) {
      const sourceId = `${planId}::${sourceModel}`;
      const id = `${planId}::${model}`;
      const sourcePlan = data.pricing.rows.find(row => row.id === sourceId);
      const addedPlan = data.evidence.additional_plans.find(row => row.id === id);
      const source = result.rows.find(row => row.pricing_id === sourceId);
      const evidence = data.evidence.rows.find(row => row.id === id);
      const targetRows = result.rows.filter(row => row.pricing_id === id);
      assert.ok(sourcePlan && source && addedPlan && evidence, id);
      for (const field of ['plan_id', 'plan', 'monthly_usd', 'billing', 'model_provider', 'access_channel']) {
        assert.equal(addedPlan[field], sourcePlan[field], `${id}: ${field}`);
      }
      assert.equal(addedPlan.model, model);
      assert.equal(Object.hasOwn(addedPlan, 'monthly_tokens'), false);
      assert.equal(Object.hasOwn(evidence, 'calibration'), false);
      assert.equal(Object.hasOwn(evidence, 'monthly_tokens'), false);
      assert.match(evidence.reason_ru, /Гипотеза.*В используемом срезе нет прямых замеров/);
      assert.ok(evidence.source_urls.includes(`https://artificialanalysis.ai/models/${model}`));
      assert.deepEqual(targetRows.map(row => [row.source_id, row.effort]), variants.map(row => [row.source_id, row.effort]));
      for (const row of targetRows) {
        assert.equal(row.method, 'empirical_model_transfer');
        assert.equal(row.model_id, model);
        assert.equal(row.plan_id, planId);
        assert.equal(row.monthly_usd, source.monthly_usd);
        assert.equal(row.monthly_quota, source.monthly_quota);
        assert.equal(row.quality.level, source.quality.level);
        assert.equal(row.empirical.transfer.source_pricing_id, sourceId);
        assert.equal(row.empirical.transfer.source_model_id, sourceModel);
        assert.equal(row.empirical.transfer.source_evidence_method, source.evidence_method);
        assert.deepEqual(row.empirical.transfer.source_quality, source.quality);
        assert.deepEqual(row.empirical.transfer.source_empirical, source.empirical);
        const aaVariant = variants.find(variant => variant.source_id === row.source_id);
        close(row.component_rates.non_cache_input, aaVariant.api_price_input_usd_per_million);
        close(row.component_rates.cache_read, aaVariant.api_price_cache_hit_usd_per_million);
        close(row.component_rates.cache_write, aaVariant.api_price_cache_write_usd_per_million);
        close(row.component_rates.answer, aaVariant.api_price_output_usd_per_million);
        const api = result.rows.find(item => item.kind === 'api' && item.source_id === row.source_id);
        for (const scope of ['task', 'suite']) {
          assert.deepEqual(row[scope].component_tokens, api[scope].component_tokens);
          close(row[scope].cost_usd, row.monthly_usd * api[scope].cost_usd / source.monthly_quota);
        }
      }
    }
  }
});

test('GPT-6: добавление гипотез не меняет прежние строки; пересмотр исходного замера обновляет только связанную пару', async () => {
  const data = await snapshot();
  const result = calculate(data);
  const isNewModel = model => /^gpt-6-(sol|luna)$/.test(model);
  const withoutNewTransfers = structuredClone(data);
  withoutNewTransfers.evidence.rows = withoutNewTransfers.evidence.rows.filter(row => !isNewModel(row.model_id));
  withoutNewTransfers.evidence.additional_plans = withoutNewTransfers.evidence.additional_plans.filter(row => !isNewModel(row.model));
  assert.deepEqual(result.rows.filter(row => !isNewModel(row.model_id)), calculate(withoutNewTransfers).rows.filter(row => !isNewModel(row.model_id)));

  for (const family of ['sol', 'luna']) {
    for (const planId of ['chatgpt_plus', 'chatgpt_pro_5x', 'chatgpt_pro_20x']) {
      const changed = structuredClone(data);
      const sourceId = `${planId}::gpt-5.6-${family}`;
      const targetId = `${planId}::gpt-6-${family}`;
      changed.evidence.rows.find(row => row.id === sourceId).calibration.observed_api_usd *= 2;
      const updated = calculate(changed);
      for (const row of updated.rows.filter(row => row.pricing_id === targetId)) {
        const previous = result.rows.find(item => item.id === row.id);
        close(row.monthly_quota, previous.monthly_quota * 2);
        for (const scope of ['task', 'suite']) {
          close(row[scope].cost_usd, previous[scope].cost_usd / 2);
          assert.deepEqual(row[scope].component_tokens, previous[scope].component_tokens);
        }
      }
      assert.deepEqual(updated.rows.filter(row => ![sourceId, targetId].includes(row.pricing_id)), result.rows.filter(row => ![sourceId, targetId].includes(row.pricing_id)));
    }
  }
});

test('Cursor и SuperGrok используют свои денежные основания; Fast удваивает ставку без подмены AA', async () => {
  const result = calculate(await snapshot());
  for (const [plan, pool] of [['cursor_pro', 300], ['cursor_pro_plus', 214.74 / .268], ['cursor_ultra', 3000], ['cursor_ultra_fast', 3000]]) {
    const rows = result.rows.filter(row => row.pricing_id === `${plan}::grok-4.6`);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.method, 'empirical_api_scenario');
      assert.equal(row.quality.level, 'low');
      close(row.monthly_quota, pool);
      if (plan !== 'cursor_pro_plus') {
        assert.equal(row.empirical.calibration.input_kind, 'reported_monthly_pool');
        assert.equal('observed_api_usd' in row.empirical.calibration, false);
        assert.equal('quota_fraction' in row.empirical.calibration, false);
      }
      if (plan === 'cursor_ultra_fast') {
        const regular = result.rows.find(item => item.pricing_id === 'cursor_ultra::grok-4.6' && item.source_id === row.source_id);
        for (const scope of ['task', 'suite']) {
          assert.deepEqual(row[scope].component_tokens, regular[scope].component_tokens);
          if (regular[scope].cost_usd !== null) close(row[scope].cost_usd, regular[scope].cost_usd * 2);
        }
      }
    }
  }
  for (const [plan, multiplier] of [['supergrok', 1], ['supergrok_plus', 4], ['supergrok_heavy', 10]]) {
    const rows = result.rows.filter(row => row.pricing_id === `${plan}::grok-4.6`);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.method, 'empirical_api_scenario');
      assert.equal(row.quality.level, 'low');
      close(row.monthly_quota, 64.51 / .26 * 4 * .5 * multiplier);
    }
  }
});

test('Реальный снимок: расширение не меняет ни одну исходную API-строку или native-подписку', async () => {
  const data = await snapshot(), before = structuredClone(data);
  const baseline = buildQuotaScenario(data.aa, data.pricing, data.rates);
  const result = calculate(data);
  assert.deepEqual(result.rows.filter(row => row.kind === 'api'), baseline.rows.filter(row => row.kind === 'api'));
  const nativeIds = new Set(data.rates.rows.filter(row => row.status !== 'unavailable').map(row => row.id));
  assert.deepEqual(result.rows.filter(row => nativeIds.has(row.pricing_id)), baseline.rows.filter(row => row.kind === 'subscription'));
  assert.deepEqual(data, before);
  assert.equal(new Set(result.rows.map(row => row.id)).size, result.rows.length);
});

test('Реальный снимок: устаревший эмпирический fingerprint оставляет 27 доступных native-пар', async () => {
  const data = await snapshot();
  data.evidence.metadata.pricing_rows_sha256 = 'stale';
  const result = calculate(data);
  assert.equal(result.metadata.empirical_status, 'stale_or_invalid');
  assert.equal(result.metadata.included_plans, 27);
  assert.equal(result.rows.filter(row => row.kind === 'api').length, data.aa.rows.length);
  assert.equal(empiricalRows(result).length, 0);
});
