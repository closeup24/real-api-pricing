import { createHash } from 'node:crypto';
import { estimateVariant } from './estimate_api_price.mjs';
import { isCost } from './calculate.mjs';

export const QUOTA_COMPONENTS = ['non_cache_input', 'cache_read', 'cache_write', 'answer', 'reasoning'];
const METHOD = 'aa_tokens_quota_rates';
const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];
const strings = value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
const finite = value => isCost(value) ? value : null;
const positive = value => isCost(value) && value > 0;
const almostEqual = (a, b) => isCost(a) && isCost(b) && Math.abs(a - b) <= Math.max(1e-10, Math.abs(b) * 1e-9);
const divide = (a, b) => isCost(a) && positive(b) && Number.isFinite(a / b) ? a / b : null;
const emptyComponents = () => Object.fromEntries(QUOTA_COMPONENTS.map(key => [key, null]));

/** Хешируется тот же JSON-массив строк, к которому привязан снимок ставок квоты. */
export function pricingRowsSha256(pricing) {
  return createHash('sha256').update(JSON.stringify(pricing.rows), 'utf8').digest('hex');
}

function snapshotGuard(pricing, rates) {
  if (!rates) return { status: 'missing_rates', notes: ['Снимок ставок квоты отсутствует; пересчёт подписок отключён.'] };
  if (!Array.isArray(rates.rows) || !rates.metadata) return { status: 'invalid_rates', notes: ['Неверная схема снимка ставок квоты; пересчёт подписок отключён.'] };
  const metadata = rates.metadata;
  if (!pricing.revision || !pricing.retrieved_at_utc
      || metadata.pricing_revision !== pricing.revision
      || metadata.pricing_retrieved_at_utc !== pricing.retrieved_at_utc
      || metadata.pricing_rows_sha256 !== pricingRowsSha256(pricing)) {
    return { status: 'stale_snapshot', notes: ['Ставки квоты не соответствуют текущему снимку цен: revision, дата или SHA256 строк отличаются. Пересчёт подписок отключён.'] };
  }
  const ids = rates.rows.map(row => row?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    return { status: 'invalid_rates', notes: ['В снимке ставок квоты отсутствуют или повторяются ID; пересчёт подписок отключён.'] };
  }
  return { status: 'ok', notes: [] };
}

function validatePlan(plan, rate, guard) {
  const reasons = [...guard.notes];
  if (guard.status !== 'ok') return reasons;
  if (!rate) return ['Для точного ID тарифа отсутствует описание квоты и её ставок.'];
  if (rate.model_id !== plan.model) reasons.push('Модель в описании квоты не совпадает с моделью тарифа.');
  if (!['documented', 'assumed'].includes(rate.status)) {
    const explanation = strings(rate.unavailable_reason_ru).filter(reason => typeof reason === 'string' && reason.trim());
    reasons.push(...(explanation.length ? explanation : ['Ставки расхода квоты недоступны или не подтверждены для расчёта.']));
    if (rate.status === 'unavailable') return reasons;
  }
  if (!isCost(rate.monthly_usd) || !almostEqual(rate.monthly_usd, plan.monthly_usd)) reasons.push('Плата за месяц отсутствует или не совпадает со снимком цен.');
  if (!positive(rate.monthly_quota)) reasons.push('Отсутствует положительная месячная квота.');
  if (typeof rate.quota_unit !== 'string' || !rate.quota_unit.trim()) reasons.push('Неизвестна единица квоты.');
  for (const key of QUOTA_COMPONENTS) {
    const value = rate.component_rates?.[key];
    if (!isCost(value)) reasons.push(`Неизвестна ставка квоты для категории ${key}.`);
    else if (value === 0 && rate.status !== 'documented' && !rate.zero_rate_documented_components?.includes(key)) {
      reasons.push(`Нулевая ставка ${key} требует документального подтверждения.`);
    }
  }
  return reasons;
}

