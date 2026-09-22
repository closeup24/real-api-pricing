import type { Point, Row } from "./types";

export interface ChartAssessment {
  assessment: NonNullable<Point["cost_assessment"]>;
  differs: boolean;
  rowCount: number;
}

/** Совпавшие точки получают худшую известную оценку; отсутствие балла консервативнее числового. */
export function summarizeCostAssessment(rows: readonly Pick<Row, "point">[]): ChartAssessment | undefined {
  const assessments = rows.flatMap(row => row.point.cost_assessment ? [row.point.cost_assessment] : []);
  if (!assessments.length) return undefined;
  const rank = (assessment: NonNullable<Point["cost_assessment"]>) =>
    assessment.score !== null && Number.isFinite(assessment.score) ? assessment.score : -Infinity;
  const assessment = assessments.reduce((worst, next) => rank(next) < rank(worst) ? next : worst);
  const signatures = new Set(assessments.map(item => JSON.stringify([
    item.category, item.score, item.description, item.reasons,
  ])));
  return {
    assessment,
    differs: signatures.size > 1 || assessments.length !== rows.length,
    rowCount: rows.length,
  };
}

export function assessmentHeading(summary: ChartAssessment): string {
  const { category, score } = summary.assessment;
  return `${category}${score !== null && Number.isFinite(score) ? ` · ${score}/100` : ""}`;
}

export function assessmentDetails(summary: ChartAssessment): string[] {
  // Полные основания доступны в разборе; hover и aria содержат только краткое резюме.
  const description = summary.assessment.description.replace(/\s+/g, " ").trim();
  const brief = description.length <= 180 ? description : `${description.slice(0, 177).replace(/\s+\S*$/, "")}…`;
  return [...new Set([
    brief,
    "Редакционная оценка, не вероятность.",
    summary.differs
      ? `В этой точке совпадают ${summary.rowCount} вариантов. Оценки надёжности различаются; метка показывает наиболее консервативную.`
      : "",
    "Все основания — в разборе по клику.",
  ].filter(Boolean))];
}

export function assessmentTooltip(summary: ChartAssessment): string {
  return [assessmentHeading(summary), ...assessmentDetails(summary)].join("\n");
}
