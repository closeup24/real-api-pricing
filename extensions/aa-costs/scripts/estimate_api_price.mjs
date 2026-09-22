import { isCost } from './calculate.mjs';

const COMPONENTS = {
  non_cache_input: 'nonCacheInput',
  cache_read: 'cacheRead',
  cache_write: 'cacheWrite',
  answer: 'answer',
  reasoning: 'reasoning',
};
const UNKNOWN_TOKEN_SHARES = {
  output_share: null,
  cache_read_share: null,
  non_cache_input_share: null,
  cache_write_share: null,
  input_without_cache_read_share: null,
};
const TOLERANCE_PCT = 0.000001;
const sum = values => values.reduce((total, value) => total + value, 0);
const relativeError = (calculated, reported) => isCost(calculated) && isCost(reported)
  ? reported > 0 ? 100 * (calculated - reported) / reported : calculated === 0 ? 0 : null
  : null;

/** Ставки AA; неизвестная цена записи рассматривается явно, а не заменяется нулём. */
export function getRates(variant) {
  return {
    non_cache_input: variant.api_price_input_usd_per_million,
    cache_read: variant.api_price_cache_hit_usd_per_million,
    cache_write: variant.api_price_cache_write_usd_per_million ?? variant.api_price_input_usd_per_million,
    answer: variant.api_price_output_usd_per_million,
    reasoning: variant.api_price_reasoning_usd_per_million ?? variant.api_price_output_usd_per_million,
  };
}

/** Восстанавливает непересекающиеся категории токенов; агрегаты input/output не суммируются повторно. */
export function invertCosts(costs, rates) {
  if (!costs || !isCost(costs.total)) return {status:'missing', ...UNKNOWN_TOKEN_SHARES, notes:['AA не опубликовал стоимость.']};
  const componentTokens = {};
  const componentCosts = {};
  const issues = [];
  for (const [key, sourceKey] of Object.entries(COMPONENTS)) {
    const cost = costs[sourceKey];
    const rate = rates[key];
    componentCosts[key] = isCost(cost) ? cost : null;
    if (!isCost(cost)) {
      issues.push(`Неизвестен расход категории ${sourceKey}.`);
      componentTokens[key] = null;
    } else if (!isCost(rate) || rate === 0) {
      issues.push(`Нельзя восстановить ${sourceKey}: ставка отсутствует или равна нулю, даже если расход нулевой.`);
      componentTokens[key] = null;
    } else {
      componentTokens[key] = cost / rate * 1e6;
    }
  }
  if (issues.length) return {status:'unavailable',price_usd_per_million:null,cost_usd:costs.total,rates_usd_per_million:rates,component_tokens:componentTokens,component_costs_usd:componentCosts,...UNKNOWN_TOKEN_SHARES,notes:issues};
  const inputTokens = componentTokens.non_cache_input + componentTokens.cache_read + componentTokens.cache_write;
  const outputTokens = componentTokens.answer + componentTokens.reasoning;
  const totalTokens = inputTokens + outputTokens;
  const componentSum = sum(Object.values(componentCosts));
  const aggregateError = relativeError(componentSum, costs.total);
  const aggregateInputError = relativeError(componentCosts.non_cache_input + componentCosts.cache_read + componentCosts.cache_write, costs.input);
  const aggregateOutputError = relativeError(componentCosts.answer + componentCosts.reasoning, costs.output);
  const validAggregates = [aggregateError,aggregateInputError,aggregateOutputError].every(error => error != null && Math.abs(error) <= TOLERANCE_PCT);
  if (!validAggregates) issues.push('Суммы непересекающихся категорий не согласованы с опубликованными агрегатами расходов.');
  const inversePrice = totalTokens > 0 ? costs.total / totalTokens * 1e6 : null;
  return {
    status: validAggregates && inversePrice != null ? 'consistent' : 'unavailable',
    price_usd_per_million: validAggregates ? inversePrice : null,
    inverse_price_usd_per_million: validAggregates ? inversePrice : null,
    cost_usd: costs.total,
    total_tokens: totalTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    output_share: totalTokens > 0 ? outputTokens / totalTokens : null,
    cache_read_share: totalTokens > 0 ? componentTokens.cache_read / totalTokens : null,
    non_cache_input_share: totalTokens > 0 ? componentTokens.non_cache_input / totalTokens : null,
    cache_write_share: totalTokens > 0 ? componentTokens.cache_write / totalTokens : null,
    input_without_cache_read_share: totalTokens > 0 ? (componentTokens.non_cache_input + componentTokens.cache_write) / totalTokens : null,
    component_tokens: componentTokens,
    component_costs_usd: componentCosts,
    rates_usd_per_million: rates,
    cost_sum_relative_error_pct: aggregateError,
    input_cost_sum_relative_error_pct: aggregateInputError,
    output_cost_sum_relative_error_pct: aggregateOutputError,
    notes: issues,
  };
}

