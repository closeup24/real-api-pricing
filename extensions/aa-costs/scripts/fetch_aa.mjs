// Извлечение публичных данных Artificial Analysis без округления исходных значений.
// По умолчанию работает с сохранённым HTML; --refresh обновляет снимок через curl.
// --add-release SLUG --model-id ID добавляет только новый релиз, сохраняя прежний срез.
// Замена среза с дополнениями требует явного --replace-snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'data', 'aa');
fs.mkdirSync(directory, { recursive: true });
function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || !/^[a-z0-9][a-z0-9.-]*$/.test(value)) throw new Error(`Некорректное значение ${name}.`);
  return value;
}
const addRelease = argument('--add-release');
const addModelId = argument('--model-id');
if (Boolean(addRelease) !== Boolean(addModelId)) throw new Error('--add-release и --model-id задаются вместе.');
const resultPath = path.join(directory, 'aa.json');
if (!addRelease && fs.existsSync(resultPath) && !process.argv.includes('--replace-snapshot')
    && JSON.parse(fs.readFileSync(resultPath, 'utf8')).metadata?.additions?.length) {
  throw new Error('Срез содержит отдельные дополнения. Используйте --add-release либо явно разрешите полную замену через --replace-snapshot.');
}
const baseline = addRelease ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
if (baseline?.rows.some(row => row.release_slug === addRelease || row.model === addModelId)) {
  if (baseline.rows.some(row => (row.release_slug === addRelease) !== (row.model === addModelId))) {
    throw new Error('Релиз или внутренний ID уже связан с другой моделью.');
  }
  console.log(`AA: ${addRelease} уже добавлен; существующий срез не изменён.`);
  process.exit(0);
}
const sourceUrl = `https://artificialanalysis.ai/models/${addRelease ?? 'gpt-6-astra'}`;
const htmlPath = path.join(directory, addRelease ? `${addRelease}.html` : 'astra.html');
const retrievalPath = path.join(directory, addRelease ? `${addRelease}-retrieval.json` : 'retrieval.json');
if (process.argv.includes('--refresh')) {
  execFileSync('curl.exe', ['-L', '--fail', '--max-time', '60', sourceUrl, '-o', htmlPath], { stdio: 'inherit' });
  fs.writeFileSync(retrievalPath, JSON.stringify({ retrieved_at: new Date().toISOString(), source_url: sourceUrl }, null, 2) + '\n');
}
const retrieval = fs.existsSync(retrievalPath) ? JSON.parse(fs.readFileSync(retrievalPath, 'utf8')) : {
  retrieved_at: fs.statSync(htmlPath).mtime.toISOString(), source_url: sourceUrl,
};
const html = fs.readFileSync(htmlPath, 'utf8');
const flight = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1])
  .filter(script => script.startsWith('self.__next_f.push([1,'))
  .map(script => JSON.parse(script.slice(19, -1))[1]).join('');
const models = new Map();
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.slug && value.name && value.release?.slug) {
    const current = models.get(value.slug);
    if (!current || Object.keys(value).length > Object.keys(current).length) models.set(value.slug, value);
  }
  for (const child of Object.values(value)) visit(child);
}
for (const line of flight.split('\n')) {
  let value;
  try { value = JSON.parse(line.slice(line.indexOf(':') + 1)); } catch { continue; }
  visit(value);
}
if (models.size < 100) throw new Error('Схема страницы AA изменилась: найдено слишком мало моделей.');

