import { record } from "./parser.js";
export function seconds(options, key, fallback, min, max) {
  const value = record(options)[key];
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value * 1000 : fallback * 1000;
}
