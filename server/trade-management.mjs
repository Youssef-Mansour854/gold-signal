import {
  calculatePartialResultPercent,
  calculateVirtualPnl,
  hasReachedStop,
  hasReachedTarget,
} from "./strategy.mjs";

const TARGET_COUNT = 3;

export function advanceManagedTrade(recommendation, currentPrice) {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error("Current price must be a positive finite number.");
  }
  if (recommendation.status !== "open") {
    return { recommendation, events: [] };
  }

  let next = { ...recommendation };
  const events = [];

  while (next.next_target <= TARGET_COUNT) {
    const targetNumber = next.next_target;
    const targetPrice = next[`take_profit_${targetNumber}`];
    if (!hasReachedTarget(next.direction, targetPrice, currentPrice)) break;

    const quantityFraction = targetNumber === TARGET_COUNT
      ? next.remaining_fraction
      : Math.min(1 / 3, next.remaining_fraction);
    const contributionPercent = calculatePartialResultPercent(
      next.direction,
      next.entry_price,
      currentPrice,
      quantityFraction,
    );
    const realizedPercent = next.realized_percent + contributionPercent;
    const remainingFraction = Math.max(0, next.remaining_fraction - quantityFraction);

    if (targetNumber === TARGET_COUNT) {
      next = {
        ...next,
        status: realizedPercent > 0 ? "success" : "failed",
        exit_price: currentPrice,
        result_percent: realizedPercent,
        realized_percent: realizedPercent,
        remaining_fraction: 0,
        next_target: TARGET_COUNT + 1,
        close_reason: "take_profit_3",
      };
      events.push({
        eventType: "target_hit",
        targetNumber,
        price: currentPrice,
        quantityFraction,
        contributionPercent,
        currentStopLoss: next.stop_loss,
      });
      return { recommendation: next, events };
    }

    const newStopLoss = targetNumber === 1
      ? next.entry_price
      : next.take_profit_1;
    next = {
      ...next,
      next_target: targetNumber + 1,
      remaining_fraction: remainingFraction,
      realized_percent: realizedPercent,
      stop_loss: newStopLoss,
    };
    events.push({
      eventType: "target_hit",
      targetNumber,
      price: currentPrice,
      quantityFraction,
      contributionPercent,
      currentStopLoss: newStopLoss,
    });
    events.push({
      eventType: "stop_moved",
      targetNumber,
      price: currentPrice,
      quantityFraction: 0,
      contributionPercent: 0,
      currentStopLoss: newStopLoss,
    });
  }

  if (!hasReachedStop(next.direction, next.stop_loss, currentPrice)) {
    return { recommendation: next, events };
  }

  const quantityFraction = next.remaining_fraction;
  const contributionPercent = calculatePartialResultPercent(
    next.direction,
    next.entry_price,
    currentPrice,
    quantityFraction,
  );
  const realizedPercent = next.realized_percent + contributionPercent;
  next = {
    ...next,
    status: realizedPercent > 0 ? "success" : "failed",
    exit_price: currentPrice,
    result_percent: realizedPercent,
    realized_percent: realizedPercent,
    remaining_fraction: 0,
    close_reason: "stop_loss",
  };
  events.push({
    eventType: "stopped_out",
    targetNumber: null,
    price: currentPrice,
    quantityFraction,
    contributionPercent,
    currentStopLoss: next.stop_loss,
  });

  return { recommendation: next, events };
}

export function expireManagedTrade(recommendation, currentPrice) {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error("Current price must be a positive finite number.");
  }
  if (recommendation.status !== "open") {
    return { recommendation, events: [] };
  }

  const quantityFraction = recommendation.remaining_fraction;
  const contributionPercent = calculatePartialResultPercent(
    recommendation.direction,
    recommendation.entry_price,
    currentPrice,
    quantityFraction,
  );
  const realizedPercent = recommendation.realized_percent + contributionPercent;
  const next = {
    ...recommendation,
    status: realizedPercent > 0 ? "success" : "failed",
    exit_price: currentPrice,
    result_percent: realizedPercent,
    realized_percent: realizedPercent,
    remaining_fraction: 0,
    close_reason: "time_limit",
  };

  return {
    recommendation: next,
    events: [{
      eventType: "trade_closed",
      targetNumber: null,
      price: currentPrice,
      quantityFraction,
      contributionPercent,
      currentStopLoss: next.stop_loss,
    }],
  };
}
