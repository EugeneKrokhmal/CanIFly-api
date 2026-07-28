import type { WeightClass } from "@canifly/middleware";

export interface CatalogDrone {
  id: string;
  manufacturer: string;
  name: string;
  label: string;
  uasClass: string | null;
  weightG: number | null;
  maxTakeoffG: number | null;
  enduranceMin: number | null;
  hasCamera: boolean | null;
  isToy: boolean | null;
  /** Derived open-category class used by CanIFly filters. */
  weightClass: WeightClass;
  classSource: "easa_label" | "mtom" | "weight" | "default";
}

export interface OpenDroneListRow {
  manufacturer?: string;
  name?: string;
  uas_class?: string | null;
  weight?: string | number | null;
  max_takeoff?: string | number | null;
  endurance?: string | number | null;
  has_camera?: boolean | null;
  is_toy?: boolean | null;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeEasaClass(raw: string | null | undefined): WeightClass | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  if (c === "C0" || c === "0") return "c0";
  if (c === "C1" || c === "1") return "c1";
  if (c === "C2" || c === "2") return "c2";
  // C3+ still fly open in some cases but our UI only filters c0–c2
  if (c === "C3" || c === "C4") return "c2";
  return null;
}

/**
 * Prefer official EASA class mark; otherwise infer from MTOM / empty weight.
 */
export function classifyDroneModel(row: {
  uasClass?: string | null;
  weightG?: number | null;
  maxTakeoffG?: number | null;
}): { weightClass: WeightClass; classSource: CatalogDrone["classSource"] } {
  const fromLabel = normalizeEasaClass(row.uasClass ?? null);
  if (fromLabel) return { weightClass: fromLabel, classSource: "easa_label" };

  const mtom = row.maxTakeoffG;
  if (mtom != null) {
    if (mtom < 250) return { weightClass: "c0", classSource: "mtom" };
    if (mtom < 900) return { weightClass: "c1", classSource: "mtom" };
    if (mtom <= 4000) return { weightClass: "c2", classSource: "mtom" };
    return { weightClass: "c2", classSource: "mtom" };
  }

  const w = row.weightG;
  if (w != null) {
    if (w < 250) return { weightClass: "c0", classSource: "weight" };
    if (w < 900) return { weightClass: "c1", classSource: "weight" };
    return { weightClass: "c2", classSource: "weight" };
  }

  return { weightClass: "c0", classSource: "default" };
}

export function normalizeCatalogRow(row: OpenDroneListRow): CatalogDrone | null {
  const manufacturer = String(row.manufacturer ?? "").trim();
  const name = String(row.name ?? "").trim();
  if (!manufacturer || !name) return null;

  const weightG = toNumber(row.weight);
  const maxTakeoffG = toNumber(row.max_takeoff);
  const uasClass =
    row.uas_class && String(row.uas_class).toLowerCase() !== "none"
      ? String(row.uas_class).trim()
      : null;

  const { weightClass, classSource } = classifyDroneModel({
    uasClass,
    weightG,
    maxTakeoffG,
  });

  const id = `${manufacturer}::${name}`.toLowerCase();
  return {
    id,
    manufacturer,
    name,
    label: `${manufacturer} ${name}`,
    uasClass,
    weightG,
    maxTakeoffG,
    enduranceMin: toNumber(row.endurance),
    hasCamera: row.has_camera ?? null,
    isToy: row.is_toy ?? null,
    weightClass,
    classSource,
  };
}
