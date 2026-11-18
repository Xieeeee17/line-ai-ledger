# LINE AI 記帳機器人

個人使用的 LINE Messaging API webhook，部署在 Cloudflare Workers。使用 Gemini API 的 `gemini-3.1-flash-lite` 模型解析自然語言消費描述，整理為待確認項目，確認後存入 Cloudflare D1。模型無法使用時會暫時切換到指令記帳，並定期探測模型是否恢復。

系統元件、訊息流程、路由、資料表與安全邊界請參閱 [Codegraph 文件](docs/codegraph.md)。

## 功能

- 驗證 LINE webhook 簽章，並只處理設定的 LINE 使用者 ID。
- 以 LINE webhook event ID 去重，避免重送事件重複處理。
- 以繁體中文描述支出；辨識結果需回覆「確認」才會寫入。
- LINE Quick Reply 按鈕可確認或取消新增、編輯、刪除；快速記帳可逐步輸入金額與品項、按鈕選類型及日期；刪除後 5 分鐘內可復原。
- 可用自然語言新增、查詢最近消費、本月記帳 Flex 列表、本月支出、日期區間明細、類別長條圖，以及編輯或刪除記帳。
- 編輯可在未提供新值時先選定紀錄，再回覆新金額；確認預覽後才會更新。
- 可設定本月預算；支出達到 80% 與 100% 時各提醒一次。指令例：「預算 15000」。
- 日期區間明細每頁 10 筆，可用「上一頁／下一頁」瀏覽；儀表板可依日期篩選並匯出 CSV。
- 提供私人網頁儀表板，查看本月各類別橫向長條圖與金額（不顯示 X 軸標題／刻度）、預算、分頁記帳紀錄（可刪除及復原），以及 Gemini API 用量。
- 儀表板統計模型無法理解的訊息，以及系統回覆「目前無法處理這則訊息」的狀況；顯示本月筆數與最近 20 筆，並可匯出本月全部訊息為 JSON／CSV。聊天室可輸入「功能選單」叫出 Quick Reply，也可在儀表板設定常駐 Rich Menu。
- 快速記帳會依序詢問金額、類型、品項與日期，最後按「確認記帳」或「取消」；也可直接輸入完整記帳格式。
- 日期以台北時區解讀；金額記錄為新台幣整數。

## 設定

需求：Node.js 22 或更新版本、npm、Cloudflare 帳號、LINE Developers Messaging API channel。

1. 安裝相依套件：

   ```sh
   npm install
   ```

2. 建立 D1 資料庫，複製設定範本，並將輸出的 database ID 填入本機 `wrangler.toml`：

   ```sh
   npx wrangler d1 create line-ai-ledger
   cp wrangler.toml.example wrangler.toml
   ```

   `wrangler.toml` 已加入 `.gitignore`，只保留在本機；請勿提交包含個人 D1 database ID 的設定檔。

3. 建立資料表（之後新增資料表時，可再次執行；不會刪除既有記帳資料）：

   ```sh
   npm run db:local
   npm run db:remote
   ```

4. 確認型別並先部署一次：

   ```sh
   npm run typecheck
   npm run deploy
   ```

