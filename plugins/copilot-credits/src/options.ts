import { record } from "./parser.ts"

export function seconds(options: unknown, key: string, fallback: number, min: number, max: number): number {
  const value = record(options)[key]
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value * 1000 : fallback * 1000
}
