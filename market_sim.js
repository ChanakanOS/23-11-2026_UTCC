'use strict';
const fs = require('node:fs');

const BAG_KG = 60;
const { chooseOffers, SALVAGE } = require('./agent');
const buyers = [
  { name: 'Instant', minQuality: 0.18, markup: 0.93, cutoff: 0.95 },
  { name: 'Commercial', minQuality: 0.45, markup: 0.985, cutoff: 1.015 },
  { name: 'Specialty', minQuality: 0.76, markup: 1, cutoff: 1.04 },
];

function random(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function game(seed, numRounds, policy) {
  const rand = random(seed);
  const lots = Array.from({ length: 4 + Math.floor(rand() * 3) }, (_, i) => {
    const quality = rand();
    const tv = Math.round(55 + quality * 80);
    const bags = 3 + Math.floor(rand() * 7);
    return { id: i + 1, quality, tv, bags, left: bags, eligible: 0, priceFailures: {} };
  });
  const totalTV = lots.reduce((s, l) => s + l.tv * l.bags * BAG_KG, 0);
  let revenue = 0;
  const rounds = [];
  for (let r = 1; r <= numRounds; r++) {
    const festival = numRounds === 15 && r >= 6 && r <= 8;
    const late = numRounds === 15 && r >= 13;
    const rfqs = buyers.map(b => ({
      ...b, bags: Math.floor(rand() * (late ? 4 : festival && b.name === 'Specialty' ? 10 : 7)),
      limit: b.cutoff + (rand() - 0.5) * 0.08,
      draws: lots.map(() => rand()),
    }));
        const publicBuyers = rfqs.map(({ name, minQuality, markup, bags }) => ({
      name, minQuality, markup, bags,
    }));
    const bids = chooseOffers(lots, publicBuyers, late ? 3 : 5, r, numRounds, policy);
    const offers = [];
    for (const { lot, buyer, bags, markup } of bids) {
      const b = rfqs.find(rfq => rfq.name === buyer);
const status = markup > b.limit ? 'ABOVE_LIMIT' : b.draws[lot.id - 1] < 0.15 ? 'OUTBID' : 'ACCEPTED';
      const filled = status === 'ACCEPTED' ? bags : 0;
      const price = Math.round(lot.tv * markup * 100) / 100;
      revenue += filled * BAG_KG * price;
      offers.push({lot: lot.id, buyer: b.name, price, bags, filled, status});
    }
    for (const o of offers) {
      const lot = lots[o.lot - 1];
      lot.left -= o.filled;
      lot.priceFailures[o.buyer] = o.filled ? 0 : (lot.priceFailures[o.buyer] || 0) + 1;
    }
    rounds.push({round: r, festival, offers});
  }
  const unsoldTV = lots.reduce((s, l) => s + l.left * l.tv * BAG_KG, 0);
  return {seed, pr: (revenue + SALVAGE * unsoldTV) / totalTV,
    revenue: Math.round(revenue * 100) / 100, totalTV, salvage: SALVAGE * unsoldTV,
    unsoldKg: lots.reduce((s, l) => s + l.left * BAG_KG, 0), lots, rounds};
}

module.exports = { game };

if (require.main === module) {
const [games = 1000, rounds = 8, seed = 42, policy = 'baseline', output = 'result.json'] = process.argv.slice(2);
const count = Number(games), horizon = Number(rounds), start = Number(seed);
if (!Number.isInteger(count) || count < 1 || ![8, 15].includes(horizon)
    || !Number.isInteger(start) || !['baseline', 'targeted', 'optimized', 'optimized-v2'].includes(policy)) {
  throw new Error('Usage: node market_sim.js GAMES 8|15 SEED baseline|targeted|optimized|optimized-v2 OUTPUT');
}
const config = policy === 'optimized' ? require('./optimized-policy.json') : policy === 'optimized-v2' ? require('./optimized-policy-v2.json') : policy;
const results = Array.from({length: count}, (_, i) => game(start + i, horizon, config));
const sorted = results.map(r => r.pr).sort((a, b) => a - b);
const summary = {games: count, rounds: horizon, policy, seed: start,
  prAverage: sorted.reduce((a, b) => a + b, 0) / count, prLow: sorted[0],
  prP10: sorted[Math.floor((count - 1) * 0.1)], prHigh: sorted.at(-1)};
fs.writeFileSync(output, JSON.stringify({summary, results}));
console.log(JSON.stringify(summary, null, 2));
}
