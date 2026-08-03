/**
 * Scenic fly-spot candidates for community map pins.
 * Intentionally rural / coastal — away from CTR cores and major landmarks
 * that usually map to PROHIBITED. Airspace filter still runs at seed time.
 */
export type ScenicFlySpot = {
  country: string;
  type: "park" | "beach" | "field" | "other";
  lat: number;
  lng: number;
  message: string;
  /** Wikimedia Commons search used to fetch a photo */
  photoQuery: string;
};

export const SCENIC_FLY_SPOTS: ScenicFlySpot[] = [
  // --- Spain ---
  { country: "ES", type: "beach", lat: 36.732, lng: -2.122, message: "Playa de los Genoveses, Cabo de Gata", photoQuery: "Playa de los Genoveses" },
  { country: "ES", type: "beach", lat: 42.244, lng: -8.85, message: "Dunas de Laxe, Costa da Morte", photoQuery: "Playa de Laxe" },
  { country: "ES", type: "field", lat: 39.46, lng: -5.88, message: "Dehesa near Trujillo, Extremadura", photoQuery: "Dehesa Extremadura" },
  { country: "ES", type: "field", lat: 42.58, lng: -7.65, message: "High meadow, Serra do Courel", photoQuery: "Serra do Courel" },
  { country: "ES", type: "beach", lat: 41.78, lng: 3.03, message: "Cala on Cap de Creus (south side)", photoQuery: "Cap de Creus cala" },
  { country: "ES", type: "field", lat: 41.12, lng: -3.58, message: "Open field, Sierra Norte de Madrid", photoQuery: "Sierra Norte Madrid" },
  { country: "ES", type: "field", lat: 37.88, lng: -4.78, message: "Olive grove countryside, Córdoba province", photoQuery: "olivar Córdoba" },

  // --- Germany ---
  { country: "DE", type: "field", lat: 49.45, lng: 10.95, message: "Franconian field near Hersbruck", photoQuery: "Fränkische Schweiz Landschaft" },
  { country: "DE", type: "field", lat: 50.35, lng: 7.45, message: "Mosel vineyard hills above Winningen", photoQuery: "Mosel Weinberge" },
  { country: "DE", type: "beach", lat: 54.42, lng: 12.68, message: "Darß Baltic coast dunes", photoQuery: "Darß Weststrand" },
  { country: "DE", type: "field", lat: 48.05, lng: 8.15, message: "Black Forest meadow near Triberg", photoQuery: "Schwarzwald Wiese" },
  { country: "DE", type: "field", lat: 51.75, lng: 10.55, message: "Harz highland meadow", photoQuery: "Harz Landschaft" },
  { country: "DE", type: "field", lat: 47.72, lng: 10.32, message: "Allgäu meadow near Füssen (away from town)", photoQuery: "Allgäu Almwiese" },
  { country: "DE", type: "field", lat: 50.95, lng: 14.15, message: "Saxon Switzerland foothill meadow", photoQuery: "Sächsische Schweiz Wiese" },

  // --- France ---
  { country: "FR", type: "field", lat: 47.25, lng: 0.85, message: "Loire valley field near Amboise countryside", photoQuery: "Val de Loire campagne" },
  { country: "FR", type: "beach", lat: 43.52, lng: 4.58, message: "Camargue beach dunes (rural)", photoQuery: "Camargue plage" },
  { country: "FR", type: "field", lat: 43.92, lng: 5.05, message: "Lavender field, plateau de Valensole", photoQuery: "Valensole lavande" },
  { country: "FR", type: "beach", lat: 48.68, lng: -2.32, message: "Cap Fréhel cliffs meadow", photoQuery: "Cap Fréhel" },
  { country: "FR", type: "field", lat: 44.85, lng: 1.22, message: "Dordogne valley meadow", photoQuery: "Dordogne campagne" },
  { country: "FR", type: "field", lat: 48.15, lng: 7.05, message: "Vosges ridge meadow", photoQuery: "Vosges prairie" },
  { country: "FR", type: "field", lat: 45.72, lng: 6.55, message: "Alpine meadow near Beaufortain", photoQuery: "Beaufortain alpage" },

  // --- Denmark ---
  { country: "DK", type: "beach", lat: 54.96, lng: 12.53, message: "Møns Klint coastal meadow", photoQuery: "Møns Klint" },
  { country: "DK", type: "beach", lat: 57.73, lng: 10.62, message: "Skagen Grenen dunes", photoQuery: "Skagen Grenen" },
  { country: "DK", type: "field", lat: 55.45, lng: 9.55, message: "Jutland field near Kolding countryside", photoQuery: "Jylland landskab" },
  { country: "DK", type: "beach", lat: 56.02, lng: 8.12, message: "West Jutland beach dunes", photoQuery: "Vesterhavet klitter" },
  { country: "DK", type: "field", lat: 55.75, lng: 11.85, message: "Zealand countryside meadow", photoQuery: "Sjælland landskab" },
  { country: "DK", type: "beach", lat: 56.15, lng: 10.22, message: "Djursland coast", photoQuery: "Djursland kyst" },
  { country: "DK", type: "field", lat: 55.35, lng: 10.35, message: "Funen rural field", photoQuery: "Fyn landskab" },

  // --- Switzerland ---
  { country: "CH", type: "field", lat: 46.62, lng: 7.95, message: "Bernese Oberland meadow (away from resorts)", photoQuery: "Berner Oberland Wiese" },
  { country: "CH", type: "field", lat: 46.45, lng: 9.15, message: "Graubünden alpine meadow", photoQuery: "Graubünden Alp" },
  { country: "CH", type: "field", lat: 46.25, lng: 7.35, message: "Valais hillside meadow", photoQuery: "Valais prairie" },
  { country: "CH", type: "field", lat: 46.78, lng: 6.65, message: "Jura pasture near Vallorbe", photoQuery: "Jura suisse pâturage" },
  { country: "CH", type: "field", lat: 47.05, lng: 9.05, message: "Glarus valley meadow", photoQuery: "Glarnerland" },
  { country: "CH", type: "field", lat: 46.55, lng: 8.35, message: "Uri alpine meadow", photoQuery: "Uri Alpwiese" },
  { country: "CH", type: "field", lat: 46.85, lng: 8.65, message: "Schwyz highland pasture", photoQuery: "Schwyz Landschaft" },

  // --- Portugal ---
  { country: "PT", type: "beach", lat: 37.08, lng: -8.25, message: "Algarve cliff meadow near Benagil hinterland", photoQuery: "Algarve cliffs" },
  { country: "PT", type: "field", lat: 38.78, lng: -9.45, message: "Sintra countryside (away from palace)", photoQuery: "Sintra landscape" },
  { country: "PT", type: "beach", lat: 39.37, lng: -9.37, message: "Nazaré coastal dunes north", photoQuery: "Nazaré beach" },
  { country: "PT", type: "field", lat: 41.15, lng: -7.78, message: "Douro valley terrace view", photoQuery: "Douro valley vineyards" },
  { country: "PT", type: "field", lat: 40.2, lng: -7.5, message: "Serra da Estrela foothill", photoQuery: "Serra da Estrela" },
  { country: "PT", type: "beach", lat: 37.72, lng: -8.78, message: "Costa Vicentina dunes", photoQuery: "Costa Vicentina" },
  { country: "PT", type: "field", lat: 39.25, lng: -7.45, message: "Alentejo cork oak dehesa", photoQuery: "Alentejo montado" },

  // --- Austria ---
  { country: "AT", type: "field", lat: 47.55, lng: 13.65, message: "Salzkammergut meadow (away from Hallstatt pier)", photoQuery: "Salzkammergut Wiese" },
  { country: "AT", type: "field", lat: 47.25, lng: 11.35, message: "Tyrol valley meadow near Innsbruck countryside", photoQuery: "Tirol Alm" },
  { country: "AT", type: "field", lat: 46.85, lng: 13.85, message: "Carinthia lake hinterland meadow", photoQuery: "Kärnten Landschaft" },
  { country: "AT", type: "field", lat: 47.85, lng: 14.85, message: "Mostviertel orchard countryside", photoQuery: "Mostviertel" },
  { country: "AT", type: "field", lat: 47.05, lng: 15.45, message: "Styrian vineyard hills", photoQuery: "Steiermark Weinberge" },
  { country: "AT", type: "field", lat: 47.35, lng: 12.75, message: "Pinzgau alpine meadow", photoQuery: "Pinzgau Alm" },
  { country: "AT", type: "field", lat: 48.25, lng: 14.55, message: "Mühlviertel highland field", photoQuery: "Mühlviertel" },

  // --- Czechia ---
  { country: "CZ", type: "field", lat: 48.85, lng: 16.65, message: "Pálava vineyard trail", photoQuery: "Pálava vinice" },
  { country: "CZ", type: "field", lat: 49.0, lng: 14.77, message: "Třeboňsko pond reed meadow", photoQuery: "Třeboňsko" },
  { country: "CZ", type: "field", lat: 50.55, lng: 16.05, message: "Adršpach foothill meadow", photoQuery: "Adršpach krajina" },
  { country: "CZ", type: "field", lat: 49.25, lng: 14.15, message: "South Bohemia rural field", photoQuery: "Jižní Čechy krajina" },
  { country: "CZ", type: "field", lat: 49.55, lng: 18.05, message: "Beskydy mountain meadow", photoQuery: "Beskydy louka" },
  { country: "CZ", type: "field", lat: 50.05, lng: 12.85, message: "Slavkovský les clearing", photoQuery: "Slavkovský les" },
  { country: "CZ", type: "field", lat: 48.95, lng: 17.15, message: "White Carpathians meadow", photoQuery: "Bílé Karpaty" },

  // --- Poland ---
  { country: "PL", type: "field", lat: 53.8, lng: 21.55, message: "Masurian lake meadow near Mikołajki", photoQuery: "Mazury jezioro" },
  { country: "PL", type: "field", lat: 49.55, lng: 20.65, message: "Beskid Niski mountain clearing", photoQuery: "Beskid Niski" },
  { country: "PL", type: "beach", lat: 54.75, lng: 17.55, message: "Baltic dunes near Łeba hinterland", photoQuery: "Słowiński Park Wydmy" },
  { country: "PL", type: "field", lat: 52.9, lng: 23.15, message: "Podlasie forest clearing", photoQuery: "Puszcza Białowieska polana" },
  { country: "PL", type: "field", lat: 50.05, lng: 19.95, message: "Jura Krakowsko-Częstochowska field", photoQuery: "Jura Krakowsko-Częstochowska" },
  { country: "PL", type: "field", lat: 53.15, lng: 20.05, message: "Warmia lakeside pasture", photoQuery: "Warmia krajobraz" },
  { country: "PL", type: "field", lat: 51.25, lng: 16.55, message: "Lower Silesia countryside field", photoQuery: "Dolny Śląsk krajobraz" },

  // --- Sweden ---
  { country: "SE", type: "field", lat: 59.35, lng: 18.55, message: "Stockholm archipelago island meadow", photoQuery: "Stockholms skärgård" },
  { country: "SE", type: "field", lat: 55.55, lng: 14.25, message: "Österlen coastal meadow", photoQuery: "Österlen" },
  { country: "SE", type: "field", lat: 57.65, lng: 18.35, message: "Gotland rural field", photoQuery: "Gotland landskap" },
  { country: "SE", type: "field", lat: 63.35, lng: 18.75, message: "High Coast hinterland", photoQuery: "Höga Kusten" },
  { country: "SE", type: "field", lat: 58.35, lng: 11.55, message: "Bohuslän coastal rocks meadow", photoQuery: "Bohuslän" },
  { country: "SE", type: "field", lat: 60.15, lng: 16.25, message: "Dalarna lake countryside", photoQuery: "Dalarna landskap" },
  { country: "SE", type: "field", lat: 56.85, lng: 14.85, message: "Småland forest clearing", photoQuery: "Småland skog" },

  // --- Ireland ---
  { country: "IE", type: "field", lat: 53.15, lng: -9.55, message: "Connemara bog meadow", photoQuery: "Connemara landscape" },
  { country: "IE", type: "beach", lat: 52.15, lng: -10.05, message: "Dingle peninsula coastal field", photoQuery: "Dingle Peninsula" },
  { country: "IE", type: "field", lat: 53.55, lng: -9.85, message: "Mayo coastal pasture", photoQuery: "County Mayo coast" },
  { country: "IE", type: "field", lat: 51.85, lng: -9.55, message: "Ring of Kerry hinterland field", photoQuery: "Ring of Kerry landscape" },
  { country: "IE", type: "field", lat: 54.25, lng: -7.85, message: "Fermanagh lake countryside", photoQuery: "Fermanagh lakes" },
  { country: "IE", type: "beach", lat: 55.15, lng: -7.95, message: "Donegal coastal dunes", photoQuery: "Donegal beach" },
  { country: "IE", type: "field", lat: 52.95, lng: -6.35, message: "Wicklow mountain foothill", photoQuery: "Wicklow Mountains" },

  // --- Latvia ---
  { country: "LV", type: "beach", lat: 56.98, lng: 23.55, message: "Jūrmala hinterland dunes (away from pier)", photoQuery: "Jūrmala beach" },
  { country: "LV", type: "field", lat: 57.15, lng: 24.85, message: "Gauja National Park meadow", photoQuery: "Gauja National Park" },
  { country: "LV", type: "beach", lat: 57.75, lng: 22.55, message: "Cape Kolka coastal meadow", photoQuery: "Kolkasrags" },
  { country: "LV", type: "field", lat: 56.55, lng: 25.85, message: "Latgale lake countryside", photoQuery: "Latgale landscape" },
  { country: "LV", type: "field", lat: 56.85, lng: 21.55, message: "Kurzeme rural field", photoQuery: "Kurzeme landscape" },
  { country: "LV", type: "beach", lat: 57.35, lng: 21.55, message: "Ventspils coastal dunes south", photoQuery: "Ventspils beach" },
  { country: "LV", type: "field", lat: 56.65, lng: 23.75, message: "Zemgale open field", photoQuery: "Zemgale" },
];
