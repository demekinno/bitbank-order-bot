const LINE_NOTIFY_ENDPOINT = "https://notify-api.line.me/api/notify";
const LINE_NOTIFY_API_TOKEN = "PUT_YOUR_API_TOKEN";
const BITBANK_API_KEY = "PUT_YOUR_BITBANK_API_KEY";
const BITBANK_API_SECRET = "PUT_YOUR_BITBANK_API_SECRET";
const BITBANK_API_PUBLIC_ENDPOINT  = "https://public.bitbank.cc";
const BITBANK_API_PRIVATE_ENDPOINT = "https://api.bitbank.cc";
const CHECK_LOOP_SECONDS = 60;

const DISCOUNT = 0.0001;
const ORDER_AMOUNT = {
  "btc_jpy": 0.0001,
};

const ORDER_MONEY = {
  "boba_jpy": 100,
  "link_jpy": 300,
  "bat_jpy": 100,
  "eth_jpy": 250,
  "bcc_jpy": 150,
  "ltc_jpy": 100,
  "xrp_jpy": 30,
  "avax_jpy": 550,
  "astr_jpy": 100,
};

function buyPrice(pair, point){
  return (parseFloat(getBuyPrice(pair)) * (1 - DISCOUNT)).toFixed(point);
}

function buyAmount(price, unit){
  return (unit / price).toFixed(4)
}

const RECURRING_KEY = "recurring";
const ARGUMENTS_KEY = "arguments";

function setupTriggerArguments(trigger, functionArguments, recurring) {
  var triggerUid = trigger.getUniqueId();
  var triggerData = {};
  triggerData[RECURRING_KEY] = recurring;
  triggerData[ARGUMENTS_KEY] = functionArguments;

  PropertiesService.getScriptProperties().setProperty(triggerUid, JSON.stringify(triggerData));
}

function handleTriggered(triggerUid) {
  var scriptProperties = PropertiesService.getScriptProperties();
  var triggerData = JSON.parse(scriptProperties.getProperty(triggerUid));

  if (!triggerData[RECURRING_KEY]) {
    deleteTriggerByUid(triggerUid);
  }

  return triggerData[ARGUMENTS_KEY];
}

function deleteTriggerArguments(triggerUid) {
  PropertiesService.getScriptProperties().deleteProperty(triggerUid);
}

function deleteTriggerByUid(triggerUid) {
  if (!ScriptApp.getProjectTriggers().some(function (trigger) {
    if (trigger.getUniqueId() === triggerUid) {
      ScriptApp.deleteTrigger(trigger);
      return true;
    }

    return false;
  })) {
    console.error("Could not find trigger with id '%s'", triggerUid);
  }

  deleteTriggerArguments(triggerUid);
}


function deleteTrigger(trigger) {
  ScriptApp.deleteTrigger(trigger);
  deleteTriggerArguments(trigger.getUniqueId());
}

function setCheckOrderTrigger(pair, order_id) {
  let trigger = ScriptApp.newTrigger("checkOrderLoopForTrigger").timeBased().after(CHECK_LOOP_SECONDS * 1000).create();
  setupTriggerArguments(trigger, [pair, order_id], false);
}

function setTrigger(functionName) {
  // 他のトリガーを削除する
  deleteTrigger(functionName);

  // 現在の日付を取得
  const next = new Date();

  // 一分後の日付に変換
  next.setMinutes(next.getMinutes() + 5);
  next.setSeconds(0);
    
  // mainという関数を実行するトリガーを作成
  ScriptApp.newTrigger(functionName).timeBased().at(next).create();
}

