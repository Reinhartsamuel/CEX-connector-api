export const getOrderType = function (positionType: string): string {
  // if (positionType == "long") {
  //   return "close-long-order";
  // }
  // // short
  // return "close-short-order";
  if (positionType == "long") {
    return "close-long-position";
  }
  // short
  return "close-short-position";
};
