// Строит вкладку AA из закреплённых снимков, без сетевых запросов.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildQuotaScenario } from '../../extensions/aa-costs/scripts/quota_scenario.mjs';
import { buildTokenScenario } from '../../extensions/aa-costs/scripts/token_scenario.mjs';
import { estimateVariant } from '../../extensions/aa-costs/scripts/estimate_api_price.mjs';

/** Новый расчёт не требует смеси RAP или успешной сборки предыдущего отчёта. */
export function createAaData(aa, pricing, rates, audit, taskWeighting) {
  const quota = buildQuotaScenario(aa, pricing, rates);
  return {
    metadata: {
      aa_version: aa.metadata.intelligence_index_version,
      aa_retrieved_at: aa.metadata.retrieved_at,
      pricing_revision: pricing.revision,
      pricing_retrieved_at_utc: pricing.retrieved_at_utc,
      methodology: 'Пять категорий токенов AA × ставки списания подписки; месячная плата делится на число доступных задач.',
      model_count: quota.metadata.model_count,
      variant_count: aa.rows.length,
      row_count: quota.rows.length,
    },
    quota_scenario: quota,
    token_scenario: buildTokenScenario(aa, pricing, audit),
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
const archiveDirectory = new URL('../public/aa-archive/', import.meta.url);
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(new URL(path, extension), 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

export async function buildAaData() {
  const [aa, pricing, rates, audit, weighting] = await Promise.all([
    readJson('data/aa/aa.json'), readJson('data/pricing/pricing.json'),
    readJson('data/pricing/quota-rates.json', true), readJson('data/pricing/quota-evidence.json', true),
    readJson('data/aa/task-weighting.json', true),
  ]);
  // Ошибка нового расчёта прерывает сборку, без подстановки архивных результатов.
  const data = createAaData(aa, pricing, rates, audit, weighting);
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(archiveDirectory, { recursive: true });
  try {
    const { build } = await import('../../extensions/aa-costs/scripts/build_report.mjs');
    await build();
    await copyFile(new URL('output/report.html', extension), new URL('report.html', archiveDirectory));
    data.archive_status = { status: 'ok', url: '/aa-archive/report.html', reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    data.archive_status = { status: 'unavailable', url: '/aa-archive/report.html', reason };
    console.warn(`Предыдущий отчёт не собран: ${reason}. Новая вкладка рассчитана независимо.`);
    await writeFile(new URL('report.html', archiveDirectory), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Предыдущий отчёт недоступен</title><h1>Предыдущий отчёт не собран</h1><p>Архивный метод завершился ошибкой. Его данные не подставлены в новый расчёт.</p><pre>${escapeHtml(reason)}</pre><p><a href="/?view=aa">Открыть новый расчёт задач AA</a></p></html>`);
  }
  await writeFile(new URL('aa-costs.json', dataDirectory), JSON.stringify(data));
  console.log(`Вкладка AA: public/data/aa-costs.json; архив: ${data.archive_status.status}`);
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildAaData();
