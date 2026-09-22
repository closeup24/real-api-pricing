import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAaData } from './build-aa-data.mjs';
import { estimateVariant } from '../../extensions/aa-costs/scripts/estimate_api_price.mjs';

const read = async path => JSON.parse(await readFile(new URL(`../../extensions/aa-costs/data/${path}`, import.meta.url), 'utf8'));
const [aa, pricing, rates, audit, weighting] = await Promise.all([
  read('aa/aa.json'), read('pricing/pricing.json'), read('pricing/quota-rates.json'),
  read('pricing/quota-evidence.json'), read('aa/task-weighting.json'),
]);
const reference = createAaData(aa, pricing, rates, audit, weighting);

test('Основная вкладка получает обычные подписки, метод переноса и исходные числа замера', async () => {
  const empirical = await read('pricing/empirical-evidence.json');
  const data = createAaData(aa, pricing, rates, audit, weighting, empirical);
  assert.equal(data.quota_scenario.metadata.included_plans, 41);
  assert.equal(data.metadata.row_count, data.quota_scenario.rows.length);
  const luna = data.quota_scenario.rows.find(row => row.pricing_id === 'chatgpt_plus::gpt-5.6-luna');
  assert.equal(luna.method, 'empirical_api_calibration');
  assert.equal(luna.empirical.calibration.quota_fraction, .06);
  assert.equal(luna.empirical.calibration.sample_components.length, 3);
  const claude = data.quota_scenario.rows.find(row => row.pricing_id === 'claude_max_20x::claude-opus-5');
  assert.equal(claude.method, 'unavailable_quota_weights');
  assert.equal(claude.task.cost_usd, null);
  assert.ok(claude.task.total_tokens > 0);
  assert.ok(claude.sources.length > 0);
  assert.deepEqual(data.api_estimate, reference.api_estimate);
  assert.equal('token_scenario' in data, false);
});

for (const [name, mixture] of [['без смеси RAP', undefined], ['с неверной смесью RAP', { cache: -4, input: 20, output: 'неизвестно' }]]) {
  test(`Новая сборка ${name} сохраняет квоты и инверсию AA`, () => {
    const changed = structuredClone(pricing);
    if (mixture === undefined) delete changed.standard_token_mix;
    else changed.standard_token_mix = mixture;
    const actual = createAaData(aa, changed, rates, audit, weighting);
    assert.equal(actual.quota_scenario.metadata.status, 'partial');
    assert.equal(actual.quota_scenario.metadata.included_plans, 27);
    assert.deepEqual(actual.quota_scenario, reference.quota_scenario);
    assert.deepEqual(actual.api_estimate, reference.api_estimate);
    assert.equal('token_scenario' in actual, false);
  });
}

test('Astra: Plus и оба Pro сравниваются через API-калибровку, а неполный счётчик Plus не задаёт ёмкость', async () => {
  const empirical = await read('pricing/empirical-evidence.json');
  const data = createAaData(aa, pricing, rates, audit, weighting, empirical);
  const observed = [
    ['chatgpt_plus', 20, (514_000 * 10 + 3_948_000 + 16_000 * 50) / 1e6, .14],
    ['chatgpt_pro_5x', 100, (5_178_076 * 10 + 192_381_312 + 868_914 * 50) / 1e6, .86],
    ['chatgpt_pro_20x', 200, (16_835_563 * 10 + 584_864_000 + 3_374_930 * 50) / 1e6, .75],
  ];
  for (const [plan, fee, sampleCost, fraction] of observed) {
    const rows = data.quota_scenario.rows.filter(row => row.pricing_id === `${plan}::gpt-6-astra`);
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.method, 'empirical_api_calibration');
      assert.equal(row.confidence, 'assumed');
      const expectedPool = sampleCost / fraction * 4;
      assert.ok(Math.abs(row.monthly_quota - expectedPool) < 1e-9);
      for (const scope of ['task', 'suite']) {
        const api = data.quota_scenario.rows.find(item => item.source_id === row.source_id && item.kind === 'api');
        assert.ok(Math.abs(row[scope].cost_usd - fee * api[scope].cost_usd / expectedPool) < 1e-9);
      }
    }
  }
  const plus = data.quota_scenario.rows.find(row => row.pricing_id === 'chatgpt_plus::gpt-6-astra' && row.effort === 'max');
  assert.ok(Math.abs(plus.task.cost_usd - .23060782963575968) < 1e-12);
  assert.notEqual(plus.monthly_quota, 159);
  assert.match(plus.notes.join(' '), /публичной ссылки на исходную панель нет/);
  assert.match(plus.notes.join(' '), /не доверительный интервал/);
});

test('Каждый разбор сохраняет точный source_id, effort и пять исходных категорий', () => {
  assert.equal(reference.api_estimate.rows.length, aa.rows.length);
  for (const variant of aa.rows) {
    const row = reference.api_estimate.rows.find(item => item.source_id === variant.source_id);
    assert.ok(row);
    assert.equal(row.model_id, variant.model);
    assert.equal(row.model, variant.model_display);
    assert.equal(row.effort, variant.effort);
    const expected = estimateVariant(variant);
    for (const scope of ['task', 'suite']) {
      assert.deepEqual(row[scope].component_tokens, expected[scope].component_tokens);
      assert.deepEqual(row[scope].component_costs_usd, expected[scope].component_costs_usd);
      assert.deepEqual(row[scope].rates_usd_per_million, expected[scope].rates_usd_per_million);
    }
  }
});

test('Несовпадающий снимок весов исключается, а ошибка нового расчёта не скрывается', () => {
  const changed = structuredClone(weighting);
  changed.metadata.source_snapshot_retrieved_at = 'другой снимок';
  assert.equal(createAaData(aa, pricing, rates, audit, changed).aa_task_weighting, null);
  assert.deepEqual(reference.aa_task_weighting, weighting);
  const invalidAa = structuredClone(aa);
  invalidAa.rows.push(structuredClone(aa.rows[0]));
  assert.throws(() => createAaData(invalidAa, pricing, rates, audit, weighting));
});
