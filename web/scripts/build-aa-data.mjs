// Строит вкладку AA из закреплённых снимков, без сетевых запросов.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildExpandedQuotaScenario } from '../../extensions/aa-costs/scripts/empirical_scenario.mjs';
import { estimateVariant } from '../../extensions/aa-costs/scripts/estimate_api_price.mjs';

/** Основная сборка использует только профиль AA и не запускает архивные сценарии. */
export function createAaData(aa, pricing, rates, audit, taskWeighting, empiricalEvidence = null) {
  const quota = buildExpandedQuotaScenario(aa, pricing, rates, empiricalEvidence);
  return {
    metadata: {
      aa_version: aa.metadata.intelligence_index_version,
      aa_retrieved_at: aa.metadata.retrieved_at,
      pricing_revision: pricing.revision,
      pricing_retrieved_at_utc: pricing.retrieved_at_utc,
      methodology: 'Единый профиль: объёмы пяти категорий AA для каждой модели и effort умножаются на ставки списания квоты. Веса берутся из условий тарифа либо условной API-калибровки практического замера. Без весов тариф остаётся в таблице без цены. Смесь RAP и её месячная токенная ёмкость не используются.',
      model_count: quota.metadata.model_count,
      variant_count: aa.rows.length,
      row_count: quota.rows.length,
    },
    quota_scenario: quota,
    api_estimate: {
      metadata: {
        source_version: aa.metadata.intelligence_index_version,
        source_retrieved_at: aa.metadata.retrieved_at,
        method: 'Инверсия пяти категорий AA для разбора исходного профиля; итоговые цены новой вкладки берутся из quota_scenario.',
      },
      rows: aa.rows.map(variant => ({
        model_id: variant.model, model: variant.model_display,
        effort: variant.effort, effort_level: variant.effort_level,
        source_id: variant.source_id, source_name: variant.source_name, source_url: variant.source,
        ...estimateVariant(variant),
      })),
    },
    aa_task_weighting: taskWeighting?.metadata?.version === aa.metadata.intelligence_index_version
      && taskWeighting?.metadata?.source_snapshot_retrieved_at === aa.metadata.retrieved_at ? taskWeighting : null,
    sources: [
      { name: 'Artificial Analysis · Intelligence Index', url: aa.metadata.source_url, date: aa.metadata.retrieved_at },
      { name: 'Методология AA', url: aa.metadata.methodology_url },
      { name: 'Real API Pricing', url: `https://github.com/FeiZhuLulu/real-api-pricing/tree/${pricing.revision}`, date: pricing.retrieved_at_utc },
    ],
  };
}

const extension = new URL('../../extensions/aa-costs/', import.meta.url);
const dataDirectory = new URL('../public/data/', import.meta.url);

async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(new URL(path, extension), 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

export async function buildAaData() {
  const [aa, pricing, rates, audit, weighting, empiricalEvidence] = await Promise.all([
    readJson('data/aa/aa.json'), readJson('data/pricing/pricing.json'),
    readJson('data/pricing/quota-rates.json', true), readJson('data/pricing/quota-evidence.json', true),
    readJson('data/aa/task-weighting.json', true),
    readJson('data/pricing/empirical-evidence.json', true),
  ]);
  // Ошибка расчёта прерывает сборку, без подстановки архивных результатов.
  const data = createAaData(aa, pricing, rates, audit, weighting, empiricalEvidence);
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(new URL('aa-costs.json', dataDirectory), JSON.stringify(data));
  console.log(`Вкладка AA: ${data.quota_scenario.metadata.included_plans} пар со ставками, ${data.quota_scenario.metadata.unavailable_weight_plans} без оценки; public/data/aa-costs.json.`);
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildAaData();
