import test from "node:test";
import assert from "node:assert/strict";
import type { Point } from "./types";
import { assessmentDetails, assessmentHeading, assessmentTooltip, summarizeCostAssessment } from "./chartAssessment";

const row = (score: number | null, category = "Калибровка") => ({
  point: { cost_assessment: { score, category, color: "#809385", description: "Основано на наблюдении", reasons: ["Короткий замер"] } } as Point,
});

test("Совпавшая координата получает минимальную оценку без изменения исходных данных", () => {
  const rows = [row(80), row(30, "Сценарий"), row(60)];
  const before = JSON.stringify(rows);
  const result = summarizeCostAssessment(rows)!;
  assert.equal(result.assessment.score, 30);
  assert.equal(result.assessment.category, "Сценарий");
  assert.equal(result.differs, true);
  assert.match(assessmentTooltip(result), /совпадают 3 вариантов/);
  assert.match(assessmentHeading(result), /30\/100/);
  assert.equal(JSON.stringify(rows), before);
});

test("Неизвестный балл консервативнее числового, а ноль остаётся известной оценкой", () => {
  assert.equal(summarizeCostAssessment([row(80), row(null)])!.assessment.score, null);
  assert.equal(summarizeCostAssessment([row(80), row(0)])!.assessment.score, 0);
  assert.equal(assessmentHeading(summarizeCostAssessment([row(null)])!), "Калибровка");
  assert.match(assessmentHeading(summarizeCostAssessment([row(0)])!), /0\/100/);
});

test("Обычные upstream-точки не получают метку; одинаковые оценки не объявляются различными", () => {
  assert.equal(summarizeCostAssessment([{ point: {} as Point }]), undefined);
  assert.equal(summarizeCostAssessment([]), undefined);
  const result = summarizeCostAssessment([row(80), row(80)])!;
  assert.equal(result.differs, false);
  assert.doesNotMatch(assessmentTooltip(result), /Оценки надёжности различаются/);
});

test("Длинные основания остаются в разборе, hover и aria получают ограниченное резюме", () => {
  const sample = row(35, "Перенос модели");
  sample.point.cost_assessment!.description = "Описание с длинным объяснением. ".repeat(50);
  sample.point.cost_assessment!.reasons = Array.from({ length: 15 }, (_, i) => `Основание ${i}: ${"подробности ".repeat(100)}`);
  const before = JSON.stringify(sample);
  const summary = summarizeCostAssessment([sample])!;
  const details = assessmentDetails(summary);
  const tooltip = assessmentTooltip(summary);
  assert.equal(details.length, 3);
  assert.ok(details[0].length <= 180);
  assert.ok(tooltip.length < 300);
  assert.match(tooltip, /Редакционная оценка, не вероятность/);
  assert.match(tooltip, /Все основания — в разборе по клику/);
  assert.doesNotMatch(tooltip, /Основание \d/);
  assert.equal(JSON.stringify(sample), before);
});
