"use strict";
const fs = require("node:fs");
const { game } = require("./market_sim");

function measure(policy, seed, rounds = 8) {
  const values = Array.from({length: 100}, (_, i) => game(seed + i, rounds, policy).pr).sort((a, b) => a - b);
  return {mean: values.reduce((sum, p) => sum + p, 0) / values.length,
    p10: values[9], min: values[0], max: values.at(-1), atLeast98: values.filter(p => p >= .98).length};
}
const ranked = [];
for (const priceOffset of [-.04, -.03, -.02, -.01, 0, .01, .02])
  for (const maxBags of [2, 3, 5])
    for (const failureStep of [.005, .01, .02])
      for (const scarcity of [0, .15, .30]) {
        const policy = {priceOffset, maxBags, failureStep, scarcity};
        const train = measure(policy, 1200);
        ranked.push({policy, train, score: .65 * train.mean + .35 * train.p10});
      }
ranked.sort((a, b) => b.score - a.score);
const chosen = ranked[0];
const trainBaseline = measure("baseline", 1200);
const holdout = {baseline: measure("baseline", 12500), optimized: measure(chosen.policy, 12500)};
const calendar15 = {baseline: measure("baseline", 31400, 15), optimized: measure(chosen.policy, 31400, 15)};
const improved = holdout.optimized.mean > holdout.baseline.mean && holdout.optimized.p10 >= holdout.baseline.p10;
const report = {candidates: ranked.length, gamesPerSet: 100, chosen, trainBaseline, holdout, calendar15, improved};
if (improved) fs.writeFileSync("optimized-policy.json", JSON.stringify(chosen.policy, null, 2) + "\n");
fs.writeFileSync("optimization-report.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