/** Используется именно сумма восстановленных категорий, включая полный набор AA. */
function profile(variant, estimates, scope) {
  const estimate = estimates[scope];
  const tokens = Object.fromEntries(QUOTA_COMPONENTS.map(key => [key, finite(estimate.component_tokens?.[key])]));
  const known = QUOTA_COMPONENTS.every(key => tokens[key] !== null);
  const total = known ? QUOTA_COMPONENTS.reduce((sum, key) => sum + tokens[key], 0) : null;
  const totalTokens = positive(total) && Number.isFinite(total) ? total : null;
  const inversionStatus = scope === 'suite' ? estimate.inversion_status : estimate.status;
  const valid = ['consistent', 'approximate'].includes(inversionStatus) && totalTokens !== null;
  const apiCost = finite(scope === 'task' ? variant.cost_per_task_usd : variant.cost_total_usd);
  const componentTotal = scope === 'task' ? variant.cost_per_task_components_usd?.total : variant.cost_total_components_usd?.total;
  const matchingCost = apiCost !== null && almostEqual(apiCost, componentTotal);
  const approximate = estimate.status !== 'consistent' || variant.intelligence_index_estimated === true
    || variant.quality_flags?.includes('default_fallback_enabled');
  // Эти две подсказки относятся к другому экрану, где основной ценой является прямая оценка AA.
  const estimateNotes = strings(estimate.notes).filter(note => scope !== 'suite'
    || (!note.startsWith('Основная цена полного набора рассчитана напрямую') && !note.startsWith('Расхождение относится к восстановлению разбивки токенов; прямая цена')));
  const notes = unique([...estimates.notes, ...estimateNotes]);
  if (!matchingCost && apiCost !== null) notes.push('Опубликованная стоимость не согласована с агрегатом компонентов; профиль не используется для списания квоты.');
  if (variant.intelligence_index_estimated) notes.push('Intelligence Index этого варианта помечен AA как оценочный.');
  if (scope === 'suite') notes.push('Для квотного расчёта используются восстановленные категории полного набора; опубликованный общий счётчик служит отдельной сверкой и не заменяет их сумму.');
  return {
    valid: valid && matchingCost,
    status: !valid || !matchingCost ? (apiCost === null ? 'missing' : 'unavailable') : approximate ? 'approximate' : 'consistent',
    apiCost,
    totalTokens,
    tokens,
    apiPrice: totalTokens !== null && apiCost !== null ? finite(apiCost / totalTokens * 1e6) : null,
    reportedTotal: scope === 'suite' ? finite(estimate.reported_total_tokens) : null,
    reportedOutput: finite(estimate.reported_output_tokens),
    publishedPrice: scope === 'suite' ? finite(estimate.direct_price_usd_per_million) : null,
    outputError: estimate.output_relative_error_pct ?? null,
    totalError: estimate.total_relative_error_pct ?? null,
    notes,
  };
}

function commonMetric(value) {
  const sharesKnown = value.valid && value.totalTokens !== null;
  return {
    status: value.status,
    total_tokens: value.totalTokens,
    component_tokens: value.tokens,
    component_quota: emptyComponents(),
    quota_per_unit: null,
    cost_usd: null,
    effective_price_usd_per_million: null,
    api_price_usd_per_million: value.valid ? value.apiPrice : null,
    api_cost_usd: value.apiCost,
    units_per_month: null,
    units_per_100_usd: null,
    cache_read_share: sharesKnown ? value.tokens.cache_read / value.totalTokens : null,
    non_cache_input_share: sharesKnown ? value.tokens.non_cache_input / value.totalTokens : null,
    cache_write_share: sharesKnown ? value.tokens.cache_write / value.totalTokens : null,
    input_without_cache_read_share: sharesKnown ? (value.tokens.non_cache_input + value.tokens.cache_write) / value.totalTokens : null,
    output_share: sharesKnown ? (value.tokens.answer + value.tokens.reasoning) / value.totalTokens : null,
    reported_total_tokens: value.reportedTotal,
    reported_output_tokens: value.reportedOutput,
    published_effective_price_usd_per_million: value.publishedPrice,
    output_relative_error_pct: value.outputError,
    total_relative_error_pct: value.totalError,
    notes: [...value.notes],
  };
}

function apiMetric(value) {
  const result = commonMetric(value);
  result.cost_usd = value.apiCost;
  result.effective_price_usd_per_million = value.valid ? value.apiPrice : null;
  result.units_per_100_usd = divide(100, value.apiCost);
  if (value.apiCost !== null && !value.valid) {
    result.status = 'approximate';
    result.notes.push('Исходная API-стоимость AA сохранена, но профиль токенов не позволяет вычислить все производные показатели.');
  }
  return result;
}

