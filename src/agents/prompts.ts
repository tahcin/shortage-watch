import type { Evidence } from "../evidence.js";
import type { Memory } from "./types.js";

export const SYSTEM_BASE = `You are part of Shortage Watch, a team of agents helping a hospital pharmacy buyer decide what to order this week.
Rules for every answer:
- Use only the evidence records you are given. Every claim must cite the ids of the evidence records that support it.
- Never invent products, NDCs, dates, availability, reasons or numbers. If the evidence does not say something, do not say it.
- Plain, short sentences a busy buyer can act on. No em dashes.
- Reply with ONE JSON object and nothing else.`;

export function evidenceBlock(list: Evidence[]): string {
  return list.map((e) => `[${e.id}] ${e.summary}`).join("\n");
}

export function memoryBlock(memories: Memory[]): string {
  if (!memories.length) return "No saved buyer decisions apply.";
  return memories.map((m) => `[${m.id}] ${m.content}`).join("\n");
}
