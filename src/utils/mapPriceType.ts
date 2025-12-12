export const mapPriceType = function (s: "mark" | "last" | "index"): number {
  switch (s) {
    case "last":
      return 0;
    case "mark":
      return 1;
    case "index":
      return 2;
    default:
      return 0;
  }
};
