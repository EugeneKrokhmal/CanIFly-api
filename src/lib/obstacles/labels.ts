export type ObstacleType =
  | "construction"
  | "crane"
  | "electric_line"
  | "air_sports"
  | "other";

export {
  OBSTACLE_TYPE_LABELS,
  obstacleLabel,
  parseLocale,
} from "@canifly/middleware";
