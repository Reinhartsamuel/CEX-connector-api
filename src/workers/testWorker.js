import { eq } from "drizzle-orm";
import { postgresDb } from "../db/client";
import { trades } from "../db/schema";
async function main() {
    const item = {
        "stop_loss_price": "",
        "create_time": 1764619970,
        "iceberg": 0,
        "is_close": false,
        "status": "finished",
        "tkfr": 0.0005,
        "refu": 0,
        "size": 1,
        "role": "maker",
        "fill_price": 0.1344,
        "biz_info": "dual",
        "mkfr": 0.0002,
        "tif": "gtc",
        "amend_text": "-",
        "finish_as": "filled",
        "left": 0,
        "finish_time_ms": 1764619977920,
        "stop_profit_price": "",
        "update_id": 2,
        "stp_act": "-",
        "text": "api",
        "fee": 0.0002688,
        "bbo": "-",
        "price": 0.1344,
        "stp_id": "0",
        "id": "56013524547126799",
        "user": "16778193",
        "update_time": 1764619977920,
        "point_fee": 0,
        "create_time_ms": 1764619970009,
        "id_string": "56013524547126799",
        "is_liq": false,
        "is_reduce_only": false,
        "refr": 0,
        "finish_time": 1764619977,
        "contract": "DOGE_USDT"
    };
    const [tradeData] = await postgresDb
        .select({
        take_profit_enabled: trades.take_profit_enabled,
        take_profit_executed: trades.take_profit_executed,
        take_profit_price: trades.take_profit_price,
        take_profit_price_type: trades.take_profit_price_type,
        stop_loss_enabled: trades.stop_loss_enabled,
        stop_loss_executed: trades.stop_loss_executed,
        stop_loss_price: trades.stop_loss_price,
        stop_loss_price_type: trades.stop_loss_price_type,
    })
        .from(trades)
        .where(eq(trades.trade_id, item.id ?? item.id_string));
    return console.log(tradeData, 'tradeData');
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
