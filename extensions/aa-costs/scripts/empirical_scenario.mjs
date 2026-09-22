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
  } else throw new Error('Для пересчёта на состав AA нужны ставки списания либо API-калибровка полного замера. Общий токенный объём и равные веса категорий не используются.');
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

/** Сохраняет тарифы без ставок в основной таблице, не превращая неизвестную цену в ноль. */
function retainUnavailablePlans(result) {
  const apiRows = result.rows.filter(row => row.kind === 'api');
  const unavailableMetric = (metric, notes) => ({
    ...structuredClone(metric), status: 'unavailable', cost_usd: null,
    effective_price_usd_per_million: null, quota_per_unit: null,
    component_quota: Object.fromEntries(QUOTA_COMPONENTS.map(key => [key, null])),
    units_per_month: null, units_per_100_usd: null,
    notes: unique([...notes, ...(metric.notes || [])]),
  });
  for (const plan of result.plans.filter(plan => !plan.included)) {
    for (const api of apiRows.filter(row => row.model_id === plan.model_id)) {
      result.rows.push({
        ...api, id: `${api.source_id}::quota::${plan.id}`, kind: 'subscription',
        plan: plan.plan, plan_id: plan.plan_id, pricing_id: plan.id,
        monthly_usd: plan.monthly_usd, monthly_quota: null, quota_unit: null,
        component_rates: Object.fromEntries(QUOTA_COMPONENTS.map(key => [key, null])),
        method: 'unavailable_quota_weights', confidence: 'unavailable', status: 'unavailable',
        evidence_method: plan.evidence_method, empirical: plan.empirical,
        notes: unique(plan.notes || []), sources: unique([...api.sources, ...plan.sources]),
        task: unavailableMetric(api.task, plan.notes), suite: unavailableMetric(api.suite, plan.notes),
      });
    }
  }
  const subscriptions = result.rows.filter(row => row.kind === 'subscription');
  Object.assign(result.metadata, {
    subscription_rows: subscriptions.length,
    priced_subscription_rows: subscriptions.filter(row => row.task.cost_usd !== null || row.suite.cost_usd !== null).length,
    unavailable_subscription_rows: subscriptions.filter(row => row.task.cost_usd === null && row.suite.cost_usd === null).length,
    unavailable_weight_plans: result.plans.filter(plan => !plan.included).length,
    token_volume_source: 'aa_component_costs_divided_by_aa_rates',
    uses_rap_monthly_tokens: false,
    uses_equal_token_weights_fallback: false,
  });
  for (const coverage of result.coverage) {
    const rows = subscriptions.filter(row => row.model_id === coverage.model_id);
    coverage.subscription_rows = rows.length;
    coverage.unavailable_subscription_rows = rows.filter(row => row.task.cost_usd === null && row.suite.cost_usd === null).length;
  }
  return result;
}

/** Расширяет известные ставки проверенными замерами, сохраняя отдельное происхождение каждого метода. */
export function buildExpandedQuotaScenario(aa, pricing, rates, evidence) {
  const evidenceValid = auditMatchesPricing(pricing, evidence);
  if (!evidenceValid) {
    const original = buildQuotaScenario(aa, pricing, rates);
    original.metadata.empirical_status = evidence ? 'stale_or_invalid' : 'missing';
    original.metadata.empirical_notes = ['Эмпирический аудит отсутствует или не соответствует исходному снимку. Подписки по проверенным ставкам сохранены.'];
    if (original.metadata.status === 'ok') original.metadata.status = 'partial';
    original.metadata.notes = unique([...original.metadata.notes, ...original.metadata.empirical_notes]);
    return retainUnavailablePlans(original);
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
  const unavailable = new Map();
  for (const observation of evidence.rows) {
    if (nativeIds.has(observation.id)) continue;
    const plan = expandedPricing.rows.find(row => row.id === observation.id && row.billing === 'subscription');
    if (!plan) { failures.set(observation.id, 'В проверенном снимке нет соответствующего тарифа.'); continue; }
    if (observation.method === 'unavailable_quota_weights') {
      unavailable.set(observation.id, observation.missing_data_ru || 'Нет ставок списания или полного замера для API-калибровки; общий токенный объём не переносится на смесь AA.');
      continue;
    }
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
  for (const plan of [...result.excluded, ...result.plans.filter(plan => !plan.included)]) {
    const failure = failures.get(plan.id);
    const missing = unavailable.get(plan.id);
    const observation = evidence.rows.find(row => row.id === plan.id);
    const explicit = evidence.excluded?.find(row => row.id === plan.id);
    plan.method = 'unavailable_quota_weights';
    plan.confidence = 'unavailable';
    if (failure || missing || explicit) {
      plan.reasons = [failure || missing || explicit.reason_ru];
      plan.notes = unique([...plan.reasons, observation?.reason_ru, ...(observation?.notes_ru || [])]);
      plan.sources = unique([...(observation?.source_urls || []), ...(explicit?.source_urls || [])]);
      plan.evidence_method = observation?.evidence_method;
    }
  }
  const empiricalPlans = result.plans.filter(plan => plan.included && plan.method?.startsWith('empirical_'));
  Object.assign(result.metadata, {
    method: 'aa_tokens_times_quota_weights',
    status: nativeValid && failures.size === 0 ? 'ok' : 'partial',
    notes: [...(nativeValid ? [] : ['Исходный снимок ставок квоты не соответствует тарифам. Сохранены только отдельно проверенные практические наблюдения.']), ...[...failures].map(([id, reason]) => `${id}: ${reason}`)],
    empirical_status: failures.size ? 'partial' : 'ok',
    empirical_notes: [...failures].map(([id, reason]) => `${id}: ${reason}`),
    native_rates_status: nativeValid ? 'ok' : 'unavailable',
    pricing_source_rows_sha256: pricingRowsSha256(pricing),
    additional_plans: added.length,
    supplemental_source_revision: evidence.metadata.source_revision,
    empirical_plans: empiricalPlans.length,
    empirical_api_calibration_plans: empiricalPlans.filter(plan => plan.method === 'empirical_api_calibration').length,
    empirical_token_proxy_plans: 0,
    independent_of_rap_token_mix: true,
  });
  return retainUnavailablePlans(result);
}
