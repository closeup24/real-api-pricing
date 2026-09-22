import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aaAssessment, aaAssessmentColor } from "./aaAssessment";
import type { QuotaRow } from "./aaTypes";

const rows: QuotaRow[] = JSON.parse(readFileSync(new URL("../public/data/aa-costs.json", import.meta.url), "utf8")).quota_scenario.rows;
const plan = (id: string) => structuredClone(rows.find(row => row.pricing_id === id && row.task?.cost_usd != null)!);

test("рубрика отличает измерение, неполные сценарии и перенос их денежного пула", () => {
  for (const [id, expected] of [
    ["claude_pro::claude-opus-5", 65], ["claude_max_20x::claude-opus-5", 35],
    ["claude_pro::claude-opus-5.5", 55], ["claude_max_20x::claude-opus-5.5", 25],
    ["claude_max_20x::claude-fable-5.1", 35], ["cursor_ultra::grok-4.6", 30],
    ["chatgpt_pro_20x::gpt-5.6-sol", 70], ["chatgpt_plus::gpt-5.6-sol", 40],
    ["chatgpt_pro_20x::gpt-6-sol", 55], ["chatgpt_plus::gpt-6-sol", 30],
    ["chatgpt_plus::gpt-6-luna", 55], ["chatgpt_pro_20x::gpt-6-luna", 30],
  ] as const) assert.equal(aaAssessment(plan(id)).score, expected, id);
});

test("каждая доступная оценка имеет категорию и цвет без изменения цен и входных данных", () => {
  const before = JSON.stringify(rows);
  for (const row of rows) {
    for (const scope of ["task", "suite"] as const) {
      const value = aaAssessment(row, scope);
      assert.ok(value.category && value.description && value.reasons.length);
      if (row[scope]?.cost_usd == null) assert.equal(value.score, null, row.id);
      else assert.ok(value.score !== null && value.score >= 0 && value.score <= 100, row.id);
      assert.equal(value.color, aaAssessmentColor(value.score));
    }
  }
  assert.equal(JSON.stringify(rows), before);
});

test("неизвестный метод, источник переноса и отсутствующая метрика получают серую метку", () => {
  const row = plan("claude_pro::claude-opus-5.5");
  assert.equal(aaAssessment({...row, method: "future_unknown"}).score, null);
  const missingSource = structuredClone(row);
  delete missingSource.empirical!.transfer!.source_evidence_method;
  assert.equal(aaAssessment(missingSource).score, null);
  row.task = {cost_usd: null, status: "missing"};
  assert.equal(aaAssessment(row, "task").score, null);
  assert.equal(aaAssessment(row, "suite").score, 55);
});

test("приближённость API применяется к выбранному профилю и объясняется отдельно от исходной суммы", () => {
  const row = structuredClone(rows.find(row => row.kind === "api" && row.task?.status === "consistent")!);
  row.task!.status = "approximate";
  row.suite!.status = "consistent";
  assert.equal(aaAssessment(row, "task").score, 85);
  assert.equal(aaAssessment(row, "suite").score, 95);
  assert.ok(aaAssessment(row, "task").reasons.some(reason => reason.includes("Стоимость API опубликована AA")));
});

test("слабое основание не улучшается за счёт уверенности гипотезы, цвета ограничены шкалой", () => {
  const row = plan("claude_max_20x::claude-opus-5.5");
  row.quality = {level: "high", reasons: ["Ошибочно повышенная метка."]};
  assert.equal(aaAssessment(row).score, 25);
  assert.equal(aaAssessmentColor(0), aaAssessmentColor(-50));
  assert.equal(aaAssessmentColor(100), aaAssessmentColor(200));
  assert.notEqual(aaAssessmentColor(null), aaAssessmentColor(0));
});