5. 設定機密環境變數：

   ```sh
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put LINE_ALLOWED_USER_ID
   npx wrangler secret put DASHBOARD_PASSWORD
   ```

   在 [Google AI Studio](https://aistudio.google.com/api-keys) 建立 Gemini API key。`LINE_ALLOWED_USER_ID` 是允許記帳的 LINE 使用者 ID。不要將 API key、channel secret 或 access token 寫入原始碼或提交到版本控制。

   儀表板使用 HTTP Basic Auth，登入名稱固定為 `admin`，密碼使用 `DASHBOARD_PASSWORD` 設定。請選擇長且獨特的密碼。只有完成驗證後，Worker 才會回傳儀表板或資料 API。

   本機開發時，將以下內容放在專案根目錄的 `.dev.vars`（此檔已加入 `.gitignore`），並填入自己的值：

   ```text
   GEMINI_API_KEY=your-gemini-api-key
   LINE_CHANNEL_SECRET=your-line-channel-secret
   LINE_CHANNEL_ACCESS_TOKEN=your-line-channel-access-token
   LINE_ALLOWED_USER_ID=your-line-user-id
   DASHBOARD_PASSWORD=your-local-dashboard-password
   ```

Gemini API 免費方案有使用量與速率限制，並非不限量；方案和模型可用性可能變更。此 Worker 使用 `store: false` 不儲存 Gemini 對話，但 Google 免費方案條款仍可能允許將提交內容用於改善產品。記帳訊息會傳送至 Google Gemini API，請依個人隱私需求決定使用方式。詳情請參閱 [Gemini API 定價與方案](https://ai.google.dev/gemini-api/docs/pricing)。本次功能沒有新增付費 API、圖表服務或付費依賴；Cloudflare、LINE、Gemini 各自的免費額度仍受其服務條款限制，請勿啟用會產生費用的方案或超額服務。

## 使用例子

- 記帳：`午餐 120` → 按「確認記帳」或「取消」。
- 本月列表：`列出本月記帳` → LINE 以圖卡顯示每頁 5 筆、各筆金額及本月合計，可按上一頁／下一頁。
- 設定預算：`本月預算 15000`；查詢：`本月預算`。達到預算 80% 與 100% 時會分別提醒一次。
- 日期查詢：`查詢 2026-10-01 至 2026-10-31` → 使用「上一頁／下一頁」瀏覽。
- 編輯：`把昨天午餐改成 150 元` → 檢視變更後按「確認修改」或「取消」。也可先說 `編輯上一筆記帳`，再依提示回覆 `改成 150 元`。
- 刪除：`刪除昨天的午餐` → 確認前不會刪除；刪除後可按「復原刪除」在 5 分鐘內還原。
- 圖表：`本月各類花多少？` → 回覆各類別金額的橫向長條圖；圖表在 Worker 內以 LINE Flex Message 組成，不呼叫外部圖表服務。
- 模型故障時：輸入 `指令記帳 120 餐飲 午餐`；模型恢復後，機器人於探測成功時通知並自動回到模型優先模式。
- 功能選單：輸入 `功能選單`，或點聊天室常駐選單。選「快速記帳」後依序輸入金額、按類型按鈕、輸入品項，再使用日期選擇器或按「今天」。LINE 不提供自訂文字輸入框，金額與品項需在聊天室輸入。
- 指令格式：輸入 `指令格式`；完整格式為 `指令記帳 金額 類型 品項 [YYYY-MM-DD]`，例如 `指令記帳 45 交通 公車 2026-11-16`。送出後仍須按確認才會記帳。

若日期區間明細超過一頁，直接按回覆中的分頁按鈕。儀表板的 CSV 會依所選日期區間匯出全部符合紀錄，而非只匯出目前頁面。

6. 在 LINE Developers Console 將 webhook URL 設為 `https://<worker 網域>/webhook`，啟用 webhook，並使用「Verify」確認連線。

部署完成後，前往 `https://<worker 網域>/dashboard`，以 `admin` 和 `DASHBOARD_PASSWORD` 登入。用量只統計部署此功能後成功回應的 Gemini 請求；不包含歷史呼叫，也不是 Google 帳戶剩餘免費額度。記帳及用量查詢目前只限 `LINE_ALLOWED_USER_ID` 對應的單一使用者；多人各自登入與綁定 LINE ID 尚未實作。

無法理解或處理訊息的原文與時間存放於 Cloudflare D1 的 `unanswered_questions` 表；不保存模型回覆或其他聊天內容。儀表板列出本月總數及最新 20 筆，JSON／CSV 可匯出本月全部資料；新增問題時會清除前月份資料。快速記帳輸入狀態存放於 `quick_expense_sessions`，15 分鐘後失效。LINE 聊天室不支援自訂文字輸入框，金額與品項需由使用者在聊天室輸入；日期可使用 LINE Quick Reply 日期選擇器。Rich Menu 可在儀表板「LINE 聊天室功能選單」區按「設定常駐功能選單」建立並連結至 `LINE_ALLOWED_USER_ID`；此步驟使用既有 LINE Messaging API 憑證，不會建立新的付費服務。

本機開發可使用 `npm run db:local` 初始化本機 D1，再以 `npm run dev` 啟動 Worker。Gemini API key 和儀表板密碼透過 Cloudflare Worker secret 或本機 `.dev.vars` 提供。Windows PowerShell 若無法執行 `npm`/`npx`，請使用 `npm.cmd`/`npx.cmd`。

執行本機測試與型別檢查：

```sh
npm test
npm run typecheck
```

測試使用 Node.js 22 的內建測試執行器及記憶體假資料，不會呼叫真實 Gemini API、LINE 或遠端 D1。部署新版前，需先在目標 D1 套用 `schema.sql`；本機測試不會操作遠端資料庫或部署 Worker。

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
