import { auditMatchesPricing } from './token_scenario.mjs';
import { buildQuotaScenario, pricingRowsSha256, QUOTA_COMPONENTS } from './quota_scenario.mjs';
import { getRates } from './estimate_api_price.mjs';

const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const same = (a, b) => positive(a) && positive(b) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);
const origins = new Set(['direct_measurement', 'pooled_measurements', 'calibrated_measurement', 'plan_extrapolation']);
const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];

/** Замер задаёт условную ёмкость; он сам по себе не устанавливает веса списания. */
function empiricalRate(evidence, plan, variants) {
  if (!origins.has(evidence.evidence_method)) throw new Error('Нет проверенного практического основания: синтетическая смесь и неизвестное происхождение не допускаются.');
  if (evidence.model_id !== plan.model || !same(evidence.monthly_usd, plan.monthly_usd)) throw new Error('Модель или месячная плата не совпадает с проверенным тарифом.');
  if (!Array.isArray(evidence.source_urls) || !evidence.source_urls.length) throw new Error('Не указаны источники практического основания.');
  const empirical = {
    basis_label: evidence.basis_label,
    reason_ru: evidence.reason_ru,
    observed_monthly_tokens: positive(evidence.monthly_tokens) ? evidence.monthly_tokens : null,
  };
  let monthlyQuota, quotaUnit, componentRates, assumption;
  if (evidence.method === 'empirical_api_calibration') {
    const sample = evidence.calibration;
    if (!sample || ![sample.observed_api_usd, sample.quota_fraction, sample.periods_per_month, sample.plan_multiplier].every(positive)
      || sample.quota_fraction > 1) throw new Error('Неполные исходные числа API-калибровки.');
    monthlyQuota = sample.observed_api_usd / sample.quota_fraction * sample.periods_per_month * sample.plan_multiplier;
    quotaUnit = 'USD API-экв.';
    if (!positive(monthlyQuota)) throw new Error('Невозможно вычислить конечный API-эквивалент квоты.');
    if (!variants.length) throw new Error('В AA нет модели для калибровки.');
    componentRates = getRates(variants[0]);
    if (!QUOTA_COMPONENTS.every(key => positive(componentRates[key]))) throw new Error('Неизвестны API-ставки для переноса наблюдения на состав AA.');
    if (variants.some(variant => QUOTA_COMPONENTS.some(key => !same(getRates(variant)[key], componentRates[key])))) {
      throw new Error('API-ставки модели различаются по профилям; единая калибровка не подтверждена.');
    }
    empirical.calibration = { ...sample, monthly_api_equivalent_usd: monthlyQuota };
    assumption = 'API-калибровка: предполагается, что доля подписочной квоты пропорциональна API-стоимости нагрузки. Практический замер определяет коэффициент при этой гипотезе, но не доказывает её. Состав AA оплачивается по его категориям и ставкам; фиксированная смесь RAP не используется.';
  } else if (evidence.method === 'empirical_token_proxy') {
    if (!same(evidence.monthly_tokens, plan.monthly_tokens)) throw new Error('Наблюдённая ёмкость не совпадает с прошедшим аудит значением.');
    monthlyQuota = evidence.monthly_tokens / 1e6;
    quotaUnit = 'MTok';
    componentRates = Object.fromEntries(QUOTA_COMPONENTS.map(key => [key, 1]));
    assumption = 'Перенос наблюдённого объёма: условно сохраняем месячную токенную ёмкость замера и делим её на токены профиля AA. Равные веса категорий — условие этого сценария, а не тариф провайдера. Измеренная нагрузка может отличаться от AA; неизвестные cache/output-веса не восстановлены и не заменены смесью RAP.';
  } else throw new Error('Неизвестный способ переноса измерения.');
  return {
    id: plan.id, model_id: plan.model, plan: plan.plan, status: 'assumed', method: evidence.method,
    evidence_method: evidence.evidence_method, empirical,
    monthly_usd: plan.monthly_usd, monthly_quota: monthlyQuota, quota_unit: quotaUnit,
    component_rates: componentRates,
    component_rate_status: Object.fromEntries(QUOTA_COMPONENTS.map(key => [key, 'assumed'])),
    original_quota: empirical,
    rate_basis: { method: evidence.method, basis_label: evidence.basis_label, evidence_method: evidence.evidence_method },
    source_urls: [...evidence.source_urls],
    assumptions_ru: [assumption],
    notes_ru: unique([evidence.reason_ru, ...(evidence.notes_ru || [])]),
    shared_pool_note: 'Оценка выделяет доступную квоту одной модели. Пулы разных моделей одной подписки нельзя складывать. Пересчёт недельных наблюдений использует четыре недели, а не календарный месяц.',
  };
}

