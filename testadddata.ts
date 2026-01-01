import { postgresDb } from "./src/db/client"
import { trades } from "./src/db/schema"

async function ok () {
  const adddata = {
    "user_id": 1,
    "exchange_id": 19,
    "trade_id": "3180733510519529472",
    "open_order_id": "3180733510519529472",
    "order_id": "3180733510519529472",
    "contract": "DOGE-USDT-SWAP",
    "position_type": "long",
    "market_type": "limit",
    "size": 0.01,
    "leverage": "6",
    "autotrader_id": 5,
    "leverage_type": "isolated",
    "status": "waiting_position",
    "price": 0.1124,
    "reduce_only": false,
    "is_tpsl": false,
    "take_profit_enabled": true,
    "take_profit_executed": true,
    "take_profit_price": 0.1233,
    "take_profit_price_type": "mark",
    "stop_loss_enabled": true,
    "stop_loss_executed": true,
    "stop_loss_price": 0.108,
    "stop_loss_price_type": "mark",
    "metadata": {
      "code": "0",
      "data": [
        {
          "clOrdId": "",
          "ordId": "3180733510519529472",
          "sCode": "0",
          "sMsg": "Order placed",
          "tag": "",
          "ts": "1767295645509"
        }
      ],
      "inTime": "1767295645508808",
      "msg": "",
      "outTime": "1767295645510344"
    }
  }

  await postgresDb.insert(trades).values(adddata)
}


ok().catch(console.log)