function subscriptionMetric(value, rate) {
  const result = commonMetric(value);
  if (!value.valid) return result;
  result.component_quota = Object.fromEntries(QUOTA_COMPONENTS.map(key => [key, value.tokens[key] * rate.component_rates[key] / 1e6]));
  const usage = QUOTA_COMPONENTS.reduce((sum, key) => sum + result.component_quota[key], 0);
  const cost = rate.monthly_usd * usage / rate.monthly_quota;
  const effective = cost / value.totalTokens * 1e6;
  if (![usage, cost, effective].every(isCost)) {
    result.status = 'unavailable';
    result.component_quota = emptyComponents();
    result.notes.push('Числа вышли за допустимый диапазон; результат списания квоты не опубликован.');
    return result;
  }
  result.quota_per_unit = usage;
  result.cost_usd = cost;
  result.effective_price_usd_per_million = effective;
  result.units_per_month = divide(rate.monthly_quota, usage);
  result.units_per_100_usd = divide(100, cost);
  result.status = rate.status === 'assumed' || value.status === 'approximate' ? 'approximate' : 'consistent';
  if (usage === 0) result.notes.push('Ставки дают нулевое списание квоты; конечную ёмкость нельзя определить только по этим ставкам.');
  if (rate.monthly_usd === 0) result.notes.push('Месячная плата равна нулю; показатель на $100 не определён.');
  return result;
}

function overallStatus(task, suite) {
  if (task.status === 'consistent' && suite.status === 'consistent') return 'consistent';
  if ([task.cost_usd, suite.cost_usd].some(value => value !== null)) return 'approximate';
  return task.status === 'missing' && suite.status === 'missing' ? 'missing' : 'unavailable';
}