/** Расширяет известные ставки проверенными замерами, сохраняя отдельное происхождение каждого метода. */
export function buildExpandedQuotaScenario(aa, pricing, rates, evidence) {
  const evidenceValid = auditMatchesPricing(pricing, evidence);
  if (!evidenceValid) {
    const original = buildQuotaScenario(aa, pricing, rates);
    original.metadata.empirical_status = evidence ? 'stale_or_invalid' : 'missing';
    original.metadata.empirical_notes = ['Эмпирический аудит отсутствует или не соответствует исходному снимку. Подписки по проверенным ставкам сохранены.'];
    return original;
  }
  const added = evidence.additional_plans || [];
  if (!Array.isArray(added)) throw new Error('Неверный список дополнительных проверенных тарифов.');
  const ids = new Set(pricing.rows.map(row => row.id));
  for (const plan of added) {
    if (!plan?.id || ids.has(plan.id) || plan.billing !== 'subscription' || !positive(plan.monthly_usd)
      || !evidence.rows.some(row => row.id === plan.id && row.model_id === plan.model)) throw new Error('Дополнительный тариф не соответствует эмпирическому аудиту или повторяет существующий ID.');
    ids.add(plan.id);
  }
  const expandedPricing = { ...pricing, rows: [...pricing.rows, ...added] };
  const nativeValid = auditMatchesPricing(pricing, rates);
  const mergedRates = nativeValid ? [...rates.rows] : [];
  const nativeIds = new Set(mergedRates.map(row => row.id));
  const failures = new Map();
  for (const observation of evidence.rows) {
    if (nativeIds.has(observation.id)) continue;
    const plan = expandedPricing.rows.find(row => row.id === observation.id && row.billing === 'subscription');
    if (!plan) { failures.set(observation.id, 'В проверенном снимке нет соответствующего тарифа.'); continue; }
    try {
      mergedRates.push(empiricalRate(observation, plan, aa.rows.filter(row => row.model === plan.model)));
    } catch (error) { failures.set(observation.id, error.message); }
  }
  const merged = {
    metadata: {
      ...(nativeValid ? rates.metadata : {}),
      pricing_revision: expandedPricing.revision,
      pricing_retrieved_at_utc: expandedPricing.retrieved_at_utc,
      pricing_rows_sha256: pricingRowsSha256(expandedPricing),
      empirical_evidence_metadata: evidence.metadata,
    },
    rows: mergedRates,
  };
  const result = buildQuotaScenario(aa, expandedPricing, merged);
  for (const plan of result.excluded) {
    const failure = failures.get(plan.id);
    const explicit = evidence.excluded?.find(row => row.id === plan.id);
    if (failure || explicit) {
      plan.reasons = [failure || explicit.reason_ru];
      plan.notes = [...plan.reasons];
      if (explicit?.source_urls) plan.sources = [...explicit.source_urls];
    }
  }
  const empiricalPlans = result.plans.filter(plan => plan.included && plan.method?.startsWith('empirical_'));
  Object.assign(result.metadata, {
    method: 'aa_rates_and_empirical_observations',
    status: nativeValid && failures.size === 0 ? 'ok' : 'partial',
    notes: nativeValid ? [] : ['Исходный снимок ставок квоты не соответствует тарифам. Сохранены только отдельно проверенные практические наблюдения.'],
    empirical_status: failures.size ? 'partial' : 'ok',
    empirical_notes: [...failures].map(([id, reason]) => `${id}: ${reason}`),
    native_rates_status: nativeValid ? 'ok' : 'unavailable',
    pricing_source_rows_sha256: pricingRowsSha256(pricing),
    additional_plans: added.length,
    supplemental_source_revision: evidence.metadata.source_revision,
    empirical_plans: empiricalPlans.length,
    empirical_api_calibration_plans: empiricalPlans.filter(plan => plan.method === 'empirical_api_calibration').length,
    empirical_token_proxy_plans: empiricalPlans.filter(plan => plan.method === 'empirical_token_proxy').length,
    uses_rap_monthly_tokens: empiricalPlans.some(plan => plan.method === 'empirical_token_proxy'),
    uses_only_audited_observed_capacities: true,
    independent_of_rap_token_mix: true,
  });
  return result;
}