/** Объём токенов полного набора опубликован независимо от выбранной здесь инверсии ставок. */
export function estimateVariant(variant) {
  const rates = getRates(variant);
  const task = invertCosts(variant.cost_per_task_components_usd, rates);
  const suite = invertCosts(variant.cost_total_components_usd, rates);
  const notes = [];
  if (variant.api_price_cache_write_usd_per_million == null) notes.push('Ставка cache write не опубликована отдельно; для инверсии принята обычная input-ставка. Это предположение проверяется по полному числу input-токенов.');
  if (variant.api_price_reasoning_usd_per_million == null) notes.push('Reasoning рассчитан по опубликованному output-тарифу; отдельной ставки AA не даёт.');
  if (variant.quality_flags?.includes('default_fallback_enabled')) notes.push('AA помечает вариант Default Fallback. Единая ставка для всех вызовов может не описывать эту конфигурацию; причина остаточного расхождения не установлена.');

  const taskOutput = variant.intelligence_index_output_tokens_per_task;
  task.reported_output_tokens = isCost(taskOutput?.output) ? taskOutput.output : null;
  task.output_relative_error_pct = relativeError(task.output_tokens, taskOutput?.output);
  task.answer_relative_error_pct = relativeError(task.component_tokens?.answer, taskOutput?.answer);
  task.reasoning_relative_error_pct = relativeError(task.component_tokens?.reasoning, taskOutput?.reasoning);
  task.price_method = 'cost_components_inversion';
  if (task.status === 'consistent') {
    task.notes.push('Опубликованные output-токены дают частичную сверку. Полного input-счётчика для взвешенной задачи в источнике нет.');
    const errors = [task.output_relative_error_pct,task.answer_relative_error_pct,task.reasoning_relative_error_pct];
    if (errors.some(error => error == null || Math.abs(error) > TOLERANCE_PCT)) {
      task.status = 'approximate';
      task.notes.push('Восстановленные output-токены расходятся с опубликованными; результат — эквивалент по указанным ставкам.');
    }
  }

  const totalPublished = variant.canonical_intelligence_index_token_count;
  const reportedTotal = isCost(totalPublished?.input) && isCost(totalPublished?.output) ? totalPublished.input + totalPublished.output : null;
  suite.reported_input_tokens = isCost(totalPublished?.input) ? totalPublished.input : null;
  suite.reported_output_tokens = isCost(totalPublished?.output) ? totalPublished.output : null;
  suite.reported_total_tokens = reportedTotal;
  suite.total_relative_error_pct = relativeError(suite.total_tokens, reportedTotal);
  suite.input_relative_error_pct = relativeError(suite.input_tokens, totalPublished?.input);
  suite.output_relative_error_pct = relativeError(suite.output_tokens, totalPublished?.output);
  suite.answer_relative_error_pct = relativeError(suite.component_tokens?.answer, totalPublished?.answer);
  suite.reasoning_relative_error_pct = relativeError(suite.component_tokens?.reasoning, totalPublished?.reasoning);
  suite.direct_price_usd_per_million = isCost(variant.cost_total_usd) && reportedTotal > 0 ? variant.cost_total_usd / reportedTotal * 1e6 : null;
  suite.price_usd_per_million = suite.direct_price_usd_per_million;
  suite.price_method = 'published_total_cost_divided_by_published_total_tokens';
  suite.inverse_price_relative_error_pct = relativeError(suite.inverse_price_usd_per_million, suite.direct_price_usd_per_million);
  suite.inversion_status = suite.status;
  if (suite.price_usd_per_million == null) suite.status = 'missing';
  else {
    const errors = [suite.input_relative_error_pct,suite.output_relative_error_pct,suite.answer_relative_error_pct,suite.reasoning_relative_error_pct];
    suite.status = suite.inversion_status === 'consistent' && errors.every(error => error != null && Math.abs(error) <= TOLERANCE_PCT) ? 'consistent' : 'approximate';
    suite.notes.push('Основная цена полного набора рассчитана напрямую по опубликованным input + output, без инверсии ставок.');
    if (suite.status === 'approximate') suite.notes.push('Расхождение относится к восстановлению разбивки токенов; прямая цена полного набора не использует эту разбивку.');
  }
  return {task,suite,notes};
}

