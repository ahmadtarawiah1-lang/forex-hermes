import { scan } from "./bot";
import { runReplay, ReplaySummary } from "./replay";
import { resetMemory, readLedger, readLearnings } from "./memory";
import { MarketDataError } from "./market";
import { loadState } from "./config";
import { ReflectionResult } from "./reflect";
import { reflectWithLLM } from "./llmReflect";

const state = loadState();
const strategyConfig = state.strategy;
const riskConfig = state.risk;
const cooldownMs = state.memory.cooldownHours * 3_600_000;

function printSummary(label: string, summary: ReplaySummary): void {
  console.log(`\n=== ${label} summary ===`);
  console.log(`Total setups detected: ${summary.totalSetups}`);
  console.log(`Trades taken: ${summary.trades.length}`);
  console.log(`Skips: ${summary.skips.length}`);
  console.log(`Wins: ${summary.wins}`);
  console.log(`Losses: ${summary.losses}`);
  console.log(`Win rate: ${(summary.winRate * 100).toFixed(1)}%`);
  console.log(`Average PnL per trade: $${summary.avgPnl.toFixed(2)}`);
  console.log(
    `Best trade: ${summary.bestTrade ? `$${summary.bestTrade.pnl.toFixed(2)} (${summary.bestTrade.entryTime})` : "none"}`
  );
  console.log(
    `Worst trade: ${summary.worstTrade ? `$${summary.worstTrade.pnl.toFixed(2)} (${summary.worstTrade.entryTime})` : "none"}`
  );
  console.log(`Max drawdown: ${(summary.maxDrawdownPct * 100).toFixed(2)}%`);
  console.log(`Ending equity: $${summary.endingEquity.toFixed(2)} (started at $${riskConfig.startingEquity.toFixed(2)})`);

  if (summary.trades.length > 0) {
    console.log(`\nTrade-by-trade:`);
    for (const t of summary.trades) {
      console.log(
        `  #${t.setupIndex} ${t.entryTime} BUY @ ${t.entryPrice.toFixed(2)} -> ${t.exitTime} ` +
          `${t.exitReason} @ ${t.exitPrice.toFixed(2)} | qty ${t.quantity.toFixed(6)} | ` +
          `pnl $${t.pnl.toFixed(2)} | ${t.outcome}`
      );
    }
  }

  if (summary.skips.length > 0) {
    console.log(`\nSkipped setups:`);
    for (const s of summary.skips) {
      console.log(`  #${s.setupIndex} ${s.time} SKIP — ${s.reason}`);
    }
  }

  const repeatedLosses = summary.losses;
  if (repeatedLosses >= 2) {
    console.log(
      `\nFLAG: ${repeatedLosses} losing setups actually appeared in this window — this is a real ` +
        `repeated-weakness signal, not a manufactured one.`
    );
  } else if (summary.totalSetups === 0) {
    console.log(`\nNote: no crossover setups occurred in this data window — nothing to report either way.`);
  } else if (repeatedLosses === 0) {
    console.log(`\nNote: no losing setups appeared in this window's real data — the strategy held up here.`);
  }
}

function printReflection(result: ReflectionResult): void {
  console.log(`\n=== reflection (${result.decidedBy ?? "heuristic"}) ===`);
  if (result.changed) {
    console.log(`Strategy CHANGED. ${result.reason}`);
  } else {
    console.log(`No change. ${result.reason}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  try {
    switch (command) {
      case "scan":
        await scan(strategyConfig, riskConfig);
        break;

      case "replay:raw": {
        const summary = await runReplay(strategyConfig, riskConfig, "raw", cooldownMs);
        printSummary("replay:raw (no memory)", summary);
        printReflection(await reflectWithLLM());
        break;
      }

      case "replay:memory": {
        const ledgerBefore = readLedger();
        if (ledgerBefore.length === 0) {
          console.log(
            "No memory recorded yet in data/ledger.csv. Run `npm run replay:raw` first so real " +
              "outcomes populate memory, then re-run `npm run replay:memory` to see it take effect.\n" +
              "Proceeding anyway — this run will behave like replay:raw since there is nothing to skip yet.\n"
          );
        }
        const summary = await runReplay(strategyConfig, riskConfig, "memory", cooldownMs);
        printSummary("replay:memory (memory-enabled)", summary);
        console.log(`\nLatest learnings.md:\n${readLearnings()}`);
        printReflection(await reflectWithLLM());
        break;
      }

      case "reflect":
        printReflection(await reflectWithLLM());
        break;

      case "memory:reset":
        resetMemory();
        console.log("Memory reset: data/ledger.csv and data/learnings.md are back to empty templates.");
        break;

      default:
        console.error(
          `Unknown or missing command: "${command ?? ""}". Use one of: scan, replay:raw, replay:memory, reflect, memory:reset.`
        );
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof MarketDataError) {
      console.error(`\nBLOCKED: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
