export const getTriggerRule = function (positionType, isTakeProfit) {
    // 1 => trigger when price >= trigger_price
    // 2 => trigger when price <= trigger_price
    if (isTakeProfit) {
        if (positionType == "long") {
            return 1; // long TP: price rises to or above target
        }
        return 2; // short TP: price falls to or below target
    }
    // stop loss
    if (positionType == "long") {
        return 2; // long SL: price falls to or below target
    }
    return 1; // short SL: price rises to or above target
};
