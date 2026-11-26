'use strict';

const rules = {
  bag_kg: 60,
  salvage_ratio: 0.8,
  p0: 132,
  defect_steps: [
    { max_defect_pct: 4, grade: 'GRADE_1', step: 1 },
    { max_defect_pct: 8, grade: 'GRADE_2', step: 0.88 },
    { max_defect_pct: 100, grade: 'GRADE_3', step: 0.74 },
  ],
  moisture: { ref: 12, hard_limit: 14, penalty_per_pp: 0.015, hard_factor: 0.85 },
  screen_factors: { 12: 0.94, 13: 0.97, 14: 1, 15: 1.025, 16: 1.05 },
  scoring: { pr_points: 80, appraisal_points: 20, pr_floor: 0.8, appraisal_error_at_zero: 0.10 },
  timeline: { rounds: 15 },
};

const round = value => Math.round(value * 100) / 100;

function estimate(r, sample) {
  const { defect_pct: d, moisture_pct: m, screen } = sample;
  const { ref, hard_limit, penalty_per_pp, hard_factor } = r.moisture;
  const grade = r.defect_steps.find(step => d <= step.max_defect_pct) ?? r.defect_steps.at(-1);
  const moisture = m <= ref ? 1 : m > hard_limit ? hard_factor
    : (1 - m / 100) / (1 - ref / 100) - penalty_per_pp * (m - ref);
  const screens = Object.keys(r.screen_factors).map(Number).sort((a, b) => a - b);
  const factor = r.screen_factors[Math.min(Math.max(screen, screens[0]), screens.at(-1))];
  return { grade: grade.grade, tv: round(r.p0 * (1 - d / 100) * grade.step * moisture * factor) };
}

function meets(sample, spec) {
  return sample.defect_pct <= spec.max_defect_pct && sample.moisture_pct <= spec.max_moisture_pct
    && (spec.min_screen == null || sample.screen >= spec.min_screen);
}

module.exports = { rules, estimate, meets, round };
