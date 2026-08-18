/** Multi-axis racing profile chart with selectable time/distance X axis. */
import { CHART_COLORS, type ProfileNodeJson } from "@/model/contracts";
import {
  CONSTRAINT_COLORS,
  type ProfileLimitDomain,
} from "@/optimizer/constraint-domain";

interface Series {
  shortName: string;
  name: string;
  unit: string;
  color: string;
  values: (node: ProfileNodeJson) => number;
  dash?: number[];
}

const SERIES: Series[] = [
  { shortName: "V", name: "Speed", unit: "km/h", color: CHART_COLORS.speed, values: n => Math.sqrt(Math.max(n.q, 0)) * 3.6 },
  { shortName: "Ax", name: "Long accel", unit: "m/s²", color: CHART_COLORS.longAccel, values: n => n.acceleration },
  { shortName: "Ay", name: "Lateral accel", unit: "m/s²", color: CHART_COLORS.latAccel, values: n => n.q * n.curvature },
  { shortName: "St", name: "Stability", unit: "%", color: CHART_COLORS.utilization, values: n => 100 * n.stability },
  { shortName: "κ", name: "Curvature", unit: "1/m", color: CHART_COLORS.curvature, values: n => n.curvature },
];

export const PROFILE_CHART_LABELS = SERIES.map(({ shortName, name, unit, color }) => ({
  shortName,
  name,
  unit,
  color,
}));

export type ProfileXAxis = "time" | "distance";

export interface ChartProfile {
  nodes: ProfileNodeJson[];
  color?: string;
  lapTime?: number;
  lineLength?: number;
  /** Common track-centerline distances aligned with nodes. */
  axisDistances?: number[];
  axisLength?: number;
  limitDomains?: ProfileLimitDomain[];
}

export interface ChartOptions {
  xAxis: ProfileXAxis;
  cursorTime: number | null;
}

interface Range { lo: number; hi: number; }
interface Layout { left: number; right: number; top: number; bottom: number; width: number; height: number; }

export const PROFILE_CHART_AXIS_COLUMN_PX = 60;

function chartLayout(width: number, height: number): Layout {
  const left = 12 + PROFILE_CHART_AXIS_COLUMN_PX * SERIES.length;
  const right = 18;
  const top = 12;
  const bottom = 64;
  return { left, right, top, bottom, width: Math.max(1, width - left - right), height: Math.max(1, height - top - bottom) };
}

function profileExtent(profile: ChartProfile, axis: ProfileXAxis): number {
  if (axis === "time") {
    return profile.lapTime ?? profile.nodes.at(-1)!.time + (profile.nodes[1]!.time - profile.nodes[0]!.time);
  }
  return profile.axisLength ?? profile.lineLength ?? profile.nodes.at(-1)!.distance + (profile.nodes[1]!.distance - profile.nodes[0]!.distance);
}

function xValue(profile: ChartProfile, node: ProfileNodeJson, index: number, axis: ProfileXAxis): number {
  return axis === "time" ? node.time : profile.axisDistances?.[index] ?? node.distance;
}

function seriesRange(series: Series, nodes: ProfileNodeJson[]): Range {
  const values = nodes.map(series.values);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (series.name === "Stability") {
    lo = 0;
    hi = Math.max(110, hi);
  }
  if (series.name === "Curvature") {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  return { lo, hi };
}

function tickText(value: number, series: Series): string {
  if (series.name === "Curvature") return value.toFixed(3);
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) < 10 && value !== 0) return value.toFixed(1);
  return value.toFixed(0);
}

function distanceAtTime(profile: ChartProfile, time: number): number {
  const nodes = profile.nodes;
  const lap = profileExtent(profile, "time");
  const distance = profileExtent(profile, "distance");
  const axisDistances = profile.axisDistances;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nodes[mid]!.time <= time) lo = mid;
    else hi = mid - 1;
  }
  const a = nodes[lo]!;
  const b = nodes[(lo + 1) % nodes.length]!;
  const nextTime = lo + 1 < nodes.length ? b.time : lap;
  const aDistance = axisDistances?.[lo] ?? a.distance;
  const nextDistance = lo + 1 < nodes.length ? axisDistances?.[lo + 1] ?? b.distance : distance;
  const mix = (time - a.time) / Math.max(nextTime - a.time, 1e-12);
  return aDistance + mix * (nextDistance - aDistance);
}

