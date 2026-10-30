import type { Mode, Route } from "./api";

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];
export type Theme = "dark" | "light" | "neon";

/** What the user picks: a theme, or the system's light/dark setting. */
export type ThemeChoice = Theme | "system";

export const THEME_ORDER: ThemeChoice[] = ["system", "dark", "light", "neon"];

export type ColorKey =
  | "metroBlue" | "metroRed" | "metroGreen" | "rail"
  | "tram" | "roslagsbanan" | "ferry" | "bus";

const PALETTES: Record<Theme, Record<ColorKey, RGB>> = {
  // Muted versions of SL's line colors, so nothing glows against the dark map.
  dark: {
    metroBlue: [79, 142, 212],
    metroRed: [214, 86, 92],
    metroGreen: [84, 170, 112],
    rail: [208, 112, 158],
    tram: [214, 152, 74],
    roslagsbanan: [150, 124, 200],
    ferry: [86, 168, 184],
    bus: [168, 164, 154],
  },
  // SL's own line colors, like the printed network map.
  light: {
    metroBlue: [0, 137, 202],
    metroRed: [215, 29, 36],
    metroGreen: [23, 157, 77],
    rail: [236, 97, 159],
    tram: [222, 124, 0],
    roslagsbanan: [140, 77, 160],
    ferry: [0, 150, 180],
    bus: [128, 130, 138],
  },
  // Vivid colors meant for additive blending, where overlaps glow.
  neon: {
    metroBlue: [64, 156, 255],
    metroRed: [255, 77, 94],
    metroGreen: [61, 220, 132],
    rail: [255, 111, 181],
    tram: [255, 170, 51],
    roslagsbanan: [180, 140, 255],
    ferry: [54, 214, 231],
    bus: [242, 227, 194],
  },
};

export interface ThemeSettings {
  mapStyle: string;
  /** Opacity of the base map's roads, kept low so transit lines stand out. */
  roadOpacity: number;
  /** Ring around rail vehicle dots, separating them from their own line. */
  dotRing: RGBA | null;
  /** Additive blending plus halos around dots, so trails and vehicles glow. */
  glow: boolean;
  /** Multiplies each mode's trail alpha. */
  trailAlphaScale: number;
  /** 3D buildings, shown when zoomed in. Kept close to the map's background. */
  buildingColor: string;
  buildingOpacity: number;
  /** Station markers: a ring filled with the map's background, like a metro map. */
  stationFill: RGBA;
  stationRing: RGBA;
  /** Warning icons at stations with an acute disruption. */
  warning: RGBA;
  /** Station names, with an outline in the background color. */
  labelColor: RGBA;
}

export const THEMES: Record<Theme, ThemeSettings> = {
  dark: {
    mapStyle: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    roadOpacity: 0.45,
    dotRing: [240, 242, 246, 230],
    glow: false,
    trailAlphaScale: 1,
    buildingColor: "#2c2f35",
    buildingOpacity: 0.85,
    stationFill: [16, 18, 24, 255],
    stationRing: [196, 202, 214, 230],
    warning: [217, 163, 90, 255],
    labelColor: [176, 182, 196, 255],
  },
  light: {
    mapStyle: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    roadOpacity: 0.6,
    dotRing: [255, 255, 255, 255],
    glow: false,
    trailAlphaScale: 1,
    buildingColor: "#e2e2e0",
    buildingOpacity: 0.9,
    stationFill: [255, 255, 255, 255],
    stationRing: [64, 68, 78, 230],
    warning: [183, 116, 28, 255],
    labelColor: [74, 78, 88, 255],
  },
  neon: {
    mapStyle: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    roadOpacity: 0.45,
    dotRing: null,
    glow: true,
    trailAlphaScale: 1.8,
    buildingColor: "#1a1828",
    buildingOpacity: 0.85,
    stationFill: [16, 18, 24, 255],
    stationRing: [214, 220, 236, 230],
    warning: [255, 180, 84, 255],
    labelColor: [186, 192, 210, 255],
  },
};

export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: "System",
  dark: "Mörk",
  light: "Ljus",
  neon: "Neon",
};

export function colorKey(route: Route): ColorKey {
  const desc = route.desc.toLowerCase();
  switch (route.mode) {
    case "metro":
      if (desc.includes("blå")) return "metroBlue";
      if (desc.includes("röd")) return "metroRed";
      return "metroGreen";
    case "rail":
      return "rail";
    case "tram":
      return desc.includes("roslagsbanan") ? "roslagsbanan" : "tram";
    case "ferry":
      return "ferry";
    default:
      return "bus";
  }
}

export function color(theme: Theme, key: ColorKey): RGB {
  return PALETTES[theme][key];
}

/**
 * Inline style for a line badge filled with a line color. Light colors (such as
 * the dark theme's cream buses) get dark text so the line number stays readable.
 */
export function badgeStyle([r, g, b]: RGB): string {
  const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
  return `--c: rgb(${r},${g},${b})${light ? "; --fg: #16181d; --fg-shadow: none" : ""}`;
}

export interface ModeStyle {
  label: string;
  /** Line colors shown as a stripe under the mode's pictogram. */
  swatches: ColorKey[];
  trailWidth: number;
  trailAlpha: number;
  dotRadius: number;
  /** Rail-type vehicles get a light ring; buses stay plain background texture. */
  dotRing: boolean;
  /** Alpha of the static route lines under the vehicles. */
  lineAlpha: number;
  lineWidth: number;
  /** Whether the route lines are shown before the user changes it in settings. */
  linesByDefault: boolean;
}

// Order is draw order (later = on top) and sidebar order (reversed).
export const MODES: Record<Mode, ModeStyle> = {
  bus: {
    label: "Buss",
    swatches: ["bus"],
    trailWidth: 1.2,
    trailAlpha: 40,
    dotRadius: 2.2,
    dotRing: false,
    lineAlpha: 35,
    lineWidth: 0.8,
    // Bus routes mostly redraw the street grid, so they start hidden.
    linesByDefault: false,
  },
  ferry: {
    label: "Båt",
    swatches: ["ferry"],
    trailWidth: 2,
    trailAlpha: 110,
    dotRadius: 3.4,
    dotRing: true,
    lineAlpha: 50,
    lineWidth: 1,
    // Ferry routes cross open water in long straight lines, so they start hidden.
    linesByDefault: false,
  },
  tram: {
    label: "Spårväg & lokalbana",
    swatches: ["tram", "roslagsbanan"],
    trailWidth: 2.5,
    trailAlpha: 120,
    dotRadius: 3.4,
    dotRing: true,
    lineAlpha: 150,
    lineWidth: 1.6,
    linesByDefault: true,
  },
  rail: {
    label: "Pendeltåg",
    swatches: ["rail"],
    trailWidth: 2.5,
    trailAlpha: 120,
    dotRadius: 3.9,
    dotRing: true,
    lineAlpha: 160,
    lineWidth: 1.8,
    linesByDefault: true,
  },
  metro: {
    label: "Tunnelbana",
    swatches: ["metroGreen", "metroRed", "metroBlue"],
    trailWidth: 2.5,
    trailAlpha: 120,
    dotRadius: 3.9,
    dotRing: true,
    lineAlpha: 160,
    lineWidth: 1.8,
    linesByDefault: true,
  },
};

export const MODE_ORDER = Object.keys(MODES) as Mode[];
