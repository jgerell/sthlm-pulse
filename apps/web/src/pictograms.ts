// Mode pictograms in the manner of transit signage: solid shapes with cut-out
// windows and lights, drawn on a 24 × 24 grid in currentColor.
import type { Mode } from "./api";

const svg = (body: string) =>
  `<svg class="pictogram" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const PICTOGRAMS: Record<Mode, string> = {
  // Train seen from the front: windscreen, headlights, running gear.
  metro: svg(`<path fill-rule="evenodd" d="M6.5 3h11A2.5 2.5 0 0 1 20 5.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 15.5v-10A2.5 2.5 0 0 1 6.5 3ZM6.5 6v5.5h11V6ZM8 13.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm8 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/><path d="M7.4 18.5h2.3L8 21.5H5.7Zm6.9 0h2.3l1.7 3h-2.3Z"/>`),
  // Commuter train from the side: a long car with a row of windows.
  rail: svg(`<path fill-rule="evenodd" d="M2 7h14.5A5.5 5.5 0 0 1 22 12.5V17H2Zm2 2.5v3h3v-3Zm5 0v3h3v-3Zm5 0v3h2.8a3.5 3.5 0 0 0-2.3-3Z"/><path d="M2 18.5h20V20H2Z"/>`),
  // Tram from the front, with its pantograph.
  tram: svg(`<path d="M8 2h8v1.4h-3.3L14.5 6H9.5l1.8-2.6H8Z"/><path fill-rule="evenodd" d="M7 6.5h10A2.5 2.5 0 0 1 19.5 9v7a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 16V9A2.5 2.5 0 0 1 7 6.5Zm0 2.5v4.5h10V9Zm1.5 6.1a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm7 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z"/><path d="M7.5 19h2.2L8.3 21.5H6.1Zm6.8 0h2.2l1.4 2.5h-2.2Z"/>`),
  // Bus from the front: destination band, windscreen, mirrors, wheels.
  bus: svg(`<path fill-rule="evenodd" d="M6.5 2.5h11a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2ZM7 4v1.2h10V4Zm-.5 2.6v6h11v-6Zm1.8 8a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm7.4 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z"/><path d="M6.5 19.5h3V22h-3Zm8 0h3V22h-3ZM2.5 7H4v3.5H2.5Zm17.5 0h1.5v3.5H20Z"/>`),
  // Ferry: hull, cabin with windows, funnel, a line of water.
  ferry: svg(`<path d="M10 4h3v3.5h-3Z"/><path fill-rule="evenodd" d="M6 8h11.5v5H6Zm1.6 1.5v2h2v-2Zm3.2 0v2h2v-2Zm3.2 0v2h2v-2Z"/><path d="M2.5 14h19l-2.6 4.5H5.1Z"/><path d="M2 20.2c1.7 0 1.7-.9 3.3-.9s1.7.9 3.4.9 1.6-.9 3.3-.9 1.7.9 3.3.9 1.7-.9 3.4-.9 1.6.9 3.3.9V22c-1.7 0-1.7-.9-3.3-.9s-1.7.9-3.4.9-1.6-.9-3.3-.9-1.7.9-3.3.9-1.7-.9-3.4-.9S3.7 22 2 22Z"/>`),
};

/** A long-distance train in profile: a pointed nose, a window band, the rails. */
export const REGIONAL_PICTOGRAM = svg(
  `<path fill-rule="evenodd" d="M2 7h11c4.4 0 8 3 8.9 7.4a.9.9 0 0 1-.9 1.1H2Zm0 2.5v3h9v-3Zm11 0v3h5.6a6.4 6.4 0 0 0-4.3-3Z"/><path d="M2 17.5h20V19H2Z"/>`,
);

/** A road ferry: a flat hull with a car on deck, over a line of water. */
export const ROAD_FERRY_PICTOGRAM = svg(
  `<path fill-rule="evenodd" d="M7.2 6h7.1c.6 0 1.1.3 1.4.8l1.6 2.7h.7a1 1 0 0 1 1 1v2H5v-2a1 1 0 0 1 1-1h.1l.7-2.5c.1-.6.7-1 1.4-1Zm.6 1.8-.5 1.7h7.9l-1-1.7Z"/><path d="M2 13.5h20l-2.2 4H4.2Z"/><path d="M2 20.2c1.7 0 1.7-.9 3.3-.9s1.7.9 3.4.9 1.6-.9 3.3-.9 1.7.9 3.3.9 1.7-.9 3.4-.9 1.6.9 3.3.9V22c-1.7 0-1.7-.9-3.3-.9s-1.7.9-3.4.9-1.6-.9-3.3-.9-1.7.9-3.3.9-1.7-.9-3.4-.9S3.7 22 2 22Z"/>`,
);

/** A large ship: a long hull with a raised bow, containers and the bridge aft. */
export const SHIP_PICTOGRAM = svg(
  `<path d="M1.5 14.5h21l-2.6 4.8H4.6Z"/><path d="M3.5 10.5h4v3h-4Zm5 0h4v3h-4Zm5 0h4v3h-4Z"/><path fill-rule="evenodd" d="M18.5 6h3v7.5h-3Zm.8 1.2v1.4h1.4V7.2Z"/>`,
);

/** A warning triangle with an exclamation mark cut out. */
export const WARNING_PICTOGRAM = svg(
  `<path fill-rule="evenodd" d="M12 3 22 20.5H2Zm-1 6v5.5h2V9Zm0 7v2h2v-2Z"/>`,
);

/** An "i" for planned changes, beside the warning triangle for acute ones. */
export const INFO_PICTOGRAM = svg(
  `<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19ZM11 10.5V17h2v-6.5Zm1-4.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/>`,
);