function nodeAtTime(profile: ChartProfile, time: number): ProfileNodeJson {
  const nodes = profile.nodes;
  const lap = profileExtent(profile, "time");
  const local = ((time % lap) + lap) % lap;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nodes[mid]!.time <= local) lo = mid;
    else hi = mid - 1;
  }
  const a = nodes[lo]!;
  const b = nodes[(lo + 1) % nodes.length]!;
  const nextTime = lo + 1 < nodes.length ? b.time : lap;
  const mix = (local - a.time) / Math.max(nextTime - a.time, 1e-12);
  const blend = (left: number, right: number): number => left + mix * (right - left);
  return {
    parameter: blend(a.parameter, lo + 1 < nodes.length ? b.parameter : 64),
    distance: blend(a.distance, lo + 1 < nodes.length ? b.distance : profileExtent(profile, "distance")),
    time: local,
    q: blend(a.q, b.q),
    acceleration: blend(a.acceleration, b.acceleration),
    curvature: blend(a.curvature, b.curvature),
    stability: blend(a.stability, b.stability),
  };
}

export function profileTimeAtCanvasX(
  canvas: HTMLCanvasElement,
  profile: ChartProfile,
  axis: ProfileXAxis,
  clientX: number,
): number | null {
  if (profile.nodes.length < 2) return null;
  const rect = canvas.getBoundingClientRect();
  const layout = chartLayout(rect.width, rect.height);
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left - layout.left) / layout.width));
  if (axis === "time") return ratio * profileExtent(profile, "time");
  const target = ratio * profileExtent(profile, "distance");
  const nodes = profile.nodes;
  const distances = profile.axisDistances ?? nodes.map(node => node.distance);
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (distances[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  const a = nodes[lo]!;
  const b = nodes[(lo + 1) % nodes.length]!;
  const aDistance = distances[lo]!;
  const nextDistance = lo + 1 < nodes.length ? distances[lo + 1]! : profileExtent(profile, "distance");
  const nextTime = lo + 1 < nodes.length ? b.time : profileExtent(profile, "time");
  const mix = (target - aDistance) / Math.max(nextDistance - aDistance, 1e-12);
  return a.time + mix * (nextTime - a.time);
}

export function drawProfileChart(
  canvas: HTMLCanvasElement,
  primary: ChartProfile | null,
  comparisons: ChartProfile[] = [],
  options: ChartOptions = { xAxis: "time", cursorTime: null },
): void {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#171b20";
  ctx.fillRect(0, 0, width, height);
  const layout = chartLayout(width, height);

  ctx.strokeStyle = "#2b323a";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = layout.top + layout.height * i / 4;
    ctx.beginPath();
    ctx.moveTo(layout.left, y);
    ctx.lineTo(width - layout.right, y);
    ctx.stroke();
  }

  if (!primary || primary.nodes.length < 2) {
    ctx.fillStyle = "#89939f";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Profile appears after a valid line is available", width / 2, height / 2);
    return;
  }

  const extent = profileExtent(primary, options.xAxis);
  const ranges = SERIES.map(series => seriesRange(series, primary.nodes));
  const focusedNode = options.cursorTime === null ? null : nodeAtTime(primary, options.cursorTime);

  ctx.font = "600 13px ui-monospace, monospace";
  for (let sIndex = 0; sIndex < SERIES.length; sIndex++) {
    const series = SERIES[sIndex]!;
    const range = ranges[sIndex]!;
    const axisX = 10 + PROFILE_CHART_AXIS_COLUMN_PX * sIndex + 52;
    ctx.strokeStyle = series.color;
    ctx.fillStyle = series.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(axisX, layout.top);
    ctx.lineTo(axisX, layout.top + layout.height);
    ctx.stroke();
    ctx.font = "650 14px ui-monospace, monospace";
    ctx.textAlign = "right";
    for (let tick = 0; tick <= 2; tick++) {
      const ratio = tick / 2;
      const y = layout.top + layout.height * ratio;
      const value = range.hi - ratio * (range.hi - range.lo);
      ctx.beginPath();
      ctx.moveTo(axisX - 4, y);
      ctx.lineTo(axisX + 3, y);
      ctx.stroke();
      ctx.fillText(tickText(value, series), axisX - 7, y + 4);
    }
    if (focusedNode) {
      const value = series.values(focusedNode);
      const y = layout.top + layout.height * (1 - (value - range.lo) / (range.hi - range.lo));
      const text = tickText(value, series);
      ctx.font = "750 16px ui-monospace, monospace";
      const textWidth = ctx.measureText(text).width;
      ctx.fillStyle = "#171b20ee";
      ctx.fillRect(axisX - textWidth - 11, y - 10, textWidth + 8, 20);
      ctx.fillStyle = series.color;
      ctx.fillText(text, axisX - 7, y + 5);
    }
  }

  ctx.font = "12px system-ui";
  ctx.fillStyle = "#89939f";
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const x = layout.left + layout.width * i / 4;
    const value = extent * i / 4;
    ctx.fillText(options.xAxis === "time" ? value.toFixed(1) : value.toFixed(0), x, height - 30);
  }
  ctx.font = "11px system-ui";
  ctx.fillText(options.xAxis === "time" ? "LAP TIME (s)" : "TRACK CENTERLINE DISTANCE (m)", layout.left + layout.width / 2, height - 9);

  const accelerationRange = ranges[1]!;
  if (accelerationRange.lo <= 0 && accelerationRange.hi >= 0) {
    const zeroY = layout.top + layout.height * (1 - (0 - accelerationRange.lo) / (accelerationRange.hi - accelerationRange.lo));
    ctx.save();
    ctx.strokeStyle = CHART_COLORS.longAccel;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(layout.left, zeroY);
    ctx.lineTo(layout.left + layout.width, zeroY);
    ctx.stroke();
    ctx.restore();
  }

  const curvatureRange = ranges[4]!;
  const zeroCurvatureY = layout.top + layout.height * (
    1 - (0 - curvatureRange.lo) / (curvatureRange.hi - curvatureRange.lo)
  );
  ctx.save();
  ctx.strokeStyle = CHART_COLORS.curvature;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.moveTo(layout.left, zeroCurvatureY);
  ctx.lineTo(layout.left + layout.width, zeroCurvatureY);
  ctx.stroke();
  ctx.restore();

  for (let sIndex = 0; sIndex < SERIES.length; sIndex++) {
    const series = SERIES[sIndex]!;
    const range = ranges[sIndex]!;
    const values = primary.nodes.map(series.values);
    ctx.beginPath();
    for (let i = 0; i < primary.nodes.length; i++) {
      const node = primary.nodes[i]!;
      const x = layout.left + layout.width * xValue(primary, node, i, options.xAxis) / extent;
      const y = layout.top + layout.height * (1 - (values[i]! - range.lo) / (range.hi - range.lo));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = series.color;
    ctx.lineWidth = series.name === "Speed" ? 2 : 1.2;
    ctx.setLineDash(series.dash ?? []);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const speedRange = ranges[0]!;
  for (const comparison of comparisons) {
    if (comparison.nodes.length < 2) continue;
    const ownExtent = profileExtent(comparison, options.xAxis);
    ctx.beginPath();
    for (let i = 0; i < comparison.nodes.length; i++) {
      const node = comparison.nodes[i]!;
      const speed = SERIES[0]!.values(node);
      const x = layout.left + layout.width * xValue(comparison, node, i, options.xAxis) / Math.max(extent, ownExtent);
      const y = layout.top + layout.height * (1 - (speed - speedRange.lo) / (speedRange.hi - speedRange.lo));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = comparison.color ?? "#fff";
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const domains = primary.limitDomains;
  if (domains?.length === primary.nodes.length) {
    const ribbonY = layout.top + layout.height + 7;
    const ribbonHeight = 10;
    let start = 0;
    for (let i = 1; i <= domains.length; i++) {
      if (i < domains.length && domains[i] === domains[start]) continue;
      const first = primary.nodes[start]!;
      const x0 = layout.left + layout.width * xValue(
        primary, first, start, options.xAxis,
      ) / extent;
      const x1 = i === domains.length
        ? layout.left + layout.width
        : layout.left + layout.width * xValue(
            primary, primary.nodes[i]!, i, options.xAxis,
          ) / extent;
      ctx.fillStyle = CONSTRAINT_COLORS[domains[start] ?? "none"];
      ctx.fillRect(x0, ribbonY, Math.max(1, x1 - x0), ribbonHeight);
      start = i;
    }
  }

  if (options.cursorTime !== null) {
    const cursorValue = options.xAxis === "time"
      ? options.cursorTime
      : distanceAtTime(primary, options.cursorTime);
    const x = layout.left + layout.width * cursorValue / extent;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, layout.top);
    ctx.lineTo(x, layout.top + layout.height);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 12px ui-monospace, monospace";
    ctx.textAlign = x > layout.left + layout.width - 70 ? "right" : "left";
    ctx.fillText(`${options.cursorTime.toFixed(3)} s`, x + (ctx.textAlign === "left" ? 5 : -5), layout.top + 11);
  }
}
