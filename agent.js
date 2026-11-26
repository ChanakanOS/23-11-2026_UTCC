'use strict';

const SALVAGE = 0.8;

function chooseOffers(lots, buyers, capacity, r, numRounds, policy) {
  const config = typeof policy === 'object' ? policy : {};
  const quotes = [];
  for (const lot of lots) {
    if (!lot.left) continue;
    const eligible = buyers.filter(b => b.bags && (b.accepts ? b.accepts(lot) : lot.quality >= b.minQuality));
    if (eligible.length) lot.eligible++;
    for (const b of eligible) {
      const failures = lot.priceFailures[b.name] || 0;
      const lateCut = policy === 'targeted' && failures >= 2 && r > numRounds / 2 ? 0.01 : 0;
      const start = b.markup + (config.priceOffset || 0);
      const markup = Math.max(0.85, start - Math.min(0.04, failures * (config.failureStep ?? 0.01)) - lateCut);
      const predictedFill = Math.max(0.25, 0.82 - 3 * (markup - b.markup));
      const scarcity = 1 + (eligible.length === 1 ? config.scarcity || 0 : 0);
      if (config.expected) {
        const center = b.markup + config.centers[b.name];
        const width = config.width;
        let best = null;
        for (let tick = 85; tick <= 106; tick++) {
          const price = tick / 100;
          const chance = Math.max(0, Math.min(1, (center + width - price) / (2 * width)));
          const gain = chance * (price - SALVAGE);
          if (!best || gain > best.gain) best = { price, gain };
        }
        quotes.push({lot, b, markup: best.price, score: best.gain * lot.tv * scarcity});
      } else {
        quotes.push({lot, b, markup, score: predictedFill * (markup - SALVAGE) * lot.tv * scarcity});
      }
    }
  }
  quotes.sort((a, b) => b.score - a.score);
  const allocated = new Map();
  const offers = [];
  for (const {lot, b, markup} of quotes) {
    const left = lot.left - (allocated.get(lot.id) || 0);
    const bags = Math.min(left, capacity, b.bags, config.maxBags || 3);
    if (bags < 1) continue;
    capacity -= bags;
    allocated.set(lot.id, (allocated.get(lot.id) || 0) + bags);
    b.bags -= bags;
    offers.push({ lot, buyer: b.name, bags, markup });
  }
  return offers;
}

module.exports = { chooseOffers, SALVAGE };