/** Списывает квоты по составу AA; смесь RAP и её месячная token-ёмкость не используются. */
export function buildQuotaScenario(aa, pricing, rates) {
  if (!Array.isArray(aa?.rows) || !Array.isArray(pricing?.rows)) throw new TypeError('Нужны массивы AA и тарифов.');
  const pricingIds = pricing.rows.map(row => row.id);
  const aaIds = aa.rows.map(row => row.source_id);
  if (pricingIds.some(id => !id) || new Set(pricingIds).size !== pricingIds.length) throw new Error('ID строк тарифов отсутствуют или повторяются.');
  if (aaIds.some(id => !id) || new Set(aaIds).size !== aaIds.length) throw new Error('ID вариантов AA отсутствуют или повторяются.');
  const guard = snapshotGuard(pricing, rates);
  const rateMap = new Map(guard.status === 'ok' ? rates.rows.map(row => [row.id, row]) : []);
  const modelIds = new Set(aa.rows.map(row => row.model));
  const excluded = [];
  const subscriptions = pricing.rows.filter(row => row.billing === 'subscription');
  const plans = subscriptions.map(plan => {
    const rate = rateMap.get(plan.id);
    const reasons = validatePlan(plan, rate, guard);
    if (!modelIds.has(plan.model)) reasons.push('В снимке AA нет точной модели этого тарифа.');
    const included = reasons.length === 0;
    const notes = unique([...strings(rate?.assumptions_ru), ...strings(rate?.notes_ru), ...strings(rate?.shared_pool_note), ...reasons]);
    const descriptor = {
      id: plan.id, model_id: plan.model, plan: plan.plan, plan_id: plan.plan_id,
      monthly_usd: finite(plan.monthly_usd), monthly_quota: finite(rate?.monthly_quota), quota_unit: rate?.quota_unit ?? null,
      component_rates: Object.fromEntries(QUOTA_COMPONENTS.map(key => [key, finite(rate?.component_rates?.[key])])),
      component_rate_status: rate?.component_rate_status ?? null,
      status: included ? rate.status : 'unavailable', included,
      confidence: rate?.status ?? 'unavailable',
      method: rate?.method ?? METHOD,
      evidence_method: rate?.evidence_method,
      empirical: rate?.empirical,
      original_quota: rate?.original_quota ?? null, rate_basis: rate?.rate_basis ?? null,
      shared_pool_note: rate?.shared_pool_note ?? null,
      additional_limits: rate?.additional_limits ?? null,
      capacity_multiplier: rate?.capacity_multiplier ?? null,
      charge_multiplier: rate?.charge_multiplier ?? null,
      sources: unique(strings(rate?.source_urls)), notes,
    };
    if (!included) excluded.push({ ...descriptor, reasons });
    return descriptor;
  });
  if (guard.status === 'ok') {
    for (const rate of rates.rows) {
      if (!subscriptions.some(plan => plan.id === rate.id)) excluded.push({id: rate.id, model_id: rate.model_id, plan: rate.plan, status: 'unavailable', reasons: ['ID ставки не соответствует подписке текущего снимка.'], notes: [], sources: unique(strings(rate.source_urls))});
    }
  }
  const rows = [];
  for (const variant of aa.rows) {
    const estimates = estimateVariant(variant);
    const taskProfile = profile(variant, estimates, 'task');
    const suiteProfile = profile(variant, estimates, 'suite');
    const common = {
      model_id: variant.model, model: variant.model_display, effort: variant.effort,
      effort_label: variant.effort_label, effort_level: variant.effort_level,
      source_id: variant.source_id, source_name: variant.source_name,
      intelligence_index: variant.intelligence_index, estimated: variant.intelligence_index_estimated,
      aa_version: variant.source_version, method: METHOD,
    };
    const apiTask = apiMetric(taskProfile);
    const apiSuite = apiMetric(suiteProfile);
    rows.push({
      ...common, id: `${variant.source_id}::quota-api-aa`, kind: 'api', plan: 'API · исходная стоимость AA', plan_id: 'api-aa',
      confidence: 'source', monthly_usd: null, monthly_quota: null, quota_unit: null, method: 'aa_original_api',
      status: overallStatus(apiTask, apiSuite), notes: unique(estimates.notes), sources: unique([variant.source]),
      task: apiTask, suite: apiSuite,
    });
    for (const plan of plans.filter(plan => plan.included && plan.model_id === variant.model)) {
      const rate = rateMap.get(plan.id);
      const task = subscriptionMetric(taskProfile, rate);
      const suite = subscriptionMetric(suiteProfile, rate);
      rows.push({
        ...common, id: `${variant.source_id}::quota::${plan.id}`, kind: 'subscription', plan: plan.plan, plan_id: plan.plan_id,
        pricing_id: plan.id, confidence: rate.status, monthly_usd: rate.monthly_usd, monthly_quota: rate.monthly_quota, quota_unit: rate.quota_unit,
        method: rate.method ?? METHOD, evidence_method: rate.evidence_method, empirical: rate.empirical,
        original_quota: rate.original_quota ?? null, component_rates: { ...rate.component_rates }, rate_basis: rate.rate_basis,
        component_rate_status: rate.component_rate_status ?? null,
        shared_pool_note: rate.shared_pool_note ?? null,
        additional_limits: rate.additional_limits ?? null,
        capacity_multiplier: rate.capacity_multiplier ?? null,
        charge_multiplier: rate.charge_multiplier ?? null,
        status: overallStatus(task, suite),
        notes: unique([...plan.notes, ...estimates.notes, 'Расчёт предполагает использование полной месячной квоты только этой моделью и данным профилем задач AA; отдельные временные ограничения и доступность effort могут уменьшить ёмкость.']),
        sources: unique([variant.source, ...plan.sources]), task, suite,
      });
    }
  }
  const coverage = [...modelIds].map(modelId => {
    const variants = aa.rows.filter(row => row.model === modelId);
    const modelPlans = plans.filter(plan => plan.model_id === modelId);
    const included = modelPlans.filter(plan => plan.included);
    return {
      model_id: modelId, model: variants[0].model_display, variants: variants.length,
      subscription_plans: modelPlans.length, included_plans: included.length, excluded_plans: modelPlans.length - included.length,
      subscription_rows: rows.filter(row => row.model_id === modelId && row.kind === 'subscription').length,
      priced_variants: variants.filter(variant => positive(variant.cost_per_task_usd) && positive(variant.cost_total_usd)).length,
      status: included.length ? 'available' : 'api_only',
      notes: included.length ? [] : ['Нет пригодного описания квоты и ставок; доступны исходные API-стоимости AA.'],
    };
  });
  return {
    metadata: {
      schema_version: 1, method: METHOD, status: guard.status, notes: guard.notes,
      aa_version: aa.metadata?.intelligence_index_version ?? null, aa_retrieved_at: aa.metadata?.retrieved_at ?? null,
      pricing_revision: pricing.revision ?? null, pricing_retrieved_at_utc: pricing.retrieved_at_utc ?? null,
      pricing_rows_sha256: pricingRowsSha256(pricing), quota_rates_metadata: rates?.metadata ?? null,
      model_count: modelIds.size, variant_count: aa.rows.length, api_rows: aa.rows.length,
      included_plans: plans.filter(plan => plan.included).length, excluded_plans: plans.filter(plan => !plan.included).length,
      subscription_rows: rows.filter(row => row.kind === 'subscription').length,
      formula: 'quota_usage = sum(token_count[type] * quota_rate[type] / 1e6); cost = monthly_fee * quota_usage / monthly_quota',
      task_count_formula: 'units_per_month = monthly_quota / quota_usage',
      independent_of_rap_token_mix: true, uses_rap_monthly_tokens: false,
      suite_token_basis: 'sum_of_inverted_non_overlapping_categories',
    },
    coverage, plans, excluded, rows,
  };
}
