"use strict";
const fs = require("node:fs");
const {game} = require("./market_sim");
const current = require("./optimized-policy.json");
function metrics(policy, rounds, seed, count) {
  const p = Array.from({length: count}, (_, i) => game(seed + i, rounds, policy).pr)
    .sort((a,b)=>a-b);
  return { mean: p.reduce((s,x)=>s+x,0)/count, min:p[0], max:p.at(-1),
    p10:p[Math.floor((count-1)*.1)], above98:p.filter(x=>x>=.98).length };
}
const candidates = [];
for (const instant of [0.01,.02,.03])
for (const commercial of [.02,.03,.04])
for (const specialty of [.03,.04,.05])
for (const width of [.035,.04,.045])
for (const maxBags of [3,5])
for (const scarcity of [0,.30,.60]) {
  const policy={expected:true,centers:{Instant:instant,Commercial:commercial,Specialty:specialty},width,maxBags,scarcity};
  const a=metrics(policy,8,51000,100), b=metrics(policy,15,52000,100);
  candidates.push({policy, score:.325*(a.mean+b.mean)+.175*(a.p10+b.p10)});
}
candidates.sort((a,b)=>b.score-a.score);
const best=candidates[0].policy;
const verification=[{rounds:8,seed:61100},{rounds:15,seed:62300}].map(({rounds,seed})=>({
  rounds,seed,count:500,before:metrics(current,rounds,seed,500),after:metrics(best,rounds,seed,500)
}));
const promoted=verification.every(v=>v.after.mean>v.before.mean&&v.after.p10>=v.before.p10);
if(promoted) fs.writeFileSync("optimized-policy-v2.json",JSON.stringify(best,null,2));
const report={candidates:candidates.length,trainingGamesPerHorizon:100,best,verification,promoted};
fs.writeFileSync("optimization-report-v2.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