function deleteTrigger(functionName) {
  // 設定済みのトリガーをすべて取得する
  const triggers = ScriptApp.getProjectTriggers();

  // 取得したトリガーをforeatchで順番に処理する
  triggers.forEach(function(trigger) {
    if(trigger.getHandlerFunction() == functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function order(pair, amount, price) {
  var path = "/v1/user/spot/order",
  body = {
    pair: pair,
    price: price,
    amount: amount,   //小数点第4位
    side: "buy",
    type: "limit",
    post_only: true
  },
  result = fetchJSON(BITBANK_API_PRIVATE_ENDPOINT + path, "POST", false, body, path);
  console.log(result);

  let ret = true;
  let strBody = "";
  if (result["success"] == 0) {
    strBody = strBody + ("\n注文に失敗しました。");
    ret = false;
  }
  strBody = strBody + "\nペア: " + body.pair + " (" + body.price + "円)";
  strBody = strBody + "\n数量: " + body.amount;
  strBody = strBody + "\n価格: " + body.price * body.amount;
  lineNotify(strBody);

  return result;
}


function checkOrder(pair, order_id) {
  const path = "/v1/user/spot/orders_info";
  const body = {
    pair: pair,
    order_ids: [order_id],
  };
  console.log("pair: " + pair + " order_id: " + order_id)
  const result = fetchJSON(BITBANK_API_PRIVATE_ENDPOINT + path, "POST", false, body, path);

  if (result["success"] == 0){
    lineNotify("\nペア: " + pair + " ID: " + order_id + " の注文取得に失敗しました。APIサーバのダウンかAPIキー失効の可能性があります。");
    return true;  // 注文取得に失敗したが再実行しない
  } else {
    if (result["success"] != 1 || result["data"]["orders"].length == 0) {
      lineNotify("\nペア: " + pair + " ID: " + order_id + " の注文が取得できません。注文に失敗している可能性があります");
      return true;  // 注文取得に失敗したが再実行しない
    }
    if (result["data"]["orders"][0]["status"] == "FULLY_FILLED"){
      lineNotify("\nペア: " + pair + "が" + result["data"]["orders"][0]["executed_amount"] + "枚約定しました。");
      checkHoldingAssets();
      return true;  // 約定注文取得に成功したため再実行しない
    } else if(result["data"]["orders"][0]["status"] == "CANCELED_UNFILLED") {
      lineNotify("\nペア: " + pair + " ID: " + order_id + " の注文に失敗したため再注文します。");
      const ret = order(pair, result["data"]["orders"][0]["remaining_amount"], result["data"]["orders"][0]["price"] * (1 - DISCOUNT))
      if (ret["success"] == 0) {
        lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
        return false;
      } else {
        setCheckOrderTrigger(pair, ret["data"]["order_id"]);
      }
      return true
    }
  }
  return false;  // 再実行する
}

function checkOrderLoopForTrigger(event){
  const functionArguments = handleTriggered(event.triggerUid);
  pair = functionArguments[0];
  order_id = functionArguments[1];
  ret = checkOrder(pair, order_id);
  if (ret == false) {
    setCheckOrderTrigger(pair, order_id);
    return false
  }

  return true
}

function createProfitString(amount, profit) {
  let str = amount + "円 (";
  if (Math.sign(profit) == 1) {
    str = str + "+" + profit + ")";
  } else {
    str = str + profit + ")";
  }
  return str;
}

function checkHoldingAssets() {
  let body = sheet.getRange(2, 1, 10, 6).getValues().filter(value => value[1] === "暗号資産").map(function(items) {
    items[3] = Math.round(items[3]*1000)/1000;
    items[4] = Math.round(items[4]*1000)/1000;
    items[5] = Math.round(items[5]*1000)/1000;
    return items;
  });
  let total_invest = body.reduce((sum, element) => sum + element[3], 0);
  let total_profit = body.reduce((sum, element) => sum + element[5], 0);
  let total_str = createProfitString(total_invest, total_profit);

  body = body.map(function(items) {
    str = " " + items[0] + " " + createProfitString(items[4], items[5])
    return str
  });
  let msg = "\n資産: "+ total_str + "\n" + "内訳:\n    " + body.join("\n    ")
  console.log(msg)
  lineNotify(msg);
}

function buyBtc(){
  const pair = "btc_jpy";
  const btc_jpy_price = buyPrice(pair, 0);
  ret = order(pair, ORDER_AMOUNT[pair], btc_jpy_price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyBoba(){
  const pair = "boba_jpy";
  const boba_jpy_buy_price = buyPrice(pair, 3);
  const boba_jpy_amount = buyAmount(boba_jpy_buy_price, ORDER_MONEY[pair]);
  ret = order(pair, boba_jpy_amount, boba_jpy_buy_price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyEth(){
  const pair = "eth_jpy";
  const eth_jpy_price = buyPrice(pair, 0);
  const eth_jpy_amount = buyAmount(eth_jpy_price, ORDER_MONEY[pair]);
  ret = order(pair, eth_jpy_amount, eth_jpy_price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyBcc(){
  const pair = "bcc_jpy";
  const price = buyPrice(pair, 0);
  const amount = buyAmount(price, ORDER_MONEY[pair]);
  console.log(amount)
  ret = order(pair, amount, price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyBat(){
  const pair = "bat_jpy";
  const price = buyPrice(pair, 3);
  const amount = buyAmount(price, ORDER_MONEY[pair]);
  ret = order(pair, amount, price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyLink(){
  const pair = "link_jpy";
  const price = buyPrice(pair, 3);
  const amount = buyAmount(price, ORDER_MONEY[pair]);
  ret = order(pair, amount, price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyLtc(){
  const pair = "ltc_jpy";
  const price = buyPrice(pair, 1);
  const amount = buyAmount(price, ORDER_MONEY[pair]);
  ret = order(pair, amount, price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}


function buyXrp(){
  const pair = "xrp_jpy";
  const price = buyPrice(pair, 3);
  const amount = buyAmount(price, ORDER_MONEY[pair]);
  ret = order(pair, amount, price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyMatic(){
  const pair = "matic_jpy";
  const price = buyPrice(pair, 3);
  const amount = buyAmount(price, ORDER_MONEY[pair]);
  ret = order(pair, amount, price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyAvax(){
  const pair = "avax_jpy";
  const price = buyPrice(pair, 3);
  const amount = buyAmount(price, ORDER_MONEY[pair]);
  ret = order(pair, amount, price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function buyAstr(){
  const pair = "astr_jpy";
  const price = buyPrice(pair, 3);
  const amount = buyAmount(price, ORDER_MONEY[pair]);
  ret = order(pair, amount, price);
  if (ret["success"] == 0) {
    lineNotify("\nペア: " + pair + " の注文に失敗しました。手動で再実行してください。");
    return false;
  } else {
    setCheckOrderTrigger(pair, ret["data"]["order_id"]);
  }
  return true;
}

function get_balance(){
    var path = "/v1/user/assets";
    var nowBalance = fetchJSON(BITBANK_API_PRIVATE_ENDPOINT + path, "GET", false, path).data;
    console.log(nowBalance.assets[0].free_amount);
    return nowBalance.assets[0].free_amount;
}

function order(pair, amount, price) {
  var path = "/v1/user/spot/order",
  body = {
    pair: pair,
    price: price,
    amount: amount,   //小数点第4位
    side: "buy",
    type: "limit",
    post_only: true
  },
  result = fetchJSON(BITBANK_API_PRIVATE_ENDPOINT + path, "POST", false, body, path);
  console.log(result);

  let ret = true;
  let strBody = ""
  if (result["success"] == 0) {
    strBody = strBody + ("\n注文に失敗しました。");
    ret = false
  }
  strBody = strBody + "\nペア: " + body.pair + " (" + body.price + "円)" 
  strBody = strBody + "\n数量: " + body.amount;
  strBody = strBody + "\n価格: " + body.price * body.amount;
  lineNotify(strBody);

  return result
}

function getBuyPrice(pair) {
  var path = "/" + pair + "/ticker"
  var url = BITBANK_API_PUBLIC_ENDPOINT + path
  var method = "GET"
  console.log(url)
  var nowPrice = fetchJSON(url , method, true).data;
  console.log(pair+"現在価格: "+ nowPrice.last);
  return nowPrice.last;
}

function lineNotify(msg){
  const options =
   {
     "method"  : "post",
     "payload" : "message=" + msg,
     "headers" : {"Authorization" : "Bearer "+ LINE_NOTIFY_API_TOKEN}
   };
   UrlFetchApp.fetch(LINE_NOTIFY_ENDPOINT, options);
}

function fetchJSON(url, method, isPublic, _body, path) {
  var nonce = Date.now().toString(),
      body = JSON.stringify(_body);
  if(isPublic == true) {
    var option = {
        method: method,
        contentType: "application/json"
    }
  } else {
    if(method == "POST"){
      var option = {
        method: method,
        payload: body,
        headers: {
          "ACCESS-KEY": BITBANK_API_KEY,
          "ACCESS-NONCE": nonce,
          "ACCESS-SIGNATURE": createSignature(nonce, path, body),
          "contentType": "application/json"
        }
      }
    } else {
      var option = {
        method: method,
        headers: {
          "ACCESS-KEY": BITBANK_API_KEY,
          "ACCESS-NONCE": nonce,
          "ACCESS-SIGNATURE": createSignature(nonce, path),
          "contentType": "application/json"
        }
      }
    }
  };
  return JSON.parse(UrlFetchApp.fetch(url, option));
}

function createSignature(nonce, path, body) {
  function tohex(signature) {
    return signature.reduce(function (str, chr) {
      chr = (chr < 0 ? chr + 256 : chr).toString(16);
      return str + (chr.length === 1 ? "0" : "") + chr;
    }, "");
  }
  var text = (typeof body === "undefined") ?
      nonce + "/v1/user/assets" : nonce + body;
  var signature = Utilities.computeHmacSha256Signature(text, BITBANK_API_SECRET);
  return tohex(signature);
}