function range(rows, field) {
  const values = rows.map(row => row[field].price_usd_per_million).filter(value => isCost(value) && value > 0);
  return values.length ? {count:values.length,min:Math.min(...values),max:Math.max(...values),spread_pct:values.length > 1 ? 100 * (Math.max(...values) / Math.min(...values) - 1) : null} : {count:0,min:null,max:null,spread_pct:null};
}

/** Основная оценка использует только AA; RAP нужен исключительно для столбцов сравнения. */
export function estimateApiPrices(aa, pricing) {
  const mix = pricing.standard_token_mix;
  const rows = aa.rows.map(variant => {
    const estimates = estimateVariant(variant);
    const baseline = pricing.rows.find(row => row.model === variant.model && row.is_api_baseline);
    const fixedMixInputs = [mix?.cache,mix?.input,mix?.output,variant.api_price_cache_hit_usd_per_million,variant.api_price_input_usd_per_million,variant.api_price_output_usd_per_million];
    const fixed = fixedMixInputs.every(isCost) ? mix.cache * variant.api_price_cache_hit_usd_per_million + mix.input * variant.api_price_input_usd_per_million + mix.output * variant.api_price_output_usd_per_million : null;
    return {
      model_id:variant.model, model:variant.model_display, effort:variant.effort, effort_level:variant.effort_level,
      source_id:variant.source_id,source_url:variant.source,source_name:variant.source_name,
      rap_price_usd_per_million:baseline?.api_price_usd_per_million ?? null,
      rap_price_origin:baseline?.api_baseline_kind ?? null,
      rap_independent_reference:baseline != null && baseline.api_baseline_kind !== 'aa_prices_rap_mix',
      aa_fixed_mix_price_usd_per_million:isCost(fixed) ? fixed : null,
      ...estimates,
    };
  });
  const summary = [...new Set(rows.map(row=>row.model_id))].map(modelId => {
    const variants = rows.filter(row=>row.model_id===modelId);
    const task = range(variants,'task');
    const suite = range(variants,'suite');
    return {
      model_id:modelId,model:variants[0].model,variants:variants.length,
      task_variants:task.count,suite_variants:suite.count,
      task_min:task.min,task_max:task.max,task_spread_pct:task.spread_pct,
      suite_min:suite.min,suite_max:suite.max,suite_spread_pct:suite.spread_pct,
      rap_price_usd_per_million:variants[0].rap_price_usd_per_million,
      aa_fixed_mix_price_usd_per_million:variants[0].aa_fixed_mix_price_usd_per_million,
      notes:[...(variants.some(row=>row.task.status==='approximate') ? ['Для части вариантов инверсия не проходит точную сверку output.'] : []),...(task.count < 2 ? ['Недостаточно опубликованных стоимостей разных effort для проверки стабильности.'] : [])],
    };
  });
  return {
    metadata:{
      source_version:aa.metadata.intelligence_index_version,source_retrieved_at:aa.metadata.retrieved_at,
      tolerance_pct:TOLERANCE_PCT,units:'USD / 1 000 000 tokens',
      task_method:'Токены каждой категории = расходы категории / её ставка × 1 000 000; цена = стоимость взвешенной задачи / сумма восстановленных токенов × 1 000 000.',
      suite_method:'Цена полного набора = его стоимость / (опубликованные input + output) × 1 000 000. Инверсия категорий служит отдельной проверкой.',
      validation:'Сумма расходов — проверка арифметики. Независимая от нашей инверсии сверка — опубликованные AA output-токены задачи и input/output полного набора. Совпадение не доказывает переносимость на другую нагрузку.',
      effort_hypothesis:'Ставки могут совпадать, а средняя цена — различаться из-за долей cache read, cache write и output. Постоянство цены между effort не требуется.',
      rap_comparison:'Смесь RAP фиксирована: 97,5% cache read, 2,15% input, 0,35% output. AA использует фактическую смесь; эти средние цены могут различаться. API-базы, ранее дополненные из AA, не являются независимым сравнением с RAP.',
      complete_variants:rows.filter(row=>row.task.price_usd_per_million!=null&&row.suite.price_usd_per_million!=null).length,
      task_output_consistent:rows.filter(row=>row.task.status==='consistent').length,
      suite_components_consistent:rows.filter(row=>row.suite.status==='consistent').length,
      approximate_variants:rows.filter(row=>row.task.status==='approximate'||row.suite.status==='approximate').length,
    },rows,summary,
  };
}
