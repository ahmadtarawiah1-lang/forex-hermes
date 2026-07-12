import * as fs from "fs";
import * as path from "path";
import { Decision } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
export const LEDGER_PATH = path.join(DATA_DIR, "ledger.csv");
export const LEARNINGS_PATH = path.join(DATA_DIR, "learnings.md");

export const LEDGER_HEADER = "timestamp,symbol,action,price,quantity,reason,mode,outcome,pnl";

const LEARNINGS_TEMPLATE = `# Learnings

Plain-English lessons distilled from real closed trades or replay outcomes.
Nothing here is seeded or invented — this file only grows when \`replay:raw\`
or the memory-enabled path actually observes a losing setup.

`;

export function ensureMemoryFiles(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEDGER_PATH)) fs.writeFileSync(LEDGER_PATH, LEDGER_HEADER + "\n");
  if (!fs.existsSync(LEARNINGS_PATH)) fs.writeFileSync(LEARNINGS_PATH, LEARNINGS_TEMPLATE);
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function appendLedgerRow(decision: Decision): void {
  ensureMemoryFiles();
  const row = [
    decision.timestamp,
    decision.symbol,
    decision.action,
    decision.price.toFixed(2),
    decision.quantity.toFixed(6),
    csvEscape(decision.reason),
    decision.mode,
    decision.outcome,
    decision.pnl.toFixed(2),
  ].join(",");
  fs.appendFileSync(LEDGER_PATH, row + "\n");
}

export interface LedgerRow {
  timestamp: string;
  symbol: string;
  action: string;
  price: number;
  quantity: number;
  reason: string;
  mode: string;
  outcome: string;
  pnl: number;
}

export function readLedger(): LedgerRow[] {
  ensureMemoryFiles();
  const content = fs.readFileSync(LEDGER_PATH, "utf-8").trim();
  const lines = content.split("\n");
  if (lines.length <= 1) return [];

  return lines.slice(1).map((line) => {
    // Simple CSV split that respects our own quoting for the reason field.
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current);

    return {
      timestamp: fields[0],
      symbol: fields[1],
      action: fields[2],
      price: parseFloat(fields[3]),
      quantity: parseFloat(fields[4]),
      reason: fields[5],
      mode: fields[6],
      outcome: fields[7],
      pnl: parseFloat(fields[8]),
    };
  });
}

export function appendLearning(note: string): void {
  ensureMemoryFiles();
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LEARNINGS_PATH, `- [${timestamp}] ${note}\n`);
}

export function readLearnings(): string {
  ensureMemoryFiles();
  return fs.readFileSync(LEARNINGS_PATH, "utf-8");
}

export function resetMemory(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, LEDGER_HEADER + "\n");
  fs.writeFileSync(LEARNINGS_PATH, LEARNINGS_TEMPLATE);
}