// Явное соответствие названий: версии Flash, Vision, 0420 и 0731 не смешиваются.
const releases = addRelease ? [[addRelease, addModelId]] : [
  ['gpt-5-6-luna', 'gpt-5.6-luna'],
  ['gpt-5-6-sol', 'gpt-5.6-sol'],
  ['gpt-6-astra', 'gpt-6-astra'],
  ['claude-opus-5', 'claude-opus-5'],
  ['claude-fable-5-1', 'claude-fable-5.1'],
  ['gemini-3-8-flash', 'gemini-3.8-flash'],
  ['deepseek-v4-1-flash', 'deepseek-v4.1-flash'],
  ['deepseek-v4-flash', 'deepseek-v4-flash'],
  ['grok-4-6', 'grok-4.6'],
  ['grok-4-7', 'grok-4.7'],
  ['mimo-v2-5-pro', 'mimo-v2.5-pro'],
  ['mimo-v2-6-pro', 'mimo-v2.6-pro'],
  ['glm-5-3-flash', 'glm-5.3-flash'],
];
const lookup = new Map(releases);
const selected = [...models.values()].filter(model => lookup.has(model.release.slug));
const version = html.match(/Intelligence Index v(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
if (baseline && (!selected.length || version !== baseline.metadata.intelligence_index_version)) {
  throw new Error('Добавление отменено: релиз не найден либо версия Intelligence Index отличается от исходного среза.');
}
const finiteOrNull = value => Number.isFinite(value) ? value : null;
const rows = selected.map(model => {
  const task = finiteOrNull(model.intelligenceIndexCostPerTask?.cost?.total);
  const total = finiteOrNull(model.intelligenceIndexCost?.total);
  const flags = [];
  if (task === null) flags.push('missing_cost_per_task');
  if (total === null) flags.push('missing_cost_total');
  if (model.intelligenceIndexIsEstimated) flags.push('intelligence_index_estimated_by_aa');
  if (model.name.includes('Default Fallback')) flags.push('default_fallback_enabled');
  if (!model.effort) flags.push('effort_not_specified_by_source');
  const outputCost = finiteOrNull(model.intelligenceIndexCostPerTask?.cost?.output);
  const outputTokens = finiteOrNull(model.intelligenceIndexOutputTokensPerTask?.output);
  if (outputCost !== null && outputTokens !== null && model.price1mOutputTokens > 0
      && Math.abs(outputCost * 1e6 / model.price1mOutputTokens - outputTokens) > Math.max(1e-7, outputTokens * 1e-9)) {
    flags.push('token_reconstruction_output_mismatch');
  }
  return {
    model: lookup.get(model.release.slug),
    model_display: model.release.name,
    source_id: model.id,
    source_slug: model.slug,
    source_name: model.name,
    source_short_name: model.shortName,
    release_slug: model.release.slug,
    release_date: model.releaseDate,
    effort: model.effort?.slug ?? (model.isReasoning ? 'reasoning' : 'non-reasoning'),
    effort_label: model.effort?.label ?? (model.isReasoning ? 'Reasoning' : 'Non-reasoning'),
    effort_level: model.effort?.level ?? null,
    is_reasoning: model.isReasoning,
    intelligence_index: finiteOrNull(model.intelligenceIndex),
    intelligence_index_estimated: model.intelligenceIndexIsEstimated ?? null,
    cost_per_task_usd: task,
    cost_total_usd: total,
    cost_per_task_components_usd: model.intelligenceIndexCostPerTask?.cost ?? null,
    cost_total_components_usd: model.intelligenceIndexCost ?? null,
    evaluations: model.intelligenceIndexCostPerTask?.evaluations ?? null,
    api_price_input_usd_per_million: finiteOrNull(model.price1mInputTokens),
    api_price_output_usd_per_million: finiteOrNull(model.price1mOutputTokens),
    api_price_cache_hit_usd_per_million: finiteOrNull(model.cacheHitPrice),
    api_price_cache_write_usd_per_million: finiteOrNull(model.cacheWritePrice),
    // Отдельная ставка reasoning в этом публичном наборе не опубликована.
    api_price_reasoning_usd_per_million: finiteOrNull(model.price1mReasoningTokens),
    intelligence_index_output_tokens_per_task: model.intelligenceIndexOutputTokensPerTask ?? null,
    canonical_intelligence_index_token_count: model.canonicalIntelligenceIndexTokenCount ?? null,
    // Нельзя выдавать canonical-поле за независимый provider-reported счётчик.
    reported_intelligence_index_token_count: model.reportedIntelligenceIndexTokenCount ?? null,
    intelligence_index_evaluations: model.intelligenceIndexEvaluations?.map(evaluation => ({
      slug: evaluation.slug,
      score: finiteOrNull(evaluation.score),
      output_tokens_per_task: finiteOrNull(evaluation.outputTokensPerTask),
      cost_per_task_usd: finiteOrNull(evaluation.costPerTask),
      time_per_task_seconds: finiteOrNull(evaluation.timePerTask),
    })) ?? null,
    source: `https://artificialanalysis.ai/models/${model.slug}`,
    source_extraction_url: sourceUrl,
    source_retrieved_at: retrieval.retrieved_at,
    source_version: version,
    quality_flags: flags,
  };
}).sort((a, b) => releases.findIndex(x => x[1] === a.model) - releases.findIndex(x => x[1] === b.model)
  || (a.effort_level ?? 0) - (b.effort_level ?? 0) || a.source_slug.localeCompare(b.source_slug));

const coverage = releases.map(([release, model]) => {
  const variants = rows.filter(row => row.model === model);
  return {
    model,
    model_display: variants[0]?.model_display ?? null,
    release_slug: release,
    status: variants.length ? 'found' : 'not_found',
    available_variants: variants.length,
    variants_with_both_costs: variants.filter(row => row.cost_per_task_usd !== null && row.cost_total_usd !== null).length,
    efforts: variants.map(row => row.effort),
    missing_cost_variants: variants.filter(row => row.cost_per_task_usd === null || row.cost_total_usd === null).map(row => row.source_slug),
  };
});
const result = {
  metadata: {
    source: 'Artificial Analysis',
    source_url: sourceUrl,
    methodology_url: 'https://artificialanalysis.ai/methodology/intelligence-benchmarking',
    cost_chart_url: 'https://artificialanalysis.ai/#price-and-cost',
    retrieved_at: retrieval.retrieved_at,
    intelligence_index_version: version,
    source_file: 'data/aa/astra.html',
    source_sha256: crypto.createHash('sha256').update(html).digest('hex'),
    source_model_count: models.size,
    selected_model_count: coverage.length,
    selected_variant_count: rows.length,
    variants_with_both_costs: rows.filter(row => row.cost_per_task_usd !== null && row.cost_total_usd !== null).length,
    extraction: 'Публичные объекты Next.js, встроенные в HTML страницы модели. Исходные числа не округлены.',
    notes: [
      'Стоимость задач использует API-тарифы AA; сумма полного набора и взвешенная цена задачи — разные показатели.',
      'Нулевые или отсутствующие значения не заменяются значениями другого effort.',
      'В выбранных источниках Gemini 3.8 представлен моделью Flash, DeepSeek V4.1 — моделью Flash.',
      'DeepSeek V4 Flash сопоставлен с релизом 0731 по явному имени AA и snapshot в official-api-prices.json проекта real-api-pricing.',
      'Solana исключена: пользователь уточнил, что имел в виду GPT-5.6 Sol.',
      'Список effort отражает опубликованные варианты AA на дату снимка, а не все теоретически допустимые настройки API.',
      'canonical_intelligence_index_token_count — исходное поле canonicalIntelligenceIndexTokenCount, а не переименованный provider-reported счётчик. Отдельный reportedIntelligenceIndexTokenCount в выбранных объектах не опубликован.',
      'cacheWritePrice сохранена без подстановок. При null использование inputPrice для обратного расчёта — отдельное явно обозначаемое допущение; null не означает бесплатную запись.',
      'Отдельная ставка reasoning не опубликована. Обратный расчёт по outputPrice следует проверять относительно опубликованных токенов на задачу.',
    ],
  },
  rows,
  coverage,
};
if (baseline) {
  if (rows.some(row => baseline.rows.some(old => old.source_id === row.source_id || old.source_slug === row.source_slug))) {
    throw new Error('Добавление отменено: ID или slug пересекается с существующим вариантом.');
  }
  // Проверка новых вариантов имеет собственный fingerprint: старый аудит и его raw-файл не переписываются.
  const weightingPath = path.join(directory, 'task-weighting.json');
  const weighting = JSON.parse(fs.readFileSync(weightingPath, 'utf8'));
  const weightingRaw = fs.readFileSync(path.join(root, weighting.metadata.source_file));
  if (weighting.metadata.version !== version || weighting.metadata.source_snapshot_retrieved_at !== baseline.metadata.retrieved_at
      || crypto.createHash('sha256').update(weightingRaw).digest('hex') !== weighting.metadata.source_sha256) {
    throw new Error('Добавление отменено: исходный аудит весов AA не соответствует сохранённому срезу.');
  }
  const weights = new Map(weighting.benchmarks.map(benchmark => [benchmark.slug, benchmark.weight]));
  let checkedRatios = 0;
  let maxWeightError = 0;
  const taskValidation = selected.map(model => {
    const contributions = model.intelligenceIndexCostPerTask?.evaluations ?? [];
    if (contributions.length !== weights.size || new Set(contributions.map(evaluation => evaluation.slug)).size !== weights.size) {
      throw new Error(`Добавление отменено: неполный набор весов ${model.slug}.`);
    }
    let reconstructedTask = 0;
    for (const contribution of contributions) {
      const expectedWeight = weights.get(contribution.slug);
      const taskCost = model.intelligenceIndexEvaluations?.find(evaluation => evaluation.slug === contribution.slug)?.costPerTask;
      if (!Number.isFinite(expectedWeight) || !Number.isFinite(taskCost) || taskCost <= 0
          || !Number.isFinite(contribution.weightedCostPerTask)) {
        throw new Error(`Добавление отменено: невозможно проверить вес ${model.slug}/${contribution.slug}.`);
      }
      const error = Math.abs(contribution.weightedCostPerTask / taskCost - expectedWeight);
      if (error > 1e-10) throw new Error(`Добавление отменено: изменился вес ${model.slug}/${contribution.slug}.`);
      checkedRatios++;
      maxWeightError = Math.max(maxWeightError, error);
      reconstructedTask += taskCost * expectedWeight;
    }
    const reportedTask = model.intelligenceIndexCostPerTask?.cost?.total;
    if (!Number.isFinite(reportedTask) || Math.abs(reconstructedTask - reportedTask) > Math.max(1e-10, reportedTask * 1e-10)) {
      throw new Error(`Добавление отменено: взвешенная сумма не совпадает со стоимостью задачи ${model.slug}.`);
    }
    return { source_slug: model.slug, cost_per_task_reported_usd: reportedTask,
      cost_per_task_reconstructed_usd: reconstructedTask, cost_per_task_delta_usd: reconstructedTask - reportedTask };
  });
  const rawFile = `data/aa/${addRelease}-raw.json`;
  const rawContent = JSON.stringify(selected, null, 2) + '\n';
  const snapshot = {
    release_slug: addRelease,
    model: addModelId,
    source_url: sourceUrl,
    retrieved_at: retrieval.retrieved_at,
    intelligence_index_version: version,
    source_file: `data/aa/${path.basename(htmlPath)}`,
    source_sha256: crypto.createHash('sha256').update(html).digest('hex'),
    source_model_count: models.size,
    selected_variant_count: rows.length,
    raw_file: rawFile,
    raw_sha256: crypto.createHash('sha256').update(rawContent).digest('hex'),
    task_weighting_validation: {
      weighting_file: 'data/aa/task-weighting.json',
      weighting_sha256: crypto.createHash('sha256').update(fs.readFileSync(weightingPath)).digest('hex'),
      variants_checked: selected.length,
      evaluation_weight_ratios_checked: checkedRatios,
      max_absolute_weight_error: maxWeightError,
      weight_mismatches: [],
      models: taskValidation,
    },
  };
  baseline.rows.push(...rows);
  baseline.coverage.push(...coverage);
  baseline.metadata.selected_model_count = baseline.coverage.length;
  baseline.metadata.selected_variant_count = baseline.rows.length;
  baseline.metadata.variants_with_both_costs = baseline.rows.filter(row => row.cost_per_task_usd !== null && row.cost_total_usd !== null).length;
  baseline.metadata.additions = [...(baseline.metadata.additions ?? []), snapshot];
  fs.writeFileSync(path.join(root, rawFile), rawContent);
  fs.writeFileSync(resultPath, JSON.stringify(baseline, null, 2) + '\n');
} else {
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'selected-models-raw.json'), JSON.stringify(selected, null, 2) + '\n');
}
fs.writeFileSync(retrievalPath, JSON.stringify(retrieval, null, 2) + '\n');
console.log(`AA: ${baseline ? 'добавлено ' : ''}${coverage.length} моделей, ${rows.length} вариантов, ${result.metadata.variants_with_both_costs} вариантов с обеими ценами, индекс v${version}.`);
