// Trafikverket's road ferries around Stockholm. Trafikverket publishes their
// departures but not where the routes run, so each route's path (from its
// first harbor to its second) and crossing time come from OpenStreetMap
// (© OpenStreetMap contributors, ODbL).

export interface FerryRoute {
  /** As Trafikverket names it, e.g. "Vaxholmsleden". */
  name: string;
  /** Trafikverket's harbor names, at the start and the end of `path`. */
  harbors: [string, string];
  crossingS: number;
  path: [number, number][];
}

export const FERRY_ROUTES: FerryRoute[] = [
  {
    name: "Vaxholmsleden",
    harbors: ["Vaxholm", "Rindö"],
    crossingS: 360,
    // OSM way 146379921
    path: [[18.34994, 59.40011], [18.35023, 59.39994], [18.35067, 59.39972], [18.35108, 59.3996], [18.35152, 59.39953], [18.35237, 59.39952], [18.35269, 59.39952], [18.35377, 59.39958], [18.35566, 59.39986], [18.35764, 59.40026], [18.35898, 59.40057], [18.36047, 59.40099], [18.3616, 59.40137], [18.36281, 59.4019], [18.36383, 59.40258], [18.36431, 59.40298], [18.36461, 59.40348]],
  },
  {
    name: "Oxdjupsleden",
    harbors: ["Rindö", "Värmdö"],
    crossingS: 180,
    // OSM way 13024063
    path: [[18.44095, 59.39551], [18.44154, 59.39511], [18.44194, 59.3951], [18.44293, 59.39516], [18.44385, 59.39529], [18.44452, 59.39536], [18.44558, 59.39549], [18.44634, 59.39566], [18.44704, 59.39582], [18.44805, 59.39603], [18.44863, 59.39638], [18.44889, 59.39672]],
  },
  {
    name: "Tynningöleden",
    harbors: ["Norra Lagnö", "Tynningö"],
    crossingS: 480,
    // OSM way 75479630
    path: [[18.41155, 59.3554], [18.41252, 59.3573], [18.41705, 59.36126], [18.42053, 59.36312]],
  },
  {
    name: "Ljusteröleden",
    harbors: ["Ljusterö", "Östanå"],
    crossingS: 420,
    // OSM way 31988315
    path: [[18.59145, 59.54181], [18.59088, 59.54218], [18.57728, 59.54738], [18.57551, 59.54814]],
  },
  {
    name: "Furusundsleden",
    harbors: ["Furusund", "Yxlan"],
    crossingS: 240,
    // OSM way 4631654
    path: [[18.92547, 59.66308], [18.92655, 59.66215], [18.93022, 59.66077], [18.93209, 59.65987]],
  },
  {
    name: "Blidöleden",
    harbors: ["Yxlan", "Blidö"],
    crossingS: 240,
    // OSM way 76369014
    path: [[18.93893, 59.64874], [18.93729, 59.64868], [18.93448, 59.65091], [18.93363, 59.65156], [18.93246, 59.65188]],
  },
  {
    name: "Ekeröleden",
    harbors: ["Slagsta", "Ekerö"],
    crossingS: 600,
    // OSM way 35262813
    path: [[17.86991, 59.25765], [17.86888, 59.25921], [17.86692, 59.26071], [17.84787, 59.27061], [17.84628, 59.27119]],
  },
  {
    name: "Adelsöleden",
    harbors: ["Munsö", "Adelsö"],
    crossingS: 360,
    // OSM way 152905168
    path: [[17.52595, 59.38486], [17.53533, 59.39104], [17.53549, 59.39123]],
  },
  {
    name: "Skanssundsleden",
    harbors: ["Hörningsnäs", "Mörkö"],
    crossingS: 180,
    // OSM way 25194772
    path: [[17.69311, 59.05233], [17.69242, 59.05222], [17.6919, 59.05185], [17.69131, 59.05136], [17.69085, 59.05095], [17.69019, 59.05022], [17.68999, 59.04988], [17.68994, 59.04976]],
  },
];
