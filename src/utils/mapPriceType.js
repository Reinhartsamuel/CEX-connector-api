export const mapPriceType = function (s) {
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
