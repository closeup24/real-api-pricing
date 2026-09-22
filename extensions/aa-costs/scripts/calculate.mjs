/** Проверяет, что цена известна и неотрицательна. */
export function isCost(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Пересчитывает обе метрики одним коэффициентом, сохраняя неизвестные значения. */
export function scaleCosts(aa, realPrice, apiPrice) {
  if (!isCost(realPrice) || !isCost(apiPrice) || apiPrice === 0) {
    throw new RangeError('Для пересчёта нужны известная цена тарифа и положительная API-цена.');
  }
  const multiplier = realPrice / apiPrice;
  return {
    multiplier,
    discount_factor: multiplier > 0 ? 1 / multiplier : null,
    cost_per_task_usd: isCost(aa.cost_per_task_usd) ? aa.cost_per_task_usd * multiplier : null,
    cost_total_usd: isCost(aa.cost_total_usd) ? aa.cost_total_usd * multiplier : null,
  };
}

/** Число условных задач; бесплатные и неизвестные цены не превращаются в бесконечность. */
export function tasksForBudget(budget, cost) {
  if (!isCost(budget) || !isCost(cost) || cost === 0) return null;
  return budget / cost;
}

/** Нормировка объёма работы относительно лучшей положительной цены. */
export function relativeEfficiency(cost, costs) {
  const positiveCosts = costs.filter(value => isCost(value) && value > 0);
  if (!isCost(cost) || cost === 0 || positiveCosts.length === 0) return null;
  return 100 * Math.min(...positiveCosts) / cost;
}
